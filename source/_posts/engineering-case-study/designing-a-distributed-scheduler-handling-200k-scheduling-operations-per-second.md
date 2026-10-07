---
title: Designing a Distributed Scheduler Handling 200K+ Execution Commands per Second
date: 2025-01-01 14:00:00
categories:
  - Engineering Case Study
tags:
  - distributed-systems
  - go
  - tidb
  - pulsar
  - etcd
  - scheduling
---

Adding scheduler instances made the contention worse, not better. The legacy batch center and [xxl-job](https://github.com/xuxueli/xxl-job) had already flatlined, and every new instance multiplied lock contention on the same task table. This is the retrospective of their replacement — a scheduling center on [TiDB](https://docs.pingcap.com/tidb/stable/overview), [etcd](https://etcd.io/), and [Apache Pulsar](https://pulsar.apache.org/) whose daily on-the-hour workload peaked above 200K execution commands per second — and of the incidents that forced its isolation model to be redesigned.

## Context

At my previous company, the SCRM (Social CRM) platform served enterprise marketing teams. Much of the product depended on delayed execution: marketing SOP (standard operating procedure) sequences, follow-up reminders, and large one-shot jobs. Two legacy components—the in-house batch center and xxl-job—covered more than twenty business scenarios and carried a continuously active scheduling workload.

I owned the design and delivery of their replacement: a Go scheduling center on TiDB, etcd, and Pulsar, followed by migration of existing scenarios onto it. The mechanisms below describe the deployed system; the production sections distinguish what we observed from what changed as a result. It reused established storage, coordination, and delivery primitives instead of inventing new infrastructure.

Four terms recur below. A *job* was a registered business definition. A *trigger* was the durable schedule for that job: a one-shot trigger represented one run, while a cron trigger maintained the next occurrence in `next_fire_at`. A *sharding item* was a fan-out unit inside a run. An *execution command* was one sharding item handed to the executor through Pulsar. Throughput counts published commands, not database scans, trigger rows, or downstream handler completion.

## Problem

Both legacy systems shared the same execution model. When a task came due, the scheduler dispatched it onto a worker and invoked a business HTTP callback; the worker stayed occupied until the callback returned. Real handlers took milliseconds to minutes, so every slow task held its worker hostage. Under load, the pool saturated and production hit a ceiling at a few thousand legacy dispatches per second.

Scaling out made contention worse: every instance polled and updated the same task table, so adding instances multiplied lock contention.

{% mermaid %}
flowchart LR
    H["handler: ms to minutes"]:::pressure
    W["worker occupied<br/>until callback returns"]:::pressure
    S["pool saturated<br/>a few thousand per second"]:::impact

    D([due task]):::trigger --> H
    H --> W
    W --> S

    classDef trigger fill:#eef7ff,stroke:#245a7d,stroke-width:2px;
    classDef pressure fill:#fff7e6,stroke:#8a6d3b,stroke-width:2px;
    classDef impact fill:#fdecea,stroke:#a44a3f,stroke-width:2px;
{% endmermaid %}

## Constraints

- Task state had to live in a transactional database. Tasks were coupled to business flows, and we needed state transitions to be auditable and recoverable, not buried inside message queues or caches.
- Existing business scenarios had to migrate without rewrites. The new system needed an SDK and a data migration path.
- Downstream handler latency was unpredictable and outside our control. The scheduler had to make progress regardless of how long business callbacks took.
- The replacement had to happen gradually, business by business, while both old and new systems ran against production traffic.

## Requirements

- Second-level scheduling precision for delayed tasks, plus cron support for recurring ones.
- Peak throughput well beyond the old ceiling.
- Failure isolation between business scenarios.
- Full replacement of the batch center and xxl-job with a gradual, verifiable cutover.

## Options Considered

The real choice was not “which scheduler tool to use.” It was where to put durable state, scheduling sharding, and delivery precision.

### Patch and scale the legacy schedulers

Rejected. Adding instances or enlarging worker pools preserved the worker-per-callback model, and every scheduler still polled and updated the same task table. Sharding or partitioning that table was not drop-in either: the legacy dispatch loop would need a rewrite without removing slow-handler occupancy.

### Make Pulsar the task store

Rejected. Holding every future trigger as a delayed message would remove database polling, but pause, cancel, migration, audit, and recovery would become queue mutations. Long-lived business state would no longer be auditable in one transactional place.

### Use etcd to shard schedulers

Rejected for this stage. An etcd coordinator could distribute partitions across nodes, but the bottleneck was TiDB partition access and command delivery, not the number of leader processes. Shard assignment, rebalance, and partial-failure handling would add complexity before removing that bottleneck.

### Chosen: hybrid state and delivery

TiDB remained the transactional owner of trigger state and due-time discovery. Pulsar delivered only admitted execution commands. etcd remained a lease service, not a scheduler-shard coordinator.

## Architecture / Design

The [C4](https://c4model.com/) container view below shows the final system after topic isolation: etcd election; the leader's partition schedulers and in-process fire pipeline; the TiDB trigger store; per-domain Pulsar topics; and the executor SDK. Arrow badges carry the protocol for each hop — lease, SQL CAS, deliver-at, consumer groups, or event.

{% asset_img architecture-c4.png C4 container view of the final Distributed Scheduling Center: etcd election, scheduler leader and fire pipeline, CAS acquire against the TiDB trigger store, delivery-at publication to per-domain Pulsar topics, executor SDK consumer groups, and execution callback events %}

## Key Technical Decisions

### Leader election and acquire-loop ownership

The elected leader owned every TiDB partition scheduler and the bounded fire pool. This kept partition ownership and failure semantics simple: if the leader died, followers campaigned with exponential backoff and one took over. The cost was a one-process acquire-loop ceiling and a brief failover gap.

### Partition-serial scheduling

The trigger table was hash-partitioned by ID in TiDB, with the partition count sized to expected business volume. The scheduler discovered partitions from [table metadata](https://docs.pingcap.com/tidb/stable/partitioned-table) and ran exactly one scheduling goroutine per partition inside the leader. Within a partition, acquisition was serial: scan due triggers, acquire, fire. Because each goroutine touched only its own partition, the common case had no cross-goroutine contention; partition pruning kept scans cheap. Hash partitioning did not balance load by due time, however.

### CAS as a safety net

Persistent transitions used conditional updates. `waiting -> acquired` gated fire preparation; `acquired -> waiting` or `acquired -> completed` recorded the outcome. The domain model used `triggered` only as a transient state while preparing a fire batch; it was not separately persisted. With a single owner per partition this rarely contended, but correctness never depended on election being perfect. Pause and resume moved triggers through the same conditional-update API, so a manual operation could not leave a state the scheduler would misread.

{% mermaid %}
flowchart TD
    R([trigger created]):::event --> W([waiting]):::state
    W -->|CAS acquire| A([acquired]):::state
    A --> F[fire prepared]:::event
    F -->|one-shot complete| C([completed]):::state
    F -->|cron has next| N[cron next fire]:::event
    N --> W
    A -.->|dispatch failed| D[dispatch failed]:::event
    D -.->|release| W
    W -->|pause| P([paused]):::state
    P -->|resume| W

    classDef state fill:#eef7ff,stroke:#245a7d,stroke-width:2px;
    classDef event fill:#fff7e6,stroke:#8a6d3b,stroke-dasharray:3 3;
{% endmermaid %}

### Coarse acquisition, precise delivery

The scheduler admitted triggers from a configurable lookahead and published each command with a deliver-at time equal to the trigger's fire time. After the first on-the-hour contention incident, production used a 30-minute window. This let DB polling be lazy and batchy while Pulsar preserved second-level delivery precision.

For one trigger, `T` was its scheduled trigger time, not the acquire or publish time: `T = trigger_at = next_fire_at` in TiDB and `T = deliver-at` in Pulsar. `Δ = T - acquire_time` was its remaining lead time. In the diagram, `T - 30m 30.5s` and `T + 2h` are wall-clock offsets from `T`; the maximum early-admission lead is `30m 30.5s` (30s idle wait + 30m acquisition window + 0.5s jitter). The diagram shows the normal early-admission path, where `Δ` was positive.

{% mermaid %}
sequenceDiagram
    participant L as Lookahead
    participant S as Scheduler
    participant DB as TiDB
    participant Q as Pulsar
    participant E as Executor SDK

    Note over L,S: Lookahead reaches trigger at most 30m 30.5s before T
    L->>S: due trigger within acquisition window
    S->>DB: CAS acquire<br/>waiting -> acquired
    S->>Q: publish command<br/>deliver-at = T
    Q->>E: deliver at trigger_at = T
    Note over S,DB: Misfire horizon: now = T + 2h
{% endmermaid %}

This split the timing contract: TiDB retained the long-horizon `waiting` row; Pulsar held only the admitted slice and delivered it at `next_fire_at`.

### Fan-out through sharding items

Large audience jobs could not expand into millions of individual triggers. Instead, each job carried sharding items that the fire pipeline paged through (300 per page), turning each item into its own execution command. Fired records were persisted per item so execution results could be tracked and aggregated through callbacks.

### SDK execution instead of exposed HTTP callbacks

Legacy business services exposed HTTP callback endpoints; every integration needed a route, network ingress, and scheduler-to-business authorization. With the SDK, a service consumed its Pulsar topic and invoked a registered function-level callback, so teams implemented handler logic rather than controller endpoints. Broker and SDK identity still required authorization, but the scheduler-to-business HTTP surface disappeared.

## Implementation

Within the leader, each partition scheduler handed acquired batches to a bounded in-process fire pool—not a separate service. The fire pool provided up to 6,000 concurrent batch workers and served as the scheduler-side backpressure boundary. Its acquire loop ran once per tick:

1. Compute the acquisition window: from the misfire floor — the older of the partition's tracked latest `next_fire_at` and two hours before now — to now plus the lookahead. The startup floor could reach seven days back.
2. Select `waiting` triggers in that window, ordered by due time, limited to the batch size — and capped by available capacity in the fire pool, so the scheduler never acquired more than it could hand off.
3. CAS the batch from `waiting` to `acquired`, confirm winners by re-reading state, then submit groups of up to 100 acquired triggers to the fire pipeline with retries.
4. If the fire pipeline rejected work repeatedly, release the triggers back to `waiting` so nothing was lost.

The admission boundary was the important code path. The scheduler computed the lookahead horizon from its idle poll interval, configured acquisition window, and jitter. The production values were:

```json
{
  "time_window_milli": 1800000,
  "idle_wait_time_milli": 30000,
  "max_batch_size": 300,
  "chunk_size": 100,
  "misfire_threshold_milli": 7200000,
  "misfire_threshold_min_launch": -10080
}
```

```go
upper := time.Now().UnixMilli() +
	s.getIdleWaitTimeMilli() + // production: 30s idle wait
	s.getBatchTimeWindow() + // production: 30m acquisition window
	randSleepMaxDuration.Milliseconds()

acquired, err := s.jobAppSvc.AcquireNextJobTriggers(
	ctx, s.PartitionName,
	s.getMisfireTime(latestNextFireAt), // overdue-trigger floor
	upper,                              // now + ~30m30.5s
	s.getBatchSize(),                   // min(free fire slots, 300)
)
```

The repository selected only the bounded due-soon slice from each partition:

```sql
WHERE state = 'waiting'
  AND next_fire_at BETWEEN ? AND ?
ORDER BY next_fire_at ASC
LIMIT ?
```

The SQL admitted by due time first. Trigger priority then acted as an in-memory tie-breaker when selected triggers shared the same `next_fire_at`; it was not a separate scheduling lane.

After the CAS admission shown in the timing diagram, the fire pipeline published each execution command with a delayed-delivery timestamp:

```go
err := j.publisher.Publish(_ctx, _ent,
	driver.WithDelayAt(_ent.GetFireAt()),
	driver.WithTags(_ent.GetJobCode()))
```

The fire pipeline computed the next fire time or marked completion, expanded sharding items, persisted fired records, and published execution commands. Each business SDK consumed its domain topic, invoked the registered callback, and reported the result as a callback event.

Purpose-built readers read old batch task tables and their change streams; a data flag made repeated migration idempotent. After load and functional tests against production traffic, cutover proceeded from low-risk to critical scenarios. The final scheduler and SDK stayed deliberately bounded—110 non-test Go files and roughly 8,900 lines—without a bespoke coordination service or storage engine.

## Failure Modes / Production Challenges

### Hot-minute contention

The first production stress pattern came from time alignment, not row skew. Hash partitioning spread trigger rows evenly by ID, but a large SOP workload placed many trigger runs at exact hour boundaries. Just before those boundaries, the acquisition scan found the burst and the partition-serial path became dominated by that workload. Other triggers behind it in the same partitions waited; the lookahead fell behind and the system spent subsequent ticks catching up.

Monitoring exposed the falling lookahead. We increased the acquisition window to 30 minutes, worked with the business team to replace exact `:00` fire times with randomized seconds, and used trigger priority as a same-time tie-breaker. Priority was not full isolation—the SQL still admitted by due time first—but scheduled delivery stayed on time; remaining pressure moved to downstream consumers.

### Shared-topic backpressure

The next isolation failure came after onboarding the audience-SOP scenario. The SDK gave each business its own consumer group, so Pulsar showed exactly which subscription was falling behind. But all commands still entered one shared topic; its backlog produced producer backpressure and made a local problem platform-wide.

We split the topic per business domain. A slow consumer could then delay only its own domain while other businesses kept flowing and could be throttled or scaled independently. The diagrams show this final topology.

### A cancellation design we removed

Early admission created another contract problem: Pulsar did not support canceling a message after it was published with a future deliver-at time. We tried tracking in-flight commands in Redis—publish set a state, consumption updated it, and the SDK filtered canceled commands while locks attempted consistency.

Production did not justify that complexity. Redis load rose, the lock-and-state path became hard to reason about, and debugging spanned TiDB, Pulsar, and Redis. Actual cancel demand was very low and downstream async handlers were already idempotent, so we removed the Redis layer and treated admission as the cancellation boundary.

## Results

- Peak publish rate above 200K execution commands per second during daily on-the-hour workload peaks.
- Trough traffic in the thousands of execution commands per second.
- Coverage of more than 20 business scenarios over the system's production lifetime.
- Full replacement of both the batch center and xxl-job, with a gradual per-business cutover and no big-bang migration.

The 200K+ figure came from the Pulsar Manager publish-rate panel: messages per second on the execution-command topics. For the SOP workload that drove the peak, one sharding item produced one command; larger fan-outs produced proportionally more. The publish-rate panel — not fire-pool size — was the source of the claim.

## Trade-offs

### What it made better

In production, partitioned acquisition and the bounded fire pool supported the observed peak without falling back into table-lock contention. Pulsar deliver-at separated delivery precision from database polling frequency. The design also kept auditable task state in one place and gave each partition a predictable admission order.

### What it made worse

Every state transition added write amplification on TiDB. Partition count became a capacity-planning burden, since changing it later is not free. The design also did not scale admission horizontally: the elected leader still owned every partition acquire loop, so throughput and failover were bounded by one process. At-least-once delivery pushed idempotency requirements onto every executor.

The enlarged lookahead also widened the cancellation boundary. A 30-minute window absorbed hot-minute bursts better, but once a trigger crossed that boundary and became a delayed Pulsar message, the platform could not cancel it in the queue.

## What I Learned

Throughput problems are often execution-model problems, not resource problems. The legacy systems did not need more machines; they needed to stop holding a worker per in-flight callback. Adding instances made contention worse instead of improving throughput.

Isolation boundaries must be a first-class design input. We designed for throughput and correctness, and retrofit isolation after the single-topic incident. Both were necessary; only one was planned.

Decoupling acquisition granularity from delivery precision was the central gain: the database stayed transactional and lazy, while the message queue absorbed the precision requirement.

A cancellation contract is a scheduling decision, not an SDK detail. Once early admission publishes a non-cancelable delayed message, every later attempt to simulate cancellation adds distributed state in the wrong place.

## What I Would Change Today

I would split triggers into reliability and priority lanes at creation time, each with its own task table, scheduler policy, capacity budget, and cancellation semantics. Lookahead would adapt to per-domain fire-time lag and burst forecasts instead of using one global window.

Topic-per-business-domain and per-business concurrency quotas would be initial SDK contracts, not post-incident fixes.

I would instrument fire-time lag — the difference between a trigger's scheduled time and its actual delivery — as a first-class SLI from day one, with alerting on both platform-wide and per-domain percentiles.

At larger scale, I would add an etcd-backed shard registry: each scheduler pod would lease a subset of TiDB `HASH(id)` partitions and own their acquire/fire pipeline, while etcd watched pod liveness and reassigned partitions after failure. This would not remove pressure on TiDB or Pulsar, but it would remove the single-pod admission ceiling once partition count or on-the-hour bursts exceeded one pod's capacity.

---

*Next in this series: [Building a Production-Grade Go Microservice Architecture from Zero](/posts/engineering-case-study/building-a-production-grade-go-microservice-architecture-from-zero/) — a different company, a different problem: the platform built so that nineteen services would standardize themselves.*
