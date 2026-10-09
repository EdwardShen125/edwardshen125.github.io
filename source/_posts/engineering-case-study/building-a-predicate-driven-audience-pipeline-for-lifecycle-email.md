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
description: How reusable predicates, AST compilation, and layered TiDB data let lifecycle campaigns combine user traits, events, and expiring assets into email audiences.
seo_image: architecture.png
---

Lifecycle campaigns repeatedly combined latest user traits, historical events, and expiring assets. Operations initially assembled those audiences manually; the platform already had transactional services and a TiDB/TiCDC/Kafka/Flink data path, but marketing needed reusable audience definitions and automated email tasks rather than campaign-specific filters.

I wrote the design document and early core demo for predicate expansion, SQL compilation, segment refresh, and the reach handoff. A colleague implemented the production services with my guidance.

<!-- more -->

{% asset_img architecture.png Predicate-driven audience pipeline architecture %}

## Context and requirements

The work ran on the Go microservice platform described earlier in this series. Product and operations needed lifecycle campaigns for registration, activity, transaction behavior, membership progression, and expiring rewards. The data platform already provided TiDB, TiCDC, Kafka, Flink, and layered analytical tables.

The design treated each predicate as a reusable backend contract. Marketing owned predicates, compilation, segments, lifecycle plans, and reach events. Reach owned message delivery, channel policy, frequency control, fallback, receipts, and message persistence.

Audience conditions came from different data shapes:

- latest user traits, such as activity, transaction totals, and membership level;
- historical events, such as registration or level-up;
- time-sensitive asset state, such as reward or entitlement expiry;
- combinations of those conditions.

Without a shared predicate model, each campaign would carry its own filter expression, scan, and audience result. That would make audience logic difficult to review and would leave later plans without a stable definition to reuse. Different campaigns could still choose different predicates; the platform made the selected definition explicit and reusable.

The pipeline had to reuse that platform rather than introduce another warehouse. It also had to keep changing while feature delivery continued.

The design had to meet six requirements:

- define audiences with business predicates instead of campaign-specific SQL;
- keep UI predicates separate from physical table routing;
- let latest traits, events, assets, and aggregates retain their own storage semantics;
- reuse an identical audience definition instead of creating another member table;
- bound segment replacement and event size during refresh;
- send lifecycle email and retain a per-user delivery record.

## Options Considered

The simplest option was to let each campaign own its SQL. That preserved short-term flexibility, but it duplicated the meaning of common predicates and left no canonical place to review audience logic.

A canonical audience table was the second option. Every source event could be transformed into a common user-attribute row. Querying would become uniform, but event history, latest traits, and expiring assets would be forced into one update and freshness model. A row representing "user registered" has different semantics and retention needs from a row representing "reward expires at this timestamp."

We also considered three fixed storage shapes: latest traits, event history, and asset status. That model was easier to explain, but it still pushed source data into a table even when an aggregate or detail table already represented the condition better.

The selected design kept the warehouse layered and moved physical routing into atomic-predicate metadata. A predicate could target a keyed trait table, an event detail table, an aggregate table, or another DWD table that matched its semantics.

## Architecture

### Separate business predicates from physical routes

Composite predicates were the only business-facing layer. They carried labels, categories, parameter definitions, allowed operators, UI hints, and expansion templates. Operations could configure concepts such as consecutive active days, transaction stage, transaction frequency, membership level, level-up reached, or asset validity.

Atomic predicates carried physical routing: table, alias, key column, value column, value type, and optional fixed key. For example, a keyed trait route could point to `dws_user_latest_traits`, compare `trait_key`, and read either `trait_val_str` or `trait_val_num`. An event route could compare `occurred_at`; an asset route could filter `asset_type`, `asset_sub_type`, and `expire_at`.

That split kept business language stable while allowing table routing to change. It also made predicate configuration **runtime-critical configuration**: changing a route, value type, or table meaning changed who matched a segment. Before adding more predicates, I would document each atomic route with a named producer, table owner, refresh semantics, primary-key meaning, and freshness target to expose stale or ambiguous routes during review.

### Compile the audience AST

The caller submitted an AST. The backend expanded composite predicates, rejected the request if a composite remained, and compiled an atomic-only AST.

For an `AND` root, each child became a SQL branch that returned `(uid, logic_branch_id)`. The branches were combined with `UNION ALL`, grouped by `uid`, and filtered with:

```sql
HAVING COUNT(DISTINCT logic_branch_id) = ?
```

The final statement wrapped the result in a CTE and added a TiFlash read hint for the routed tables. Each branch returned distinct user IDs, so the count represented the number of AND conditions satisfied. This avoided forcing predicates with different table semantics into one flattened `WHERE` clause.

The compiler supported relative operators such as `BEFORE_INTERVAL`, `WITHIN_INTERVAL`, and `AFTER_INTERVAL`. A current-time option let one refresh use the same execution timestamp for every condition instead of allowing each SQL expression to read a slightly different `NOW()`.

### A combined audience example

Consider an illustrative reward-reminder audience: users who registered at least seven days ago, have reached a configured membership level, and hold a reward expiring within the next two days. Operations would combine these business predicates under one `AND` root and supply the age, level, and expiry parameters.

| Business condition | Atomic routing and filtering | Data shape |
|---|---|---|
| Registered at least seven days ago | Registration event route; compare `occurred_at` with the refresh time minus seven days | Historical event |
| Membership level meets the configured threshold | Latest-trait route; select the membership trait and compare its numeric value | Latest state |
| Reward expires within the next two days | Asset route; select the reward type and filter `expire_at` between the refresh time and two days later | Asset state |

Composite expansion resolves the business predicates into atomic conditions. Both time-based conditions use the same refresh timestamp, so the registration-age threshold and reward-expiry window do not drift within one refresh.

Operations can adjust the reminder window or membership threshold using the existing predicate definitions. The physical routes remain backend-owned, and another lifecycle plan can reference the same segment when its expanded definition matches. The combination spans three data shapes while keeping their producers and storage semantics separate.

### Refresh segments and cross the service boundary

The production segment service stored its original AST, SHA-256 AST hash, reference count, status, and last run time. The hash normalized sorted logical children and parameter maps, so reuse depended on expanded semantics rather than display name. A unique index on `ast_hash` handled concurrent creation; a duplicate-key error caused the service to reread the canonical segment.

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

Reach consumed the batch, created a per-user record, rendered the template, called the configured provider, and recorded success or failure. A rendering or provider failure marked that user's record failed and gave the batch failure isolation; *only if* every execution failed did the consumer return an error for retry.

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

## Source processing and recovery limits

### Source jobs behind the predicates

The source-routing jobs fed the atomic-predicate routes. The Track service accepted events over gRPC, normalized event IDs, timestamps, and user context, and published `user_behavior_event` to Kafka through an async producer. TiCDC captured selected business-table changes into topics such as `user_transfer`, `reward_transaction_event`, `settlement_event`, and `order_amount_event`.

One Flink SQL path joined user-transfer and reward-transaction streams with user, game, activity, and reward dimensions, normalized amounts and sources, and wrote a daily activity/reward detail table keyed by `(ref_id, type)`. It ran with ten-second checkpoints. A separate DataStream job unified behavior, user, transaction, and settlement events, used bounded out-of-orderness watermarks with idle-source handling, enriched acquisition dimensions, and wrote feature tables.

### Recovery boundaries in the demo

The demo also made several production boundaries visible. Segment refresh emitted change events before it replaced membership, and a publish failure was logged without failing the refresh. The reach table had a retry count and source identifiers, but no unique idempotency key covering a replayed batch. The DataStream job's checkpoint line was commented out, and its DWS sink used a single JDBC connection, dynamically assembled table names, and error logging rather than a retry or dead-letter path.

Those behaviors risked duplicate email on replay, lost membership deltas during partial failure, and database write failures that did not stop processing. The mechanisms described here were requirements I carried into production implementation review, not features the demo already had.

I would redesign refresh as an explicit state machine with an outbox event and stable event ID: persist the intended membership transition and publication intent together, publish idempotent events, and only then advance the visible refresh state. In Reach, I would enforce an idempotency key such as `(source_id, user_id, channel_type, scheduled_at)` with a unique constraint and route unrecoverable failures to a dead-letter path.

For the behavior job, I would require checkpointing, state TTL, connection pooling, feature-table schema versioning, and a bounded dynamic-SQL allowlist before accepting it for production.

## Results

Operations could configure lifecycle audiences through shared business predicates, while the backend maintained their physical routes. Campaigns no longer needed private targeting SQL for every execution, and latest traits, historical events, expiring assets, and aggregates could be combined in one audience definition.

Five to ten lifecycle plans remained active, with additional plans changing by campaign. Operations adjusted configurations at least twice a week. This recurring use put predicate reuse and the separation of business definitions from table routing into the campaign workflow: targeting changes could use existing predicates while their SQL expansion remained centrally defined.

The same hourly query-and-diff path handled segments ranging from a few tens of users for precise multi-condition messages to tens of thousands for registration-day recall. That range made bounded membership writes and batched change events relevant to routine operation. The handoff to Reach retained a per-user email record, so a failed recipient could be inspected without stopping the remaining batch.

## Trade-offs

Reviewable audience configuration, segment reuse, and stable segment IDs reduced campaign-specific work. Physical tables could evolve behind atomic predicates, but that made predicate metadata runtime-critical configuration.

The Marketing/Reach boundary spread delivery diagnosis across services, and behavior feature computation increased Flink state and database write load. Per-user records isolated individual send failures; they did not by themselves make replay safe.

The remaining design work was at the event boundary. Segment reuse and individual failure isolation did not define how a replayed event became a duplicate; replay safety required producer-side publication state and consumer-side idempotency to be defined together.

---

*Previous in this series: [Building a Real-Time Data Platform with TiDB CDC and Flink](/posts/engineering-case-study/building-a-real-time-data-platform-with-tidb-cdc-and-flink/).*
