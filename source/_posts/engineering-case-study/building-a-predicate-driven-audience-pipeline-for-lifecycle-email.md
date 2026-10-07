---
title: Building a Predicate-Driven Audience Pipeline for Lifecycle Email
date: 2026-02-14 12:00:00
categories:
  - Engineering Case Study
tags:
  - go
  - flink
  - kafka
  - ticdc
  - data-platform
  - lifecycle-marketing
  - audience-segmentation
---

The platform already had transactional services and a TiDB/CDC/Flink data path. Marketing operations still needed another layer: a reusable way to define audiences, materialize them from behavioral and asset data, and trigger lifecycle email tasks without copying business filters into every campaign.

This is the retrospective of the audience pipeline I built for that problem. The scope in this article is deliberately narrower than "marketing automation": it covers data sources, warehouse layering, predicate compilation, segment lifecycle, and email reach. It does not claim a completed multi-channel marketing platform.

{% asset_img architecture.png Predicate-driven audience pipeline architecture %}

## Context

The service ran on the Go microservice platform described in the previous articles. Product and operations needed lifecycle campaigns for registration, activity, deposit behavior, VIP progression, and expiring rewards. The underlying platform already had TiDB, TiCDC, Kafka, Flink, and query-serving infrastructure.

The new work was to make audience definitions a first-class backend model rather than ad-hoc SQL owned by individual reports or campaigns.

## Problem

The core problem was not sending email. It was deciding who should receive a lifecycle message in a repeatable and reviewable way.

Audience logic spanned several shapes:

- latest user traits, such as activity, deposit totals, and VIP level;
- historical events, such as registration or level-up;
- time-sensitive asset state, such as bonus or free-spin expiry;
- business-level predicates built from combinations of those fields.

Without a shared model, each feature would need its own table scan, filter expression, and campaign-specific interpretation of "active user" or "expiring reward."

## Constraints

- The pipeline reused the existing TiDB / TiCDC / Kafka / Flink platform rather than introducing another warehouse.
- The pipeline ran in production alongside existing feature delivery.
- Email was the reach channel implemented end-to-end in this code path; SMS, push, and inbox message were modeled but not completed as send paths.
- The reward encapsulation RPC was still a boundary; lifecycle tasks could define incentives, but this article does not claim a completed reward issuance loop.

## Requirements

- Define audiences through business predicates rather than hand-written campaign SQL.
- Separate UI/business predicates from physical table routing.
- Materialize user traits, events, and asset state into queryable warehouse layers.
- Reuse identical segment definitions instead of creating duplicate audience tables.
- Refresh segments and emit only added/removed members.
- Support lifecycle plans and day-based tasks.
- Send and record lifecycle email messages.

## Data Sources

### Track events

The Track service accepted user events over gRPC and asynchronously produced them to Kafka:

```text
user_behavior_event
```

Events carried event metadata, user context, and event body. Flink jobs consumed this topic for online status, behavioral statistics, and user feature aggregation.

### TiCDC domain changes

TiCDC routed database changes into Kafka topics, including:

```text
game_bet_settle
sport_order_amount
proxy_commission
vip_user_score_record
vip_bonus_record
user_transfer
bonus_amount_tx
domain_event_*
```

Most user-level topics were partitioned by `user_id`; `proxy_commission` used `invited_user_id`; `domain_event_*` used `event_type` and `aggregate_id`.

## Data Layering

### DWD

The DWD layer normalized selected facts into detail tables.

One implemented Flink SQL path consumed `user_transfer` and `bonus_amount_tx`, joined user, game, and activity dimensions, normalized in/out amounts and sources, and wrote `dwd_activity_bonus_tx_di` with `(ref_id, type)` as the sink key.

The first audience design considered three fixed storage shapes: latest traits, event history, and asset status. The implemented pipeline did not force every audience fact into those three tables. Instead, Flink jobs cleaned events into the appropriate DWD tables and summarized reusable state into DWS/ADS tables. Predicate metadata then selected the physical table that matched each condition's shape.

### DWS / ADS

Flink SQL jobs maintained aggregates such as:

```text
dws_activity_bonus_tx_user_type_source_symbol_rt
ads_user_game_bet_stat_hourly
ads_user_sport_bet_stat_hourly
ads_user_activity_stat_hourly
ads_user_transfer_source_symbol_hourly
ads_vip_user_bet_stat_hourly
ads_vip_bonus_stat_hourly
```

The segmentation model could route latest-state predicates to a keyed trait table such as `dws_user_latest_traits`:

```text
uid
trait_key
trait_val_str
trait_val_num
```

For conditions that already had a stable latest-state representation, this avoided recomputing user history from raw events. Event conditions and asset conditions could route to other DWD tables instead.

### Serving

QueryHub continued to serve report-style queries. The audience engine had a different access pattern: it compiled predicates into SQL that could read from the TiDB/TiFlash serving path and return matching user IDs.

## Audience Model

Predicate configuration was stored through ConfigHub and split into two layers. This was the mechanism that made the warehouse-layered implementation work: business predicates did not have to target one canonical audience table.

### Composite predicates

Composite predicates were the only business-facing layer. They carried labels, categories, parameter definitions, operators, UI hints, and expansion templates.

Examples included:

- consecutive active days;
- inactive days;
- deposit stage;
- total deposit amount;
- deposit frequency;
- current VIP level;
- level-up reached;
- asset validity.

The frontend or RPC caller sent an AST. The backend expanded composite predicates into atomic predicates, validated that no composite remained, and compiled the result into SQL.

### Atomic predicates

Atomic predicates described physical routing only: the physical table, alias, key column, value column, value type, and optional fixed key. For example, a deposit-stage predicate could route to `dws_user_latest_traits` with `trait_key` as the key column and a parameterized fixed key such as:

```text
activity_deposit_asset_idx_{{stage}}
```

Another predicate could route to an event-history table and compare `occurred_at`, while an asset predicate could route to a DWD table carrying `asset_type`, `asset_sub_type`, and `expire_at`. The compiler treated each atomic predicate as a route to the table best suited to that condition.

## Predicate Compiler

The compiler had three stages:

{% mermaid %}
flowchart LR
  A[Business AST] --> B[Expand composite predicates]
  B --> C[Validate atomic-only AST]
  C --> D[Route atomic predicates to physical tables]
  D --> E[Compile SQL branches]
  E --> F[TiDB / TiFlash query]
{% endmermaid %}

For an `AND` root, each child became a branch. Branch results were combined with `UNION ALL`, grouped by `uid`, and filtered with:

```sql
HAVING COUNT(DISTINCT logic_branch_id) = ?
```

This expressed conjunctive semantics without requiring every predicate to live in one flattened `WHERE` clause. The generated SQL included a TiFlash storage hint:

```sql
/*+ READ_FROM_STORAGE(TIFLASH[table]) */
```

Time predicates supported interval operations such as `BEFORE_INTERVAL`, `WITHIN_INTERVAL`, and `AFTER_INTERVAL`. The compiler accepted a current-time option so relative conditions were evaluated consistently at refresh time.

## Segment Lifecycle

Each segment definition stored the original AST, a SHA-256 AST hash, reference count, status, and last run time.

When a lifecycle task referenced a predicate, the service found an existing segment by AST hash or created a new one. A unique index on `ast_hash` handled concurrent creation; duplicate-key handling reread the canonical segment.

Segment members were stored in `segment_member` with `(segment_id, uid)`. Refresh executed the compiled query, compared new and old members, and classified users as added or removed. Large diffs were split into events with at most 5,000 UIDs per message. Member replacement was batched.

## Lifecycle Email Reach

Lifecycle plans contained day-based tasks. A task referenced a segment, a day number, an email template, and optional incentive configuration.

Email templates were stored with subject, body, status, type, version, and audit fields. The Reach service accepted batch messages on:

```text
domain_event_reach
```

For each user, it created a reach record, rendered the template, invoked the configured email channel, and updated the record with status, error code, error message, provider, sent time, and retry count.

The email abstraction supported provider implementations for log, SMTP, SendCloud, Mailgun, and SendGrid. This article only claims Email as the implemented reach path. It does not describe fallback between providers because that was not implemented.

{% mermaid %}
sequenceDiagram
  participant L as Lifecycle trigger
  participant K as domain_event_reach
  participant R as Reach consumer
  participant T as Template engine
  participant C as Email channel
  participant D as reach_record
  L->>K: Publish batch message
  K->>R: Consume batch
  R->>D: Create pending records
  R->>T: Render template per user
  R->>C: Send email
  C-->>R: Provider result
  R->>D: Update success / failure
{% endmermaid %}

## User Behavior Feature Job

A separate DataStream job, `UserBehaviorAnalysisJob`, showed how the layered build worked in practice: it turned platform events into DWD rows and DWS feature increments instead of writing everything into one audience table. It consumed the track topic and TiCDC topics:

```text
user_behavior_event
domain_event_deposit
domain_event_user
game_bet_settle
sport_order_amount
```

The job normalized those inputs into one `UnifiedEvent` model. Track events produced browse, deposit-click, register-click, spin, and broke events. CDC events produced deposits, registrations, game bets, and sports bets. The merged stream used event-time watermarks and idle-source handling.

An async enrichment function attached acquisition dimensions. It resolved a user to a promoter channel or proxy inviter, using the registration payload first when available and a keyed lookup afterward. A Caffeine cache retained up to 50,000 user dimensions for 30 minutes to avoid repeating the same lookup.

The enriched stream had two outputs. Side outputs wrote DWD rows for deposits, broke events, and registrations:

```text
dwd_user_deposit_di
dwd_user_broke_di
dwd_user_register_di
```

The main stream was keyed by user and source. A process function maintained state for registration-to-action and broke-to-deposit windows. It emitted hourly feature increments such as:

```text
register_click_cnt
is_register_success
is_reg_then_spin_24h
is_reg_then_deposit_24h
broke_cnt
is_broke_then_deposit_24h
deposit_cnt
deposit_amount_usd
currency_deposit_amount
symbol_deposit_amount
```

Those increments were upserted into hourly DWS tables, including `dws_user_register_dh`, `dws_user_broke_dh`, and `dws_user_deposit_dh`.

{% mermaid %}
flowchart LR
    T["user_behavior_event"] --> U["UnifiedEvent"]
    C["domain_event_deposit / domain_event_user"] --> U
    G["game_bet_settle / sport_order_amount"] --> U
    U --> E["Async acquisition enrichment"]
    E --> S{"Split enriched stream"}
    S -->|side outputs| DWD["dwd_user_deposit_di<br/>dwd_user_broke_di<br/>dwd_user_register_di"]
    S -->|main stream| P["Keyed feature state"]
    P --> DWS["dws_user_register_dh<br/>dws_user_deposit_dh<br/>dws_user_broke_dh"]
{% endmermaid %}

## Results

The pipeline established a reusable audience path from source events to warehouse tables, predicate compilation, segment definitions, and email reach records. It replaced the need for every lifecycle campaign to own its own targeting SQL.

The audience layer also made a useful separation explicit: operations reasoned about business predicates, while the backend routed those predicates to physical warehouse tables.

Because routing was part of atomic-predicate metadata, the query engine could adapt to multiple warehouse tables. A latest-trait predicate, event predicate, and asset predicate could participate in the same AST without forcing all source data into one physical audience table.

## Trade-offs

What it made better:

- audience definitions became reviewable configuration;
- identical ASTs could reuse the same segment definition;
- physical tables could evolve behind atomic predicates;
- lifecycle tasks could reference stable segment IDs;
- email delivery results had per-user records.

What it made worse:

- predicate configuration became part of the runtime contract;
- segment refresh needed careful batching and state management;
- email-only support simplified the first version but limited campaign shapes;
- behavior feature computation introduced keyed state and JDBC write pressure.

## What I Learned

Audience systems fail at the boundary between business language and physical data. Business users need predicates such as "active," "VIP," or "expiring reward." The backend still needs an unambiguous mapping to tables, columns, types, and timestamps.

AST hashes made reuse safer than name-based reuse. The same logical audience could be referenced by multiple lifecycle tasks without copying member lists.

Email reach was easy to start and hard to generalize. The first version needed a real provider path and per-user records, but multi-channel behavior would have added policy questions that this pipeline was not ready to answer.

## What I Would Change Today

I would make the routed warehouse contract explicit before adding more predicates: each atomic route needs a named producer, table owner, refresh semantics, primary-key meaning, and freshness target.

I would also make segment-to-lifecycle event wiring easier to verify. The mechanism existed, but a production-grade version needs clear consumer registration, lag metrics, replay behavior, and an idempotency key that survives retries.

For email, I would keep the channel abstraction but define retry, provider failure classification, and fallback policy before claiming multi-channel support. A record that says "failed" is useful only if the next action is unambiguous.

For the user-behavior job, I would make the JDBC sink contract stronger: pool connections, version the feature-table schema, avoid table and column names assembled at runtime, and route failed writes to a retry or dead-letter path. I would also make checkpoint behavior and state TTL explicit so recovery semantics were obvious during deployment changes.

---

*Previous in this series: [Building a Real-Time Data Platform with TiDB CDC and Flink](/posts/engineering-case-study/building-a-real-time-data-platform-with-tidb-cdc-and-flink/).*
