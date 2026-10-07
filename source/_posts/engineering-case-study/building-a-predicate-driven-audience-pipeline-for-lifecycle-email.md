---
title: Designing a Predicate-Driven Audience Pipeline for Lifecycle Email
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

Two lifecycle campaigns could both ask for "active users" and match different people. The platform already had transactional services and a TiDB/TiCDC/Kafka/Flink data path, but marketing still needed a reusable way to define audiences, materialize them from behavioral and asset data, and trigger email tasks without copying business filters into every campaign.

My contribution was the design document and the early core demo for predicate expansion, SQL compilation, segment refresh, and the reach handoff. A colleague then implemented the production services with my guidance. This article therefore separates the design decisions from the implementation boundaries that needed review before the path could be trusted.

{% asset_img architecture.png Predicate-driven audience pipeline architecture %}

## Context and Ownership

The work ran on the Go microservice platform described earlier in this series. Product and operations needed lifecycle campaigns for registration, activity, transaction behavior, membership progression, and expiring rewards. The data platform already provided TiDB, TiCDC, Kafka, Flink, and layered analytical tables.

The design treated each predicate as a **reusable backend contract**, not a display label attached to isolated campaign SQL. Marketing owned predicates, compilation, segments, lifecycle plans, and reach events. Reach owned message delivery, channel policy, frequency control, fallback, receipts, and message persistence. This article follows the email path; it does not claim that every channel problem was solved inside the audience compiler.

## The Real Problem

The difficult part was not sending email. It was deciding, **repeatably and reviewably**, who should receive a lifecycle message.

Audience conditions came from different data shapes:

- latest user traits, such as activity, transaction totals, and membership level;
- historical events, such as registration or level-up;
- time-sensitive asset state, such as reward or entitlement expiry;
- combinations of those conditions.

Without a shared model, each campaign could interpret "active user" or "expiring reward" differently. It could also introduce its own scan, filter expression, and audience table. That made definitions difficult to review and impossible to reuse consistently.

## Constraints and Requirements

The pipeline had to reuse the existing TiDB, TiCDC, Kafka, and Flink platform rather than introduce another warehouse. It also had to keep changing while feature delivery continued.

The design had to meet six requirements:

- define audiences with business predicates instead of campaign-specific SQL;
- keep UI predicates separate from physical table routing;
- let latest traits, events, assets, and aggregates retain their own storage semantics;
- reuse an identical audience definition instead of creating another member table;
- bound segment replacement and event size during refresh;
- send lifecycle email and retain a per-user delivery record.

## Options Considered

The simplest option was to let each campaign own its SQL. That preserved short-term flexibility, but it duplicated the meaning of common predicates and left no canonical place to review audience logic.

A canonical audience table was the second option. Every source event could be transformed into a common user-attribute row. Querying would become uniform, but event history, latest traits, and expiring assets would be forced into **one update and freshness model**. A row representing "user registered" has different semantics and retention needs from a row representing "reward expires at this timestamp."

We also considered three fixed storage shapes: latest traits, event history, and asset status. That model was easier to explain, but it still pushed source data into a table even when an aggregate or detail table already represented the condition better.

The selected design kept the warehouse layered and moved physical routing into atomic-predicate metadata. A predicate could target a keyed trait table, an event detail table, an aggregate table, or another DWD table that matched its semantics.

## Architecture

### Separate business predicates from physical routes

Composite predicates were the only business-facing layer. They carried labels, categories, parameter definitions, allowed operators, UI hints, and expansion templates. Operations could configure concepts such as consecutive active days, transaction stage, transaction frequency, membership level, level-up reached, or asset validity.

Atomic predicates carried physical routing: table, alias, key column, value column, value type, and optional fixed key. For example, a keyed trait route could point to `dws_user_latest_traits`, compare `trait_key`, and read either `trait_val_str` or `trait_val_num`. An event route could compare `occurred_at`; an asset route could filter `asset_type`, `asset_sub_type`, and `expire_at`.

That split kept business language stable while allowing table routing to change. It also made predicate configuration part of the runtime contract: changing a route, value type, or table meaning changed who matched a segment.

### Compile an AST without one canonical table

The caller submitted an AST. The backend expanded composite predicates, rejected the request if a composite remained, and compiled an atomic-only AST.

For an `AND` root, each child became a SQL branch that returned `(uid, logic_branch_id)`. The branches were combined with `UNION ALL`, grouped by `uid`, and filtered with:

```sql
HAVING COUNT(DISTINCT logic_branch_id) = ?
```

The final statement wrapped the result in a CTE and added a TiFlash read hint for the routed tables. Each branch returned distinct user IDs, so the count represented the number of AND conditions satisfied. This avoided forcing predicates with different table semantics into one flattened `WHERE` clause.

The compiler supported relative operators such as `BEFORE_INTERVAL`, `WITHIN_INTERVAL`, and `AFTER_INTERVAL`. A current-time option let one refresh use the same execution timestamp for every condition instead of allowing each SQL expression to read a slightly different `NOW()`.

### Refresh segments and cross the service boundary

A segment stored its original AST, SHA-256 AST hash, reference count, status, and last run time. The hash normalized sorted logical children and parameter maps, so reuse depended on **expanded semantics rather than display name**. A unique index on `ast_hash` handled concurrent creation; a duplicate-key error caused the service to reread the canonical segment.

CronHub scheduled each segment hourly. Refresh queried old members, executed the compiled query with a fixed current time, classified added and removed users, emitted membership-change events in batches of at most 5,000 UIDs, and replaced membership in batches of 10,000 rows. A lifecycle task then selected tasks for that segment and published a batched `domain_event_reach` event.

{% mermaid %}
flowchart LR
  subgraph SG_M["Marketing service"]
    A(["Business AST"]):::state --> B(["Expand composites<br/>validate atomic-only AST"]):::event
    B --> C(["Route atomic predicates<br/>compile SQL branches"]):::event
    E(["Compare old and new members<br/>emit added / removed UIDs"]):::event --> L(["Lifecycle trigger<br/>select day-based tasks"]):::event
  end

  D(["TiDB / TiFlash<br/>membership query"]):::state
  F(["Batched domain_event_reach"]):::event

  C --> D
  D --> E
  L --> F

  classDef state fill:#eef7ff,stroke:#245a7d,stroke-width:2px
  classDef event fill:#fff7e6,stroke:#8a6d3b,stroke-width:2px
{% endmermaid %}

Reach consumed the batch, created a per-user record, rendered the template, called the configured provider, and recorded success or failure. Its provider adapters covered log, SMTP, SendCloud, Mailgun, and SendGrid. A rendering or provider failure marked that user's record failed and let the remaining records continue; only if every execution failed did the consumer return an error for retry.

{% mermaid %}
sequenceDiagram
  participant L as Lifecycle trigger
  participant K as Kafka: domain_event_reach
  participant R as Reach consumer
  participant T as Template renderer
  participant C as Email provider
  participant D as reach_record

  L->>K: Publish batched users
  K->>R: Consume batch
  R->>D: Create pending per-user records
  R->>T: Render template per user
  R->>C: Send email
  C-->>R: Provider result
  R->>D: Update delivery record
{% endmermaid %}

## What the Early Demo Exposed

The source-routing job showed why a canonical audience table was the wrong shortcut. The Track service accepted events over gRPC, normalized event IDs, timestamps, and user context, and published `user_behavior_event` to Kafka through an async producer. TiCDC captured selected business-table changes into topics such as `user_transfer`, `bonus_amount_tx`, `game_bet_settle`, and `sport_order_amount`.

One Flink SQL path joined user-transfer and reward-transaction streams with user, game, activity, and reward dimensions, normalized amounts and sources, and wrote a daily activity/reward detail table keyed by `(ref_id, type)`. It ran with ten-second exactly-once checkpoints. That path owned facts by **shape and refresh semantics** instead of forcing every audience condition into one physical row.

A separate DataStream job unified behavior, user, transaction, and settlement events, used bounded out-of-orderness watermarks with idle-source handling, and enriched each user's acquisition dimension. Registration used the promoter channel from the event payload first, then fell back to proxy attribution by invite code and a keyed lookup. A Caffeine cache retained up to 50,000 user dimensions for 30 minutes.

The demo also made several production boundaries visible. Segment refresh emitted change events before it replaced membership, and a publish failure was logged rather than failed the refresh. The reach table had a retry count and source identifiers, but no unique idempotency key covering a replayed batch. The DataStream job's checkpoint line was commented out, and its DWS sink used a single JDBC connection, dynamically assembled table names, and error logging rather than a retry or dead-letter path.

These were not incidental implementation details. They determined whether the system could recover without duplicate email, lose membership deltas during a partial failure, or silently continue after a database write failed. The production contract had to make those outcomes explicit.

When my colleague implemented the production services, I carried those boundaries into implementation review rather than treating them as demo-only concerns.

## Results

The implemented path connected source events and domain changes to layered warehouse tables, predicate compilation, reusable segments, lifecycle tasks, and per-user email reach records. Campaigns no longer needed private targeting SQL for every execution. Operations reviewed business predicates while the backend owned physical routing.

The design also preserved a meaningful service boundary: Marketing decided who should be reached and when; Reach decided how a message was delivered, retried, classified, and recorded. Latest-state, event, asset, and aggregate predicates could participate in one audience definition without a canonical audience table.

The workload had two distinct shapes. The platform served more than 30,000 DAU and game-bet traffic peaked at around 500 QPS, but segment refresh was an hourly query-and-diff workload, not a continuous 500-QPS execution path. Five to ten lifecycle plans were resident; other plans changed with campaigns, and operations adjusted the configuration at least twice a week. Segment sizes ranged from a few tens of users for precise multi-condition pushes to tens of thousands for registration-day recall.

That change frequency was the adoption signal: predicates and lifecycle plans had become part of the operating path, not one-off SQL owned by a developer.

## Trade-offs

What improved:

- audience definitions became reviewable configuration;
- identical semantics could reuse a segment;
- physical tables could evolve behind atomic predicates;
- lifecycle tasks referenced stable segment IDs;
- one bad recipient or template variable could not block the whole batch.

What became more difficult:

- predicate metadata became runtime-critical configuration;
- segment refresh needed bounded batches, explicit state transitions, and replay keys;
- the Marketing/Reach split made delivery diagnosis a cross-service path;
- behavior feature computation increased Flink state and database write load.

## What I Would Change Today

I would keep the composite/atomic split and the AST hash. They made business language reviewable without pretending that a registered event, a latest trait, and an expiring asset had the same physical semantics.

Before adding more predicates, I would document each atomic route with a named producer, table owner, refresh semantics, primary-key meaning, and freshness target. That metadata would make stale or ambiguous routes visible during review.

I would redesign refresh as an explicit state machine with an outbox event and a stable event ID: persist the intended membership transition and publication intent together, publish idempotent events, and only then advance the visible refresh state. In Reach, I would enforce an idempotency key such as `(source_id, user_id, channel_type, scheduled_at)` with a unique constraint and route unrecoverable failures to a dead-letter path.

For the behavior job, checkpointing, state TTL, connection pooling, feature-table schema versioning, and a bounded dynamic-SQL allowlist would be acceptance criteria, not follow-up work. The demo was useful because it exposed those boundaries early; the lesson was that batching and delivery records only become reliable after replay and failure semantics are part of the contract.

---

*Previous in this series: [Building a Real-Time Data Platform with TiDB CDC and Flink](/posts/engineering-case-study/building-a-real-time-data-platform-with-tidb-cdc-and-flink/).*
