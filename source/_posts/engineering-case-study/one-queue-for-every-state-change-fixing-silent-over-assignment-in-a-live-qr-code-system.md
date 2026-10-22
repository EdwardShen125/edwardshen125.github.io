---
title: "One Queue for Every State Change: Fixing Silent Over-Assignment in a Live QR Code System"
date: 2023-05-08 10:00:00
categories:
  - Engineering Case Study
tags:
  - go
  - kafka
  - event-driven
  - wecom
  - data-consistency
description: A live QR code system kept sending customers to offline or over-quota salespeople; the routing list lived in WeCom's config. One per-tenant Kafka queue serialized every membership change.
seo_image: architecture.png
---

The escalation arrived as a refund threat. A customer had run a marketing campaign: thousands of end users scanned the customer's QR codes that day, expecting to reach the sales team. One salesperson on the code had already hit his daily assignment quota — the system showed him offline for assignment — yet every new scan still connected to him, and the rotation to the next salesperson never happened. A single salesperson can hold a bounded number of conversations; the overflow left customers waiting until they gave up. The campaign closed far below its target, and the refund demand followed. That one campaign was not the whole story, though: the same mis-assignment had been surfacing on this account for months — quieter incidents, support round-trips, promises that it was fixed. What the campaign day did was concentrate the damage enough to end the relationship: the customer lost money on the activity, then lost trust that the platform could run one at all. They churned, and their annual contract value had six figures in it.

This was the live QR code system of a WeCom SCRM platform — the marketing core of the product. A live QR code ("live" because the people behind it can change without reprinting) routes each scan to one of several salespeople configured on it. We served about 30,000 tenants; roughly 20% were heavy users with around 1,000 codes each, and each code carried 10 to 20 assignable staff. Most of those codes existed quietly on printed material. The traffic that mattered arrived in bursts: campaign codes created for an activity, scanned heavily for days or weeks, then abandoned. Campaign day was when scan volume, quota exhaustion, and staff status changes all peaked together.

I owned this system, and the complaint pattern — staff shown offline still receiving customers, staff over quota still receiving customers — pointed at one class of defect: the system's view of who should receive customers had stopped matching who actually received them. This article is about why that gap existed, what it cost to close, and what I would do differently.

<!-- more -->

## Who actually owns the assignment

The first thing to understand about this system is that the assignment does not run in it. WeCom — Tencent's enterprise messenger — owns the connection mechanics. A customer scans the code in WeChat; WeCom matches the scan to a "contact way" configuration on its side and opens the conversation with whichever staff that configuration lists. Our platform never sees the scan. What we call assignment is really the maintenance of WeCom's contact-way configuration: deciding, at every moment, which staff IDs that config should contain, and pushing changes through WeCom's API — adding a person, removing a person.

The inversion drove every design decision that follows. Consistency is not a property of one database. It is the agreement between two of them: our staff-state view (online, on duty, under quota — stored in our MongoDB per tenant) and WeCom's contact-way config (the thing that actually routes customers). When they diverge, the divergence executes in production: scans keep landing on the person we long since marked offline. And the fix for divergence is itself a distributed write — a call to WeCom's API, rate-limited, occasionally flaky — so the last mile to consistency has its own failure modes.

Two families of codes shared this machinery. Native codes delegate member selection entirely to WeCom's own random assignment; our job there is only who is on the list. Sequenced and quota codes, built on our own landing page, additionally decide the order and the per-person volume — which is where the offline and quota checks bite hardest, because a rotation that never happens is exactly a list that never got updated.

## The old system: many writers, no order

The pre-refactor state, assembled from many features added over two years, looked like this:

- Staff state lived in several places. An online/offline flag per staff (set by an admin HTTP endpoint, or by work-schedule timers), a ceiling document per staff per code counting today's assignments, a company-wide daily total, and four independent config switches on each code (offline check, add limit, daily limit, round limit). All in per-tenant MongoDB.
- Many code paths wrote or acted on this state. The scan callback (WeCom notifies us a customer was added), the admin endpoints for going offline, the quota counters incremented from the callback path, scheduled jobs for work hours, staff resignation handlers, org-structure change events. Each one, when it decided the membership list should change, pushed its own update toward WeCom — inline, with its own retry, at its own moment.
- A pre-existing queue covered one slice. Sequenced/quota codes had a Redis ZSET-based assignment queue with a two-level cursor (built by a teammate in 2021): state-change events went through Kafka to a consumer that recomputed the online list and rebuilt the ZSET, while scans consumed from it via Lua. But the rebuild was a delete-and-recreate of the whole key, and the events it consumed were asynchronous — between "staff hit quota" and "queue rebuilt without him", scans kept drawing from the old membership.

{% mermaid %}
flowchart LR
    subgraph campaign_day["Campaign day - concurrent load"]
        direction LR
        A["Scan lands<br/>quota counter $inc"] --> B["Counter crosses<br/>ceiling"]
        C["Admin marks staff<br/>offline"] --> D["Online flag<br/>written"]
    end
    B --> E["Each writer pushes its own<br/>update toward WeCom<br/>inline, own retry, own moment"]
    D --> E
    E --> F["Updates race:<br/>partial views, last writer wins"]
    F --> G["WeCom config still lists<br/>the exhausted staff"]
    G --> H["Next scans keep<br/>connecting to him<br/>no rotation"]
    style A fill:#fff7e6,stroke:#8a6d3b
    style B fill:#fff7e6,stroke:#8a6d3b
    style C fill:#fff7e6,stroke:#8a6d3b
    style D fill:#fff7e6,stroke:#8a6d3b
    style E fill:#fdecea,stroke:#a44a3f
    style F fill:#fdecea,stroke:#a44a3f
    style G fill:#fdecea,stroke:#a44a3f
    style H fill:#fdecea,stroke:#a44a3f
{% endmermaid %}

No single one of these was "the bug". The defect was structural: **the same state had many concurrent writers, each pushing a list computed from a partial view**. A scan-callback incrementing the quota counter, an admin marking the staff offline, a scheduled rotation, a resignation event — each raced toward WeCom's config holding only its own slice of the truth. On a quiet day the races rarely lost. On campaign day, scan volume and status-change volume peaked in the same minutes, exactly when the sequencing gap between "state says stop" and "WeCom config says go" was most likely to be hit — and most expensive. The customer's campaign was the load profile this architecture could not survive.

Both failure modes had been reaching support for months — offline-still-assigning and over-quota-still-assigning — as individually rare tickets. Each was reproducible only under concurrent load, so each got chased as a would-be logic bug and closed when no code defect surfaced. It took the account's churn to reclassify the pattern: not coding errors, a consistency defect.

## Options considered

Three designs were considered before the queue.

Check at scan time. Intercept the scan, query staff state, pick someone else if the designated staff is offline or full. Rejected as structurally impossible for native codes: the scan never passes through us, so there is nothing to intercept. For sequenced/quota codes it was possible — but it re-introduced the very race it was meant to fix (the check and WeCom's routing are still two systems) and it put a per-scan database dependency on the hottest path we had.

Periodic reconciliation. A job that walks every code, compares our state against WeCom's config, and repairs drift. Attractive as a safety net, rejected as the primary mechanism: with 6M codes and WeCom's API rate limits, a full sweep measured in days, not seconds — a staff member marked offline on campaign morning would keep receiving customers through the whole sweep window. Reconciliation could catch chronic drift; it could not meet the freshness the failure mode demanded.

Keep the multi-writer shape, add better retries. Each writer path gets idempotent calls and exponential backoff. This was the status quo with more machinery: retries make each write more reliable, but reliability of individual writes does not give them a shared view. Two writers with correct retries can still compute from different snapshots of the same state and overwrite each other's result, and the winner's list is missing the other's change. No write was being lost — each write carried a list that was already stale.

What all three shared was treating the symptom at the point of divergence. The alternative was to remove the divergence's cause: make every membership-changing decision flow through one serialized place, so that any update applied reflects the state as it stands when it is computed, not the snapshot some writer happened to hold.

## One queue for every membership-changing event

{% asset_img architecture.png "One queue serializes every membership-changing event: sources feed a tenant-keyed Kafka topic; a serial consumer recomputes members, pushes WeCom's contact-way config first, then writes back to MongoDB. The scan path never passes through our platform." %}

The refactor put a single Kafka queue between "state changed" and "WeCom config changed". Every event that can alter a code's membership — a customer added (quota counters move), a staff member going offline or coming back, work schedule transitions, resignations, org-structure changes, the code's own configuration being edited — is published to one topic, keyed by tenant ID. A consumer group processes these events: for each affected code, it recomputes the eligible member list from current state, pushes the update to WeCom (remove the exhausted staff, add the returning one), and only then writes the result back to our own store. Write order matters here: WeCom is the source of routing truth, so it gets the correct list first; our store records what was pushed, not what was intended.

Serialization comes from the key. Events are keyed by tenant, and the consumer routes each key to a fixed goroutine, so one tenant's events are applied one at a time while tenants proceed in parallel. The eventbus client beneath this — a shared-golib library whose consumption semantics we extended for this need — supplies that per-key serial mode, plus the retry path described below.

Rate pressure is handled inside the pipeline without holding the queue. Every event enters the fast lane first, and the fast lane makes one cheap local decision before it touches WeCom: if the tenant's token bucket has budget, push now; if it does not, mark the affected code degraded and route the event to the slow lane. The mark is sticky per code — once a code is degraded, its later events keep going to the slow lane until the mark clears. That stickiness is what keeps a code from having two writers: fast and slow never hold the same code at the same time, which per-event routing would not give you, because the next event could run fast while an older one is still queued for slow. Clearing runs on hysteresis — the code's slow backlog empty and the tenant budget available for a full window — otherwise the mark flaps at the boundary and recreates the concurrency it exists to prevent.

Failures do not hold the tenant's stream. A failed WeCom call is acknowledged and re-published to the fast lane under the same tenant key, with its retry count incremented, rather than left unacknowledged while the consumer backs off. Re-entering under the same key puts the retry back into that tenant's serial stream, behind whatever arrived in the meantime — no second queue, no second writer. Holding the offset is the obvious choice and the wrong one here: the key is the tenant, so one code's failing call would stall every other code that tenant owns, and under per-tenant rate limiting the codes most likely to be waiting are the ones whose budget just freed up. Ack-and-requeue keeps the blast radius at one code.

Requeueing gives up publish order for that tenant. That would matter if the consumer replayed payloads; it does not, because every handler recomputes the member list from current state at processing time. A late trigger recomputes the same current truth as the newest one, so the last push still writes the latest state. The property the design needs is one writer per code at a time, not an old trigger arriving late — the per-key serial mode and the sticky lane mark are what provide it.

Dropping is deliberate, and it is safe because of how the consumer computes. Messages carry a timestamp and are discarded after a day; a discarded event does not lose a change, because the next event that touches that code recomputes the member list from current state, which already reflects everything the discarded event carried. The residual is a code no later event touches: staff went offline during a multi-hour backlog, and no scan, config edit, or org change followed, so the stale list stays. Campaign codes are never idle for a day, which is why the rule held in practice — that is an assumption about traffic, not a guarantee about state.

The quota loop closes on the same queue. When a scan callback increments a staff member's counter past the configured ceiling, the handler marks the ceiling document (an idempotent "already removed today" flag), notifies the admin, looks up every code that staff is on, and emits one membership event per code. Those events flow through the same single queue as everything else — the exhausted staff's removal from ten codes is ten events on one serial path, not ten racing writers. That multiplication is the system's write amplification: one member's state change becomes as many WeCom pushes as the codes they sit on, and campaign day concentrates both the flips and the codes.

Two properties of WeCom's API shaped the consumer's design beyond serialization. First, it is rate-limited, and the platform serves thousands of tenants concurrently. The consumer therefore carries per-tenant token-bucket rate limiting — an LRU of limiters in memory — rather than waiting to be throttled, with the lane split as its backpressure: events that cannot be pushed inside the current window are delayed, not failed, so a burst degrades into seconds of latency instead of a wall of throttle errors. The budget is per tenant, and the fan-out makes that consequential: one member flipping can spend a tenant's entire window on codes that all need the same removal. Second, its errors are meaningful — a code deleted on WeCom's side returns a specific error, which the consumer treats as a cleanup trigger rather than a retry-forever case.

Migration ran as double-write with a cutover switch, not a big-bang. The new event chain went live while the old synchronous paths still ran; weeks of both paths writing proved the new chain's output matched. The code from that period still carries a comment marking where queueing replaced an inline call — a "TODO: put this into a queue — DONE" fossil. A config switch then retired the old paths, with tenant traffic unchanged from the user's point of view.

## What consistency costs

The queue bought agreement between our state and WeCom's config, at three costs.

Freshness became bounded, not immediate. A staff member going offline now leaves the code within the queue's processing latency — seconds, comfortably inside the single-digit tolerance a scan-and-connect flow has, but no longer the theoretical instant of an inline write. When the lane latch trips, the bound widens to however long the tenant's budget takes to clear: the code waits, but it waits with a list that is still eventually correct. For this product, a consistently-correct list two seconds late beat an instantly-wrong one; the campaign-day failure was the wrong list, not the slow list.

WeCom's API became the explicit throughput ceiling. Under the multi-writer regime no single component owned the rate limit, and throttling surfaced as scattered errors after the fact. Moving every write to one consumer made the ceiling visible and manageable — per-tenant rate limiting, the lane latches, robot alerts on throttle responses — and turned a recurring incident source into a scheduling parameter.

One dependency more than before. Kafka availability now gates membership updates. The failure mode is benign in the interesting direction — if the queue stalls, updates are delayed, not misapplied; scans continue against the last consistent list, which is the pre-refactor behavior only without the corruption. The stricter cost is operational: a second system to monitor, and a class of bugs (poison messages, lag) that MongoDB-only code never had.

## Results

The refactor shipped across the second half of 2022, with the cutover completing in early 2023.

- Both complaint classes stopped. Both failure modes — assignments to offline staff and to over-quota staff — dropped to zero in customer support's tracking after cutover. They stayed at zero for as long as I remained at the company, through the following year's campaign seasons.
- The churned account came back. After living with the refactored system, they re-subscribed — the recovery I weigh most, because a customer who has lost technical trust does not return for a discount. Several other affected accounts renewed with the fix in place. The feature rose to the most-active tier of the marketing product line, and the work received the company's quarterly owner award (2023 Q1).
- The scale the design held at: ~30,000 tenants, ~6M live codes among heavy users, up to several hundred scans per second at campaign peaks, with peak-day scan volume under a million across the platform. The queue's steady-state lag stayed within the seconds-level freshness budget.

None of these numbers came from a load test; they are the production envelope the system ran at. The proof the refactor worked is the complaint record, not a benchmark. The incident account's campaign loss I leave unquantified on purpose: it is the customer's data, not ours to publish — the churn itself, and the re-subscription, carry the argument.

## What I would change today

The part I would keep unchanged is the central decision: one serialized queue for every membership-changing event, keyed by tenant, one writer per code at a time, applying to WeCom first and our store second. Every alternative I can now construct — per-code sharding, a state CRDT, read-side filtering — either reintroduces multiple writers or assumes a write path we do not control.

The production surprise was how much of the work was not the queue. The serialization itself was not the hard part; living with WeCom's rate limits — the per-tenant limiter, the lane latches, the cleanup-on-error semantics — was the long tail. If I scoped this again, I would budget the dependency's shape, not just our own components, and I would size the degrade thresholds from the fan-out arithmetic — how many live codes a member sits on — rather than from event rate, which understates the calls by exactly that factor. I would also coalesce per code on purpose: the push replaces the whole list, so several events for one code inside a window end in one call, and merging them costs nothing.

The gap I did not close is reconciliation. The rejected sweep was right about the need and wrong about the shape: the queue guarantees one writer and a fresh read, not correctness of the outcome — a bug in the recompute logic is applied just as consistently by a serialized queue — but 6M codes at API rate limits is days of work to protect a handful of suspects. The backstop should be a dirty set: codes whose events were dropped, whose push failed permanently, or whose recompute surfaced an error, swept at low frequency in minutes while the rest of the estate is left alone. We had no such layer and relied on customer complaints instead. That was the wrong instrument, and on a system this size, "customers have stopped complaining" was weaker evidence than the system deserved.

One boundary still stands: the assignment lives in someone else's config, and no architecture inside our perimeter makes that someone else synchronous with us. The whole design — the queue, the serialization, the rate shaping — is the machinery for being eventually consistent with a partner who does not share a transaction with you. Eventual consistency, in exchange, can be made disciplined — serialized, bounded in delay, observable in lag. That is what this refactor actually bought.
