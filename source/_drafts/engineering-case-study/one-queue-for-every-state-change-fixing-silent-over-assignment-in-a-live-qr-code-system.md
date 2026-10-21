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
description: A WeCom live QR code system kept assigning customers to staff who were offline or over quota — the assignment itself lived in WeCom's config, not ours. Routing every membership-changing event through one Kafka queue made state and assignment agree again.
seo_image: one-queue-for-every-state-change.png
---

The escalation arrived as a refund threat. A customer had run a marketing campaign: thousands of end users scanned the customer's QR codes that day, expecting to reach the sales team. One salesperson on the code had already hit his daily assignment quota — the system showed him offline for assignment — yet every new scan still connected to him, and the rotation to the next salesperson never happened. A single salesperson can hold a bounded number of conversations; the overflow left customers waiting until they gave up. The campaign closed far below its target, and the refund demand followed. That one campaign was not the whole story, though: the same mis-assignment had been surfacing on this account for months — quieter incidents, support round-trips, promises that it was fixed. What the campaign day did was concentrate the damage enough to end the relationship: the customer lost money on the activity, then lost trust that the platform could run one at all. They churned, and their annual contract value had six figures in it.

This was the live QR code system of a WeCom SCRM platform — the marketing core of the product. A live QR code ("live" because the people behind it can change without reprinting) routes each scan to one of several salespeople configured on it. We served about 30,000 tenants; roughly 20% were heavy users with around 1,000 codes each, and each code carried 10 to 20 assignable staff. Most of those codes existed quietly on printed material. The traffic that mattered arrived in bursts: campaign codes created for an activity, scanned heavily for days or weeks, then abandoned. Campaign day was when scan volume, quota exhaustion, and staff status changes all peaked together.

I owned this system, and the complaint pattern — staff shown offline still receiving customers, staff over quota still receiving customers — pointed at one class of defect: the system's view of who should receive customers had stopped matching who actually received them. This article is about why that gap existed, what it cost to close, and what I would do differently.

<!-- more -->

## Who actually owns the assignment

The first thing to understand about this system is that the assignment does not run in it. WeCom — Tencent's enterprise messenger — owns the connection mechanics. A customer scans the code in WeChat; WeCom matches the scan to a "contact way" configuration on its side and opens the conversation with whichever staff that configuration lists. Our platform never sees the scan. What we call assignment is really the maintenance of WeCom's contact-way configuration: deciding, at every moment, which staff IDs that config should contain, and pushing changes through WeCom's API — adding a person, removing a person.

That inversion shapes everything. Consistency is not a property of one database. It is the agreement between two of them: our staff-state view (online, on duty, under quota — stored in our MongoDB per tenant) and WeCom's contact-way config (the thing that actually routes customers). When they diverge, the divergence executes in production: scans keep landing on the person we long since marked offline. And the fix for divergence is itself a distributed write — a call to WeCom's API, rate-limited, occasionally flaky — so the last mile to consistency has its own failure modes.

Two families of codes shared this machinery. Native codes delegate member selection entirely to WeCom's own random assignment; our job there is only who is on the list. Sequenced and quota codes, built on our own landing page, additionally decide the order and the per-person volume — which is where the offline and quota checks bite hardest, because a rotation that never happens is exactly a list that never got updated.

## The old system: many writers, no order

The pre-refactor state, assembled from many features added over two years, looked like this:

- Staff state lived in several places. An online/offline flag per staff (set by an admin HTTP endpoint, or by work-schedule timers), a ceiling document per staff per code counting today's assignments, a company-wide daily total, and four independent config switches on each code (offline check, add limit, daily limit, round limit). All in per-tenant MongoDB.
- Many code paths wrote or acted on this state. The scan callback (WeCom notifies us a customer was added), the admin endpoints for going offline, the quota counters incremented from the callback path, scheduled jobs for work hours, staff resignation handlers, org-structure change events. Each one, when it decided the membership list should change, pushed its own update toward WeCom — inline, with its own retry, at its own moment.
- A pre-existing queue covered one slice. Sequenced/quota codes had a Redis ZSET-based assignment queue with a two-level cursor (built by a teammate in 2021): state-change events went through Kafka to a consumer that recomputed the online list and rebuilt the ZSET, while scans consumed from it via Lua. But the rebuild was a delete-and-recreate of the whole key, and the events it consumed were asynchronous — between "staff hit quota" and "queue rebuilt without him", scans kept drawing from the old membership.

No single one of these was "the bug". The defect was structural: **the same state had many concurrent writers with no agreed order**. A scan-callback incrementing the quota counter, an admin marking the staff offline, a scheduled rotation, a resignation event — each racing toward WeCom's config with a partial view. On a quiet day the races rarely lost. On campaign day, scan volume and status-change volume peaked in the same minutes, exactly when the sequencing gap between "state says stop" and "WeCom config says go" was most likely to be hit — and most expensive. The customer's campaign was the load profile this architecture could not survive.

The refund-scale complaint was not the first signal, either. Support tickets had trickle-reported both failure modes — offline-still-assigning and over-quota-still-assigning — for a while. They were individually rare, reproducible only under concurrent load, and each had been chased as a would-be logic bug before the pattern became clear: this was a consistency defect, not a coding error.

## Options considered

Three designs were considered before the queue.

Check at scan time. Intercept the scan, query staff state, pick someone else if the designated staff is offline or full. Rejected as structurally impossible for native codes: the scan never passes through us, so there is nothing to intercept. For sequenced/quota codes it was possible — but it re-introduced the very race it was meant to fix (the check and WeCom's routing are still two systems) and it put a per-scan database dependency on the hottest path we had.

Periodic reconciliation. A job that walks every code, compares our state against WeCom's config, and repairs drift. Attractive as a safety net, rejected as the primary mechanism: with 6M codes and WeCom's API rate limits, a full sweep measured in days, not seconds — a staff member marked offline on campaign morning would keep receiving customers through the whole sweep window. Reconciliation could catch chronic drift; it could not meet the freshness the failure mode demanded.

Keep the multi-writer shape, add better retries. Each writer path gets idempotent calls, backoff, the works. This was the status quo with more machinery: retries make each write more reliable, but reliability of individual writes does not order them. Two writers with correct retries can still apply their updates out of order, and the last-writer-wins result is the wrong list. The failure was never a lost update; it was an unordered one.

What all three shared was treating the symptom at the point of divergence. The alternative was to remove the divergence's cause: make every membership-changing decision flow through one ordered place, so that by the time any update is applied, it reflects every state change that came before it.

## One queue for every membership-changing event

The refactor put a single Kafka queue between "state changed" and "WeCom config changed". Every event that can alter a code's membership — a customer added (quota counters move), a staff member going offline or coming back, work schedule transitions, resignations, org-structure changes, the code's own configuration being edited — is published to one topic, keyed by tenant ID. A consumer group processes these events: for each affected code, it recomputes the eligible member list from current state, pushes the update to WeCom (remove the exhausted staff, add the returning one), and only then writes the result back to our own store. Order of operations matters here: WeCom is the source of routing truth, so it gets the correct list first; our store records what was pushed, not what was intended.

Ordering comes from the key. Messages are keyed by tenant, and the consumer routes each key to a fixed goroutine — within one tenant, events apply in publish order; across tenants, they process in parallel. The eventbus client beneath this (a shared-golib library we also evolved for this need) adds a strict-serial mode with a Redis-backed retry queue: when a message fails, subsequent messages for the same key block until it succeeds, so a transient WeCom API error delays one tenant rather than corrupting the order. Failures retry with a bounded count; messages carry a timestamp and are dropped after a day, so a backlog cannot silently apply yesterday's membership decisions today.

The quota loop closes on the same queue. When a scan callback increments a staff member's counter past the configured ceiling, the handler marks the ceiling document (an idempotent "already removed today" flag), notifies the admin, looks up every code that staff is on, and emits one membership event per code. Those events flow through the same single queue as everything else — the exhausted staff's removal from ten codes is ten ordered events, not ten racing writers.

Two properties of WeCom's API shaped the consumer's design beyond ordering. First, it is rate-limited, and the platform serves thousands of tenants concurrently — so the consumer carries per-tenant token-bucket rate limiting (an LRU of limiters in memory) rather than waiting to be throttled, and a fast/slow channel split: codes worth updating immediately (recently created, high-traffic) process on the fast path, the rest are requeued to a slow topic so a burst of events degrades into delay instead of into API errors. Second, its errors are meaningful — a code deleted on WeCom's side returns a specific error, which the consumer treats as a cleanup trigger rather than a retry-forever case.

Migration ran as double-write with a cutover switch, not a big-bang. The new event chain went live while the old synchronous paths still ran; weeks of both paths writing proved the new chain's output matched (and the code from that period still carries a comment marking where queueing replaced an inline call — a "TODO: put this into a queue — DONE" fossil). Then a config switch retired the old paths, tenant traffic unchanged from the user's point of view.

## What consistency costs

The queue bought agreement between our state and WeCom's config, at three costs worth stating plainly.

Freshness became bounded, not immediate. A staff member going offline now leaves the code within the queue's processing latency — seconds, comfortably inside the single-digit tolerance a scan-and-connect flow has, but no longer the theoretical instant of an inline write. In exchange, the update applies with every prior state change already accounted for. For this product, a consistently-correct list two seconds late beat an instantly-wrong one; the campaign-day failure was the wrong list, not the slow list.

WeCom's API became the explicit throughput ceiling. Under the multi-writer regime, API rate limits were everyone's problem and therefore no one's; throttling surfaced as scattered errors after the fact. Moving every write to one consumer made the ceiling visible and manageable — rate limiting per tenant, the fast/slow split, robot alerts on throttle responses. The system stopped fighting its dependency and started scheduling around it.

One dependency more than before. Kafka availability now gates membership updates. The failure mode is benign in the interesting direction — if the queue stalls, updates are delayed, not lost or reordered; scans continue against the last consistent list, which is the pre-refactor behavior only without the corruption. The stricter cost is operational: a second system to monitor, and a class of bugs (poison messages, lag) that MongoDB-only code never had.

## Results

The refactor shipped across the second half of 2022, with the cutover completing in early 2023.

- Both complaint classes stopped. Assignments to offline staff and to over-quota staff — the two failure modes behind the tickets, and behind the account's loss of trust — dropped to zero in customer support's tracking after cutover, and stayed at zero for as long as I remained at the company — through the following year's campaign seasons.
- The churned account came back. After living with the refactored system, they re-subscribed — the recovery I weigh most, because a customer who has lost technical trust does not return for a discount. Several other affected accounts renewed with the fix in place; the feature rose to the most-active tier of the marketing product line, and the work received the company's quarterly owner award (2023 Q1).
- The scale the design held at: ~30,000 tenants, ~6M live codes among heavy users, up to several hundred scans per second at campaign peaks, with peak-day scan volume under a million across the platform. The queue's steady-state lag stayed within the seconds-level freshness budget.

None of these numbers came from a load test; they are the production envelope the system ran at. The proof the refactor worked is the complaint record, not a benchmark. The incident account's campaign loss I leave unquantified on purpose: it is the customer's data, not ours to publish — the churn itself, and the re-subscription, carry the argument.

## What I would change today

The part I would keep unchanged is the central decision: one ordered queue for every membership-changing event, keyed by tenant, applying to WeCom first and our store second. Every alternative I can now construct — per-code sharding, a state CRDT, read-side filtering — either reintroduces multiple writers or assumes a write path we do not control.

The production surprise was how much of the work was not the queue. Getting ordering right was a week; living with WeCom's rate limits — the per-tenant limiter, the fast/slow split, the cleanup-on-error semantics — was the long tail. If I scoped this again, I would budget the dependency's shape, not just our own components, and I would not default to pushing every event type through the same fast path; the split should have been there from day one.

The honest gap is reconciliation. The rejected periodic sweep was right about one thing: the queue guarantees order, not correctness of the outcome — a bug in the recompute logic replays consistently through an ordered queue just fine. A low-frequency job comparing our store against WeCom's config would catch that class, and its slowness is acceptable precisely because it is the backstop, not the mechanism. We relied on customer complaints for that layer. That was the wrong instrument, and on a system this size, "customers have stopped complaining" was weaker evidence than the system deserved.

One boundary still stands: the assignment lives in someone else's config, and no architecture inside our perimeter makes that someone else synchronous with us. The whole design — the queue, the ordering, the rate shaping — is the machinery for being eventually consistent with a partner who does not share a transaction with you. Eventual, in exchange, can be made disciplined: ordered, bounded in delay, and observable in lag. That trade is what this system actually bought.
