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
  - distributed-systems
description: A live QR code system kept sending customers to offline or over-quota salespeople. One per-tenant Kafka queue serialized every update to WeCom's routing config.
seo_image: architecture.png
---

The escalation arrived as a refund threat. A customer had run a marketing campaign: thousands of end users scanned the customer's QR codes that day, expecting to reach the sales team. One salesperson on the code had already hit his daily assignment quota — the system showed him offline for assignment — yet every new scan still connected to him, and the rotation to the next salesperson never happened. A single salesperson can hold a bounded number of conversations; the overflow left customers waiting until they gave up. The campaign closed far below its target, and the refund demand followed. That one campaign was not the whole story, though: the same mis-assignment had been surfacing on this account for months — quieter incidents, support round-trips, promises that it was fixed. What the campaign day did was concentrate the damage enough to end the relationship: the customer lost money on the activity, then lost trust that the platform could run one at all. They churned, and their annual contract value had six figures in it. Nothing in the code was wrong. The list was.

This was the live QR code system of a WeCom SCRM platform — the marketing core of the product. A live QR code ("live" because the people behind it can change without reprinting) routes each scan to one of several salespeople configured on it. We served about 30,000 tenants; roughly 20% were heavy users with around 1,000 codes each, and each code carried 10 to 20 assignable staff. Most of those codes existed quietly on printed material. The traffic that mattered arrived in bursts: campaign codes created for an activity, scanned heavily for days or weeks, then abandoned. Campaign day was when scan volume, quota exhaustion, and staff status changes all peaked together.

I owned this system, and the complaint pattern — staff shown offline still receiving customers, staff over quota still receiving customers — pointed at one class of defect: the system's view of who should receive customers had stopped matching who actually received them.

<!-- more -->

## Assignment does not run in our system

Assignment does not run in our system. WeCom — Tencent's enterprise messenger — owns the connection mechanics. A customer scans the code in WeChat; WeCom matches the scan to a [contact-way configuration](https://developer.work.weixin.qq.com/document/path/92228) on its side and opens the conversation with whichever staff that configuration lists. Our platform never sees the scan. What we call assignment is really the maintenance of WeCom's contact-way configuration: deciding, at every moment, which staff IDs that config should contain, and pushing changes through WeCom's API — adding a person, removing a person.

Consistency is not a property of one database. It is the agreement between two of them: our staff-state view (online, on duty, under quota — stored in our MongoDB per tenant) and WeCom's contact-way config (the thing that actually routes customers). When they diverge, the divergence executes in production: scans keep landing on the person we long since marked offline. And the fix for divergence is itself a distributed write — a call to WeCom's API, rate-limited, occasionally flaky — so the last mile to consistency has its own failure modes.

Two families of codes shared this machinery. Native codes delegate member selection entirely to WeCom's own random assignment; our job there is only who is on the list. Sequenced and quota codes, built on our own landing page, additionally decide the order and the per-person volume — which is where the offline and quota checks bite hardest, because a rotation that never happens is exactly a list that never got updated.

## Every writer held part of the truth

The pre-refactor state, assembled from many features added over two years, looked like this:

- Staff state was split across two stores. Online/offline flags (set by an admin HTTP endpoint, or by work-schedule timers) and the per-staff-per-code ceiling records, including the "already removed today" marker, lived in MongoDB. The counts that decide who is full lived in Redis, per staff member and code. Four independent switches on each code (offline check, add limit, daily limit, round limit) and a company-wide daily total decided how those numbers were applied.
- Many code paths wrote or acted on this state. The scan callback (WeCom notifies us a customer was added), the admin endpoints for going offline, the quota counters incremented from the callback path, scheduled jobs for work hours, staff resignation handlers, org-structure change events. Each one, when it decided the membership list should change, pushed its own update toward WeCom — inline, with its own retry, at its own moment.
- A pre-existing queue covered one slice. Sequenced/quota codes had a Redis ZSET-based assignment queue with a two-level cursor (built by a teammate in 2021): state-change events went through [Kafka](https://kafka.apache.org/) to a consumer that recomputed the online list and rebuilt the ZSET, while scans consumed from it via Lua. But the rebuild was a delete-and-recreate of the whole key, and the events it consumed were asynchronous — between "staff hit quota" and "queue rebuilt without him", scans kept drawing from the old membership.

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

## Three fixes that should have worked

We tried three fixes before the queue.

Check at scan time. Intercept the scan, query staff state, pick someone else if the designated staff is offline or full. Rejected as structurally impossible for native codes: the scan never passes through us, so there is nothing to intercept. For sequenced/quota codes it was possible — but it re-introduced the very race it was meant to fix (the check and WeCom's routing are still two systems) and it put a per-scan database dependency on the hottest path we had.

Periodic reconciliation. A job that walks every code, compares our state against WeCom's config, and repairs drift. Attractive as a safety net, rejected as the primary mechanism: with 6M codes and WeCom's API rate limits, a full sweep measured in days, not seconds — a staff member marked offline on campaign morning would keep receiving customers through the whole sweep window. Reconciliation could catch chronic drift; it could not meet the freshness the failure mode demanded.

Keep the multi-writer shape, add better retries. Each writer path gets idempotent calls and exponential backoff. This was the status quo with more machinery: retries make each write more reliable, but reliability of individual writes does not give them a shared view. Two writers with correct retries can still compute from different snapshots of the same state and overwrite each other's result, and the winner's list is missing the other's change. No write was being lost — each write carried a list that was already stale.

All three treated the symptom at the point of divergence. The alternative was to remove the multiple writers: route every membership-changing decision through one serialized place, so that the list applied reflects the state at the moment it is computed, not the snapshot some writer happened to hold.

## One writer, recomputing

{% asset_img architecture.png "One queue serializes every membership-changing event: sources feed a tenant-keyed Kafka topic; a serial consumer recomputes members, pushes WeCom's contact-way config first, then writes back to MongoDB and rebuilds the Redis assignment set. The scan path never passes through our platform." %}

The refactor put a single Kafka queue between "state changed" and "WeCom config changed". Every event that can alter a code's membership — a customer added (quota counters move), a staff member going offline or coming back, work schedule transitions, resignations, org-structure changes, the code's own configuration being edited — is published to one topic, keyed by tenant ID. A consumer group processes these events: for each affected code, it recomputes the eligible member list from current state — the same offline, add-limit, daily-limit and round-limit conditions the old writers each checked on their own — pushes the update to WeCom (remove the exhausted staff, add the returning one), and only then writes the result back to our own store. Write order matters here: WeCom is the source of routing truth, so it gets the correct list first; our store records what was pushed, not what was intended.

State moves before the event does. The counter that decides who is full lives in Redis, per staff member and code, and the consumer handling WeCom's customer-added callback increments it while handling the addition — before it publishes the refresh event. By the time the refresh runs, the count is current, so the event never has to carry a number the consumer would have to trust. Every other trigger follows the same rule: an admin taking a staff member offline, a work-hours timer, a resignation, an org change writes the flag or the counter at the point where the business event happens, and only then emits the refresh. The queue carries a reason to recompute, not the state to apply.

For sequenced and quota codes the rotation still runs on Redis — the same ZSET and two-level cursor hand each scan its next staff member. What changed is who writes it: the refresh consumer recomputes the eligible members from the counts and flags as they stand, pushes the WeCom list, then updates the assignment set on the same serial path. The set a scan draws from and the list WeCom routes by now come out of one computation, in one order.

Serialization comes from the key. Events are keyed by tenant, and the consumer routes each key to a fixed goroutine, so one tenant's events are applied one at a time while tenants proceed in parallel. The eventbus client beneath this — a shared-golib library whose consumption semantics we extended for this need — supplies that per-key serial mode, plus the retry path described below.

The quota loop closes on the same queue, and it is where the load actually comes from. When a scan callback increments a staff member's counter past the configured ceiling, the handler marks the ceiling document (an idempotent "already removed today" flag), notifies the admin, looks up every code that staff is on and emits one membership event per code — dozens of codes, sometimes more than a hundred, so a single removal produces that many events on one serial path. That multiplication is the system's write amplification: one member's state change becomes as many WeCom pushes as the codes they sit on, with campaign day concentrating both the flips and the codes.

Migration ran as double-write with a cutover switch, not a big-bang. The new event chain went live while the old synchronous paths still ran; weeks of both paths writing proved the new chain's output matched. The code from that period still carries a comment marking where queueing replaced an inline call — a "TODO: put this into a queue — DONE" fossil. A config switch then retired the old paths, with tenant traffic unchanged from the user's point of view.

## What the constraints forced

Rate pressure and business freshness are two different problems, and the design keeps them apart. The lane a code runs in is a business decision: the tenant's tier, how fresh that code's membership has to be, and an operator's switch decide whether its updates are pushed as they arrive or on a slower cadence. The decision is kept as a mark per code in Redis beside the counts, not as state inside the consumer — after a rebalance the tenant's key lands on another instance, and that instance has to make the same routing decision. Every event starts on the fast topic, where the consumer reads the mark first: a code that is already slow is republished to the slow topic without a call. The mark is written by whichever lane currently owns the code: the fast consumer sets it, at the head of the tenant's serial stream, when the policy says the code should slow down, and only then republishes the event to the slow topic; the slow consumer clears it when the policy returns the code to fast and its own work for that code is done. Because a code changes lanes only from the lane that currently holds it, fast and slow never hold the same code at the same time — which per-event routing would not give you, because the next event could run fast while an older one is still queued for slow.

The vendor's rate limit is handled optimistically, on the call path. Before touching WeCom the handler makes two cheap checks. The first is dedupe: it compares the list it just recomputed with the last list it pushed for that code, and when the two match there is nothing to send, so the event ends without a call and without spending budget. That check does not shrink the fan-out — ten codes with ten different lists are ten real pushes — it removes the events that would have been no-ops: a retry that recomputes the same list, a scan callback that changes no membership, a config edit that resolves to what is already there. The second is the tenant's pre-limiter: a token bucket kept in Redis, spent through a Lua script so every consumer instance counts against the same window. If a token is there, push. If not, the handler does not wait and does not touch the code's lane; it parks the event in a Redis delayed queue with a due time and acknowledges it. A poller moves due events back to the fast topic under the same tenant key, where they re-enter the serial stream and go through the same checks again — no second writer, and no message held open while the tenant's window refills. The lane is a property of the code; the delay is a property of one attempt.

Slow is a topic of its own, not a branch inside one handler: routing an event means republishing it to the slow topic, and a slow consumer waiting between pushes parks only that topic's stream for the tenant while the fast topic keeps moving. Its cadence is set by the business decision above, not by the limiter: the consumer waits its interval before each push, and the dedupe check runs there unchanged. Both lanes draw on the same tenant window, so a code in slow still competes with fast work for the [vendor's limit](https://developer.work.weixin.qq.com/document/path/90312); what it gets is fewer attempts, not a budget of its own.

Clearing the mark belongs to the slow consumer, and it has two conditions. The policy has to say fast again — the tenant's configuration or an operator's switch — and the slow lane must have nothing outstanding for that code: Kafka offsets are per partition, so there is no per-code backlog to read, and the consumer keeps that count itself, a pending counter in Redis incremented when an event is routed to the slow topic and decremented after the slow push completes. The slow consumer clears the mark in a Lua script only when the counter is zero and the policy says fast. A message lost to retention leaves the counter high and keeps the code slow longer than it needs to stay, which errs toward the safe side; clearing while a slow message was still in flight would put two writers back on the same code.

Failures do not hold the tenant's stream. A failed WeCom call is acknowledged and re-published to the fast lane under the same tenant key, with its retry count incremented, rather than left unacknowledged while the consumer backs off. Re-entering under the same key puts the retry back into that tenant's serial stream, behind whatever arrived in the meantime — no second queue, no second writer. Holding the offset is the obvious choice and the wrong one here: the key is the tenant, so one code's failing call would stall every other code that tenant owns, and under per-tenant rate limiting the codes most likely to be waiting are the ones whose budget just freed up. Ack-and-requeue keeps the blast radius at one code.

Requeueing gives up publish order for that tenant. That would matter if the consumer replayed payloads; it does not, because every handler recomputes the member list from current state at processing time. A late trigger recomputes the same current truth as the newest one, so the last push still writes the latest state. The property the design needs is one writer per code at a time, not an old trigger arriving late — the per-key serial mode and the sticky lane mark are what provide it.

Dropping is deliberate, and it is safe because of how the consumer computes. Messages carry a timestamp and are discarded after a day; a discarded event does not lose a change, because the next event that touches that code recomputes the member list from current state, which already reflects everything the discarded event carried. The residual is a code no later event touches: staff went offline during a multi-hour backlog, and no scan, config edit, or org change followed, so the stale list stays. Campaign codes are never idle for a day, which is why the rule held in practice — that is an assumption about traffic, not a guarantee about state.

Two properties of WeCom's API shaped the rest of the consumer. The budget is per tenant — a token bucket in Redis, refilled and spent by a Lua script so every consumer instance counts against the same window — and the fan-out makes it consequential: one member flipping can spend a tenant's entire window on codes whose lists all change. When the window is empty the attempt is parked in the delay queue rather than failed, so a burst turns into latency instead of a wall of throttle errors. The other property is that the errors are meaningful: a code deleted on WeCom's side returns a specific error, which the consumer treats as a cleanup trigger rather than a retry-forever case.

## What it cost, and what it bought

The refactor shipped across the second half of 2022, with the cutover completing in early 2023.

The queue bought agreement between our state and WeCom's config, at three prices — and each price is visible in the same record that shows the fix worked.

Freshness became bounded, not immediate. A staff member going offline now leaves the code within the fast lane's processing latency — seconds, inside the tolerance a scan-and-connect flow has, but no longer the theoretical instant of an inline write. A code on the slow lane waits its cadence instead, which is longer by design, and a call the limiter refuses comes back after the delay queue's due time. For this product, a consistently correct list that arrives late beat an instantly wrong one. The record after cutover: p95 from event to WeCom's config under five seconds, and six consecutive months without a single ticket for either failure mode, against at least three tickets a month before.

WeCom's API became the explicit throughput ceiling. Under the multi-writer regime no single component owned the rate limit, and throttling surfaced as scattered errors after the fact. Moving every write to one consumer made the ceiling visible and manageable — per-tenant rate limiting, the delay queue, robot alerts on throttle responses — and turned a recurring incident source into a scheduling parameter. The system held it: ~30,000 tenants, ~6M live codes among heavy users, several hundred scans per second in short campaign spikes, with peak-day volume under a million.

One dependency more than before. Kafka availability now gates membership updates. The failure mode is benign in the interesting direction — if the queue stalls, updates are delayed, not misapplied; scans continue against the last consistent list, which is the pre-refactor behavior only without the corruption. The stricter cost is operational: a second system to monitor, and a class of bugs (poison messages, lag) that MongoDB-only code never had.

The clearest evidence was not a metric. The churned account came back: after living with the refactored system, they re-subscribed — the recovery I weigh most, because a customer who has lost technical trust does not return for a discount. Several other affected accounts renewed with the fix in place. The feature rose to the most-active tier of the marketing product line, and the work received the company's quarterly owner award (2023 Q1).

None of these numbers came from a load test; they are the production envelope the system ran at. The proof the refactor worked is the complaint record, not a benchmark. I leave the incident account's campaign loss unquantified on purpose: it is the customer's data, not ours to publish — the churn itself, and the re-subscription, carry the argument.

## What I would keep, and what I left open

The part I would keep unchanged is the central decision: one serialized queue for every membership-changing event, keyed by tenant, applying to WeCom first and our store second. The alternatives I evaluated — per-code sharding, a state CRDT, read-side filtering — either reintroduce multiple writers or assume a write path we do not control.

The production surprise was how much of the work was not the queue. The serialization itself was not the hard part; living with WeCom's rate limits — the per-tenant limiter, the delay queue, the cleanup-on-error semantics — was the long tail. If I scoped this again, I would budget the dependency's shape, not just our own components, and I would size the rate window and the delay queue's drain rate from the fan-out arithmetic — how many live codes a member sits on — rather than from event rate, which understates the calls by exactly that factor. I would also coalesce per code on purpose: the push replaces the whole list, so several events for one code inside a window end in one call, and merging them costs nothing.

Reconciliation is the part I left open. The rejected sweep was right about the need and wrong about the shape: the queue guarantees one writer and a fresh read, not correctness of the outcome — a bug in the recompute logic is applied just as consistently by a serialized queue — but 6M codes at API rate limits is days of work to protect a handful of suspects. The backstop should be a dirty set: codes whose events were dropped, whose push failed permanently, or whose recompute surfaced an error, swept at low frequency in minutes while the rest of the estate is left alone. We had no such layer and relied on customer complaints instead. That was the wrong instrument, and on a system this size, "customers have stopped complaining" was weaker evidence than the system deserved.

One boundary still stands: the assignment lives in someone else's config, and no architecture inside our perimeter makes that partner synchronous with us. What the design can do is keep the delay across that boundary bounded and visible.
