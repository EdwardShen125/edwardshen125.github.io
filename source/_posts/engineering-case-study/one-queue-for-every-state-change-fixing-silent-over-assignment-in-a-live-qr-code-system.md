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
description: A live QR code system kept sending customers to offline or over-quota salespeople. One Kafka queue, keyed per QR code, serialized every update to WeCom's routing config.
seo_image: architecture.png
---

The escalation arrived as a refund threat. A customer had run a campaign, and thousands of people scanned its QR codes that day expecting to reach the sales team. One salesperson on the code had already hit his daily quota — the system showed him offline for assignment — and every new scan still connected to him. The rotation to the next salesperson never fired. The campaign closed far below target, the customer demanded a refund, then churned: a six-figure annual contract. The same mis-assignment had been producing quieter tickets for months. Nothing in the logic was wrong. The list was. Campaign day is when scans, quota exhaustion and staff status changes all peak in the same minutes.

<!-- more -->

A live QR code is printed once and keeps working while the people behind it change. The customer scans in [WeChat](https://www.wechat.com/), [WeCom](https://www.wecom.com/) routes to whoever the code currently lists, and we maintain that list. At 30,000 tenants with 10 to 20 staff on a QR code, most of them sat idle until a campaign woke them for days or weeks.

I owned this system — took it over as it stood. Tickets came in two shapes and said the same thing: staff shown offline still receiving scans, staff over quota still receiving scans. Our view of who should get customers had stopped matching who actually did.

## The routing was never ours

WeCom owns the part that connects people. Tencent's enterprise messenger matches each scan to a [contact-way configuration](https://developer.work.weixin.qq.com/document/path/92228) on its side and opens the chat with whoever that config lists. Our platform never sees the scan that opens the chat. So assignment, for us, meant one thing: maintaining that config. Deciding which staff IDs belong in it, and pushing every change through WeCom's API — add a person, remove a person.

Two stores had to agree. Our staff state lived in [MongoDB](https://www.mongodb.com/): who is online, who is on duty, who is under quota, per tenant. WeCom's config decided where customers actually went. When they drifted apart, nothing raised an error. The drift just ran in production, and scans landed on someone we had marked offline an hour earlier. Repairing it was not free either. The fix was a rate-limited API call that occasionally fails, so the last mile carried failure modes of its own.

The QR codes came in two families. Native codes handed member selection to WeCom's random assignment, and our only job was who appeared in the config. Sequenced and quota codes ran on our own landing page, so we decided the order and the per-person volume as well. That is where the offline and quota checks bit hardest: a rotation that never happens is a list that never got updated.

## Two years of features, six writers

Before I took over, feature work had put this state together piece by piece:

- State split across many collections. Online/offline flags (an admin endpoint, work-schedule timers), the per-staff-per-code ceiling records, the "already removed today" marker, and the counts that decided who was full — all in MongoDB, incremented by `$inc` on each scan callback. Four switches per code — offline check, add limit, daily limit, round limit — plus a company-wide daily total decided how those numbers were applied.
- Many paths wrote it. The scan callback, the admin offline endpoint, the quota counters, work-hours jobs, resignation handlers, org-change events. Each pushed its own update toward WeCom when it decided the list should change: inline, with its own retry, at its own moment.
- One slice already had a queue. Sequenced and quota codes used a [Redis ZSET](https://redis.io/docs/latest/develop/data-types/sorted-sets/) with a two-level cursor, built by a teammate in 2021. Staff state-change events went through [Kafka](https://kafka.apache.org/) to a consumer that adjusted the set accordingly — a full recompute of the online list on edits and shift changes, adding a returning member, deleting one who left or hit quota; scans read the set through [Lua](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/). But every one of those paths went through the same consumer, asynchronously, and a full rebuild meant deleting and recreating the whole key. Between "staff hit quota" and "set rebuilt without him", scans kept drawing the old membership.

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

Taken one at a time, each of those paths was doing something sensible. The bug was not in any of them. **The same state had many concurrent writers, and each writer pushed a list computed from a partial view.**

Quiet days hid it: the races usually won. Campaign day removed the margin, because scan volume and status changes peaked in the same minutes, exactly when the gap between "state says stop" and "WeCom config says go" was widest.

Both failure modes had been reaching support for months, as rare tickets. Each was reproducible only under load, so each got chased as a possible logic bug and closed when no code defect turned up. It took the churn to name the pattern for what it was: a consistency defect, not coding errors.

## Three fixes that should have worked

Once the defect was named — state and routing config drifting apart — three fixes suggested themselves. Each one fails on a structural fact, not on implementation effort.

**Check at scan time.** Intercept the scan, read staff state, route around anyone offline or over quota. For native QR codes this is impossible in principle: the scan goes from WeChat to WeCom and never touches our platform, so there is nothing to intercept. Sequenced and quota codes do pass through our landing page, so the check was possible there — but it failed twice over. It put a database read on every scan of the hottest path we had, and it read the same state that the concurrent writers were updating, so the check itself could see a stale view and pass the very person it was meant to skip.

**Sweep and repair.** A periodic job that walks every QR code, compares our state against WeCom's config, and pushes a repair where they disagree. As a safety net this is the right shape, and it stayed on the list for later. As the primary fix it fails on arithmetic: 6M QR codes against WeCom's rate limits is days per sweep, so a staff member marked offline on campaign morning keeps receiving customers until the sweep reaches his codes. This failure appears in minutes and has to be corrected in seconds. A sweep that takes days can only fix the slow kind of drift.

**Better retries on every writer.** Make every write path idempotent, add exponential backoff, let each writer retry until it lands. This is the status quo with more machinery. A retry makes one write more likely to succeed; it says nothing about two writers computing from different snapshots. Writer A reads the state, writer B reads the state, both push a list — and whichever lands second overwrites the other's change with a list computed before it. Nothing failed and nothing was lost. Both writes succeeded, each carrying a list that was already stale. The defect was order, and retries do not order anything.

All three treated the symptom where it surfaced: at the scan, in the drift, on the failing call. The alternative was to remove the multiple writers — one serialized place where every membership-changing decision is made against current state.

## One writer, recomputing

{% asset_img architecture.png "One queue serializes every membership-changing event: sources feed a Kafka topic keyed by QR code ID; a serial consumer recomputes members, pushes WeCom's contact-way config first, then writes back to MongoDB and rebuilds the Redis assignment set. The scan path never passes through our platform." %}

I put one Kafka queue between "state changed" and "WeCom config changed". Every event that can alter a QR code's membership goes to one topic, keyed by the QR code's own ID: an addition, a status flip, a schedule transition, a resignation, an org change, a config edit. A consumer group works through them. For each affected code it recomputes the eligible members from current state, using the same four switches each old writer had checked on its own. It pushes that update to WeCom, and only then writes the result back to our store. The order matters. WeCom is where routing happens, so it gets the correct list first, and our store records what was pushed rather than what was intended.

The state has to move before the event does. The counter that decides who is full is a MongoDB document per staff member and code, incremented by `$inc`. The consumer handling WeCom's customer-added callback increments it while it handles the addition, before it publishes the refresh. By the time the refresh runs, the count is current, and the event never has to carry a number anyone has to trust. Every other trigger follows the same rule. The admin endpoint, the work-hours timer, the resignation and org-change handlers write the flag or the counter where the business event happens, then emit the refresh. The queue carries a reason to recompute, not the state to apply.

Sequenced and quota codes still rotate on Redis, through the same ZSET and two-level cursor, but the two families now share one writer. For either family, the refresh consumer recomputes the eligible members from the counts and flags as they stand, pushes the WeCom list, then updates the assignment set — both routing targets, the config WeCom reads and the set our landing page draws from, come out of one computation, in one serial order. Before, each had its own writer at its own moment; the family split is where the old race lived.

Serialization comes from the key. Events are keyed by the QR code's ID, and the consumer routes each key to a fixed goroutine, so one code's events apply one at a time while codes proceed in parallel. The key's granularity matches the problem: what needs ordering is a single code's member list, and nothing else shares it. The shared eventbus client we extended supplies that per-key mode, along with the retry path below.

The quota loop closes on the same queue, and it is where the load comes from. A scan callback increments a staff member's counter past the ceiling. The handler marks the ceiling document with an idempotent "already removed today" flag, notifies the admin, looks up every code that staff member sits on, and emits one membership event per QR code. Dozens of codes, sometimes more than a hundred. One removal becomes that many WeCom pushes, and campaign day concentrates both the removals and the codes.

Migration ran as double-write through the second half of 2022 and cut over in early 2023. The new event chain went live while the old synchronous paths kept running; weeks of both writing proved the output matched. A config switch then retired the old paths. Tenant traffic did not notice.

## What the constraints forced

Rate pressure and business freshness are two problems, and the design keeps them apart.

The lane a code runs in is a business decision. The tenant's tier, how fresh that code's membership has to be, and an operator's switch decide whether its updates go out as they arrive or on a slower cadence. I kept that decision as a mark per QR code in Redis, alongside the assignment set, rather than as state inside the consumer. After a rebalance the code's key lands on another instance, and that instance has to make the same routing call. So every event starts on the fast topic, where the consumer reads the mark first. A code already on slow is republished to the slow topic without a call.

Only the lane holding the code writes the mark. The fast consumer sets it, at the head of the tenant's serial stream, when policy says slow, then republishes. The slow consumer clears it when policy sends the code back to fast and its own work is done. A QR code changes lanes only from the lane that holds it, which per-event routing would not give you. The next event could run fast while an older one was still queued for slow, and the code would have two owners.

The vendor's rate limit is handled optimistically, on the call path. Before calling WeCom, the handler makes two checks. The first is dedupe: compare the list just recomputed with the last list pushed for that code, and if they match there is nothing to send. That does not shrink the fan-out; ten QR codes with ten different lists are ten real pushes. It removes the no-ops, like a retry, a scan that changes no membership, an edit that resolves to what is already there.

The second check is the tenant's pre-limiter: a [token bucket](https://en.wikipedia.org/wiki/Token_bucket) in Redis, spent through a Lua script so every instance counts against one window. With a token, push. Without one, the handler does not wait and does not hold the message open while the window refills: it acknowledges the event as not-done, and the eventbus redelivers it — behind whatever that code's stream processed meanwhile, under the same key, through the same two checks. No second writer, and no consumer goroutine parked mid-message.

Slow is a topic of its own, not a branch inside a handler. Routing an event to slow means republishing it there, and a slow consumer waiting between pushes parks only that tenant's stream on the slow topic, while the fast topic keeps moving. The cadence comes from the business decision, not the limiter: the consumer waits its interval before each push, and the dedupe check runs there unchanged. Both lanes draw on the same tenant's rate window — ordering is per code, but the vendor's quota is not — so a QR code on slow still competes with that tenant's fast work for the [vendor's limit](https://developer.work.weixin.qq.com/document/path/90312). What it gets is fewer attempts, not a budget of its own.

Lane changes were not tracked per code beyond the priority decision on each event. A QR code can spend a while on the slow cadence after a burst, or see one more slow-paced push after policy has already said fast. That is a bounded, low-frequency window of extra delay on codes whose membership is not changing — not a second writer, and not divergence. The list converges: the next event recomputes from current state on whichever lane it takes, and both lanes push the same single-writer computation. I accepted brief staleness on quiet codes in exchange for not maintaining per-code lane bookkeeping that itself needed to be kept consistent.

Failures do not hold the code's stream. A failed call is reported as not-done and redelivered by the eventbus under the same key, instead of being left unacknowledged while the consumer backs off. The retry re-enters that code's serial stream behind whatever arrived meanwhile. Holding the offset would be the obvious choice and the wrong one even at code granularity: a failing call with retry storms can pin a partition, and the codes sharing that partition — up to the whole tenant, under a busy campaign — wait behind it. Ack and redeliver keeps the blast radius at one code. WeCom's errors are specific enough to act on, too: a QR code deleted on their side returns a distinct error, which the consumer treats as a cleanup trigger instead of a retry-forever case.

Requeueing gives up publish order. Dropping gives up the message once its timestamp is a day old. Neither matters, because every handler recomputes at processing time. A late trigger reaches the same current truth as a new one, and a dropped event loses nothing, since the next event on that code recomputes from current state. What the design needs is one writer per code, not arrival order, and the per-key serial mode plus the mark provide it. The residual is a code no later event touches, where staff went offline during a multi-hour backlog and nothing followed, so the stale list stays. Campaign codes are never idle that long, which is why the rule held in practice. That is an assumption about traffic, not a guarantee about state.

## What it cost, and what it bought

Agreement between our state and WeCom's config, at three prices.

Freshness became bounded. Seconds on the fast lane, the slow lane's cadence, or the delay queue's due time, never the instant of an inline write. After cutover: p95 from event to WeCom's config under five seconds, and six consecutive months without one ticket for either failure mode, against at least three a month before.

WeCom's API became the ceiling, in plain sight. Under the multi-writer design nobody owned the rate limit; throttling showed up as scattered errors after the fact. One consumer made the ceiling visible and manageable, with per-tenant rate limiting, the delay queue, and robot alerts on throttle responses, and turned a recurring incident source into a scheduling parameter. The system held it: around 30,000 tenants, around 6M live codes among heavy users, several hundred scans per second in short campaign spikes, peak-day volume under a million.

One dependency more than before. Kafka availability now gates membership updates. The failure mode is benign in the interesting direction: if the queue stalls, updates are delayed rather than misapplied, and scans run against the last consistent list. The real cost is operational. A second system to monitor, plus [poison messages](https://en.wikipedia.org/wiki/Poison_message) and lag, a class of bug MongoDB-only code never had.

The churned account came back. After running on the refactored system for a while, they re-subscribed. A customer who has lost technical trust does not return for a discount.

These are production numbers, not a load test, and the complaint record is the proof. I leave the incident account's campaign loss unquantified on purpose: it is the customer's data, not ours to publish. The churn and the re-subscription carry that part of the argument.

## What I would keep, and what I left open

I would keep the central decision: one serialized queue, keyed by the QR code, applying to WeCom first and our store second. The alternatives I looked at, per-code sharding, a [state CRDT](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type), read-side filtering, either bring the multiple writers back or assume a write path we do not control.

The production surprise was how much of the work was not the queue. Serialization was the easy part. Living with WeCom's rate limits, meaning the limiter, the delay queue and the cleanup-on-error semantics, was the long tail. Scoped again, I would budget the dependency's shape and not just our own components, and size the rate window and the drain rate from the fan-out arithmetic, how many live codes a member sits on, rather than the event rate, which understates calls by that factor. I would also coalesce per QR code: the push replaces the whole list, so several events for one QR code in a window can end as one call.

Reconciliation is the part I never closed. The rejected sweep was right about the need and wrong about the shape. The queue guarantees a fresh read, not a correct outcome; a bug in the recompute gets applied just as consistently. But 6M QR codes at API rate limits is days of work to protect a handful of suspects. The backstop should be a dirty set, holding codes whose events were dropped, whose push failed permanently, or whose recompute errored, swept at low frequency. We had no such layer and relied on customer complaints instead, which on a system this size was weaker evidence than it deserved.

One boundary still stands. The assignment lives in someone else's config, and no architecture inside our perimeter makes that partner synchronous with us. What the design can do is keep the delay across that boundary bounded and visible.

---

*Previous in this series: [Running a Million-DAU Casual Game on Go: Rooms as the Concurrency Boundary](/posts/engineering-case-study/running-a-million-dau-casual-game-on-go-rooms-as-the-concurrency-boundary/).*
*Next in this series: [Debugging a Sporadic Go OOM in a Recursive JSON Encode Path](/posts/engineering-case-study/debugging-a-sporadic-go-oom-in-a-recursive-json-encode-path/).*
