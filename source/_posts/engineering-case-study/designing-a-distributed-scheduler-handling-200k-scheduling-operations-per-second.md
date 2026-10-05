---
title: Designing a Distributed Scheduler Handling 200K+ Scheduling Operations per Second
date: 2026-10-01 14:00:00
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

<!-- TODO before publishing: fill in or remove the placeholders marked TODO
     (partition count, cluster sizes, scheduling-latency numbers). -->

Adding scheduler instances made the contention worse, not better. The legacy batch center and xxl-job flatlined at a few thousand operations per second, and every new instance multiplied lock contention on the same task table. This is the retrospective of their replacement — a scheduling center on TiDB, etcd, and Pulsar that sustained 200K+ operations per second across more than twenty business scenarios — and of the incident that forced its isolation model to be redesigned.

{% asset_img architecture.png Distributed Scheduling Center architecture: etcd election, partition schedulers, TiDB CAS state machine, fire pipeline, Pulsar topics per business domain, executor SDK %}

## Context

At my previous company, the SCRM platform served enterprise marketing teams, and a large share of product features depended on delayed execution: marketing SOP sequences that touched segmented audiences at scheduled moments, follow-up reminders, and large one-shot jobs created by operations. Two legacy components carried this load: an in-house batch center and xxl-job. Together they covered more than twenty business scenarios and were approaching a hundred million scheduled tasks.

I owned the design and delivery of their replacement: a lightweight distributed scheduling center built in Go on top of TiDB, etcd, and Pulsar, and later the migration of existing business scenarios onto it.

## Problem

Both legacy systems shared the same effective execution model for our workloads. When a task came due, the scheduler dispatched it onto a worker and invoked a business HTTP callback; the worker stayed occupied until the callback returned. For fast handlers this was fine. But real business handlers took anywhere from milliseconds to minutes, and every slow task held its worker hostage. Under load, the worker pool saturated and throughput collapsed. Production hit a ceiling at a few thousand scheduling operations per second.

Scaling out made things worse, not better. Every instance polled and updated the same task table, so adding instances multiplied read/write lock contention on it. The system could not grow horizontally at exactly the moment we needed it to.

{% mermaid %}
flowchart LR
    D[due task] --> W["worker occupied<br/>until callback returns"]
    W --> H["handler: ms to minutes"]
    H --> S["pool saturated<br/>few thousand ops/s"]
    S -.->|"redesign: decouple dispatch<br/>from handler time"| R["command published<br/>with deliver-at = fire time"]
    R --> X["capacity scales with<br/>partitions + fire-pool size"]
{% endmermaid %}

## Constraints

- Task state had to live in a transactional database. Tasks were coupled to business flows, and we needed state transitions to be auditable and recoverable, not buried inside message queues or caches.
- Existing business scenarios had to migrate without rewrites. The new system needed an SDK and a data migration path.
- Downstream handler latency was unpredictable and outside our control. The scheduler had to make progress regardless of how long business callbacks took.
- The replacement had to happen gradually, business by business, while both old and new systems ran against production traffic.

## Requirements

- Second-level scheduling precision for delayed tasks, plus cron support for recurring ones.
- Peak throughput well beyond the old ceiling; the audience-SOP scenario alone later drove sustained scheduling rates above 200K operations per second.
- Failure isolation between business scenarios: one slow consumer must not stall the platform.
- Full replacement of the batch center and xxl-job with a gradual, verifiable cutover.

## Options Considered

**Patching xxl-job and the batch center** (sharding the table, enlarging worker pools) treated symptoms. The thread-per-callback execution model and the shared-table contention remained, so the ceiling would only move slightly.

**Moving the entire task lifecycle into the message queue**, holding every task as a delayed message, would have removed the database from the scheduling path. We rejected it because pausing, cancelling, migrating, and auditing tasks then mean reading and rewriting messages. We wanted the database to remain the single source of truth for task state.

The design we landed on was a hybrid: the database decides *what* is due, on a coarse time grid; the message queue decides *when* each execution command is delivered, with second-level precision.

## Architecture / Design

The C4 container view below shows the whole system in one frame. Inside the boundary sit the five containers we operated: the scheduler leader that runs the election-driven scan loop, the TiDB table holding trigger state, the fire pipeline that fans commands out to Pulsar, the per-business-domain topics, and the executor SDK embedded in each business service. Every arrow carries its protocol as a badge — lease, SQL CAS, deliver-at, consumer groups, event — because each of those protocols is a design decision explained in the next section.

{% asset_img architecture-c4.png C4 container view of the Distributed Scheduling Center: etcd election feeding the scheduler leader, CAS acquire against the TiDB trigger store, publish with deliver-at to per-domain Pulsar topics, executor SDK consumer groups, and execution callback events %}

## Key Technical Decisions

**Partition-serial scheduling instead of distributed row locking.** The trigger table was hash-partitioned by ID in TiDB, with the partition count sized to expected business volume. The scheduler discovered partitions from table metadata and ran exactly one scheduling goroutine per partition inside the leader process. Within a partition, acquisition was serial: scan due triggers, acquire, fire. Because each goroutine touched only its own partition, there was no cross-goroutine contention in the common case, and partition pruning kept every scan cheap.

**CAS state transitions as a safety net, not the hot path.** Every transition (`waiting → acquired → triggered → waiting/completed`) went through a conditional update: `UPDATE ... SET state = acquired WHERE id IN (...) AND state = waiting`, followed by re-reading state to confirm which rows actually transitioned. With a single owner per partition this rarely contended, but it meant correctness never depended on the election being perfect. If two processes ever touched the same trigger, exactly one would win.

The same discipline covered operational controls: pausing and resuming a job moved its triggers between `waiting` and `paused` through the same conditional-update API, so a manual operation could never leave a trigger in a state the scheduler would misread.

{% mermaid %}
stateDiagram-v2
    [*] --> waiting: job created
    waiting --> acquired: CAS acquire
    acquired --> triggered: command published (deliver-at)
    triggered --> waiting: cron, next fire time
    triggered --> completed: one-shot task
    waiting --> paused: pause API
    paused --> waiting: resume API
    completed --> [*]
{% endmermaid %}

**Coarse acquisition, precise delivery.** The scheduling loop acquired triggers in a lookahead window of roughly forty seconds (configurable), in batches of up to 500, ordered by due time. Each execution command was then published with a deliver-at timestamp equal to the trigger's fire time, so the message bus held it until the right moment. This decoupled the database polling frequency from scheduling precision: the DB loop could be lazy and batchy while precision stayed at the second level.

**A single leader running all partition schedulers.** I considered distributing partitions across nodes, but that adds assignment, rebalancing, and partial-failure handling. A single leader through etcd lease-based election was operationally simpler: if the leader died, followers campaigned with exponential backoff and one took over. The trade-off was that the acquire loop's ceiling was one process, and there was a brief gap during failover. Given that the fire pipeline (not the acquire loop) was the throughput bottleneck, this was acceptable.

**Fan-out through sharding items.** Large audience jobs could not expand into millions of individual triggers. Instead, each job carried sharding items that the fire pipeline paged through (300 per page), turning each item into its own execution command. Fired records were persisted per item so execution results could be tracked and aggregated through callbacks.

## Implementation

The acquire loop of each partition scheduler did the following, once per tick:

1. Compute the acquisition window: from the misfire floor (overdue triggers up to 30 minutes old were still fireable; on startup the catch-up window extended back further) to now plus the lookahead.
2. Select `waiting` triggers in that window, ordered by due time, limited to the batch size — and capped by available capacity in the fire pool, so the scheduler never acquired more than it could hand off.
3. CAS the batch from `waiting` to `acquired`, confirm winners by re-reading state, then submit them to the fire pipeline in chunks of 200 with retries.
4. If the fire pipeline rejected work repeatedly, release the triggers back to `waiting` so nothing was lost.

The fire pipeline loaded job definitions, computed the next fire time (for cron) or marked completion (for one-shot tasks), expanded sharding items, persisted fired records, and published execution commands with their deliver-at timestamps. Business services integrated through an SDK that subscribed with its own consumer group per business and reported results back through callback events.

We migrated the legacy systems with purpose-built tooling: readers for the old batch task tables and their change streams, a data flag to make migration idempotent, and an SDK for business teams. We load-tested and functionally tested against production traffic first, then cut over business by business, starting with small, low-value scenarios and ending with the critical ones.

## Failure Modes / Production Challenges

The most instructive incident came after onboarding the audience-SOP scenario, when scheduling traffic reached 200K+ operations per second. The consumer queues started backing up. Because the SDK gave each business its own consumer group, Pulsar's monitoring showed us exactly which business was falling behind: its handlers could not keep up with the dispatch rate, and the queue backpressure propagated upstream.

The real problem was ours. At that point all businesses shared a single topic, so one slow consumer's backpressure blocked producers for the entire platform. A problem scoped to one business had become a platform-wide stall.

We split the topic per business domain. After that, a slow consumer could only delay its own domain; other businesses kept flowing, and the offending business could be throttled or scaled independently.

<!-- TODO: scheduling-latency numbers (e.g., fire-time lag distribution during
     the incident and after the topic split) would strengthen this section. -->

## Results

- Peak scheduling throughput above 200K operations per second, up from a ceiling of a few thousand in the legacy systems.
- Coverage of more than 20 business scenarios and a task volume approaching one hundred million.
- Full replacement of both the batch center and xxl-job, with a gradual per-business cutover and no big-bang migration.

The 200K+ figure followed from the design itself. It came off the Pulsar Manager publish-rate panel — messages per second on the execution-command topics, one message per task unit scheduled, since most jobs carried a single sharding item. The fire pool held 6,000 slots and dispatched commands in chunks of 200; by Little's law, that pool sustains 200,000 publishes per second only when average end-to-end dispatch latency — the Pulsar round trip included — stays under 30 milliseconds, comfortably inside Pulsar's async-send budget. On the acquisition side, each partition goroutine pulled up to 500 triggers per loop, so aggregate acquire capacity scaled linearly with the number of provisioned partitions. The reported ceiling was therefore bounded by deliberately chosen constants — pool size, batch size, partition count — each independently resizable in configuration.

## Trade-offs

**What this design made better:** horizontal scalability (capacity now grew with partition count and fire-pool size instead of fighting table locks), second-level precision without hammering the database, auditable task state in one place, and predictable scheduling behavior per partition.

**What it made worse:** write amplification on TiDB for every state transition; a capacity-planning burden on partition count, since changing it later is not free; a single-leader ceiling on the acquire loop plus a failover gap during election; and a dependency on at-least-once delivery, which pushed idempotency requirements onto every executor.

## What I Learned

Throughput problems are often execution-model problems, not resource problems. The legacy systems did not need more machines; they needed to stop holding a worker per in-flight callback. Adding instances made contention worse — the opposite of what scaling is supposed to do.

Isolation boundaries must be a first-class design input. We designed for throughput and correctness, and retrofit isolation after the single-topic incident. Both were necessary; only one was planned.

Decoupling acquisition granularity from delivery precision gave us most of the wins: the database stayed transactional and lazy, while the message queue absorbed the precision requirement.

## What I Would Change Today

Topic-per-business-domain would be the initial design, not a post-incident fix, and per-business concurrency quotas would ship with the first version of the SDK.

I would instrument fire-time lag — the difference between a trigger's scheduled time and its actual delivery — as a first-class SLI from day one, with alerting on both platform-wide and per-domain percentiles.

At the scale the system eventually reached, I would revisit the single-leader design and evaluate distributing partitions across nodes with partition-level handoff. The operational simplicity was worth it at first, but the trade-off shifts once the acquire loop itself approaches a single process's limits.

---

*Next in this series: [Building a Production-Grade Go Microservice Architecture from Zero](/blog/posts/engineering-case-study/building-a-production-grade-go-microservice-architecture-from-zero/) — a different company, a different problem: the platform built so that nineteen services would standardize themselves.*
