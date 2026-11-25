---
title: "Cutting Firestore Reads 58% by Moving a Scan off the Request Path"
date: 2026-11-25 10:00:00
categories:
  - Engineering Case Study
tags:
  - go
  - firestore
  - redis
  - elasticsearch
  - rate-limiting
  - cost-optimization
description: "A Firestore fallback query ran on every task creation: 347,901 executions and 31.6M read operations in 22 hours for 0.011 documents per run. A rate-limited Redis queue cut both by 58%."
seo_image: cover.png
---

Firestore's [Query Insights](https://cloud.google.com/firestore/docs/query-insights) view, sorted by read operations, put one query shape at the top for the task collection: `account_no = ? AND status_desc IN [?]`. Over 22 hours it ran 347,901 times, cost 31.6 million read operations (Firestore's billing unit, explained below), and returned 0.011 documents per execution at 2.7 seconds each. It was the fallback step of a scan that ran whenever a user created a task and had not created one in the previous five minutes.

<!-- more -->

{% asset_img cover.png One Firestore query shape before and after the change, both 22-hour windows: read operations 31.6M to 13.2M, executions 347,901 to 151,503, after the scan moved into a rate-limited queue %}

## Where the reads came from

The scan existed to recycle tasks parked in `waiting` or `processing` by a dead worker, and the cheapest moment to notice was the same user's next creation. On creation, the API server spawned a goroutine that asked Elasticsearch for the identity's task IDs in those two states, fetched the records from Firestore with a batched get, revalidated the statuses, and cancelled anything past its timeout. If Elasticsearch returned nothing or any step errored, it fell back to a Firestore query on the collection filtered by identity and status, with no limit. A five-minute `SET NX` key per identity kept two creations from triggering the same scan.

Executions tracked task-creation traffic: one scan per creation, minus dedup hits. Firestore bills a query for what it reads to satisfy it: one read per document returned, and one read operation per batch of up to 1,000 index entries scanned ([pricing](https://cloud.google.com/firestore/pricing)). Per execution, the Firestore fallback dominated because its cost sat in the index entries, not the documents. Query Insights reported 91,334 index entries read per execution against 0.011 documents returned; 347,901 × 91,334 / 1,000 is 31.8 million, within about half a percent of the 31.6 million in the table. Document reads for the whole window were about 3,800.

The expensive branch was also the common one. Most identities have no stuck task, so Elasticsearch returned empty, which is what triggered the fallback; the fallback then scanned the status index across the whole collection and returned nothing. Removing the Elasticsearch step would not have changed the bill; the cost sat in the Firestore query.

{% asset_img query-insights-before.png Firestore Query Insights before the change, sorted by read operations: the account-shaped status query ran 347,901 times with 31,610,090 read operations, 91,334 index entries and 0.011 documents per execution, at 2,712 ms average latency. %}

## Moving the schedule out of the request path

Even with the fallback restricted to errors, one scan per creation still put an Elasticsearch query and a Firestore batched get on the request path at creation rate, and the five-minute window let a busy identity be scanned up to 288 times a day.

Rescanning every identity that ever created a task on a schedule would have closed the one gap in scanning only on creation, the dependency on the user coming back, but it runs more queries than scanning on creation, the opposite of the goal. That gap is left to the run queue's own timeout collection.

The request now only decides that the identity should be checked: it enqueues the identity and returns, and a cron-driven consumer decides when the check runs and caps how many run per second. The queue is a Redis sorted set plus one dedup key per identity.

### Enqueue

Queue members are `a:<account>` or `d:<device>`, and the score is the earliest moment the member may be scanned; it is set to the enqueue time, so the next round can claim it. The dedup key lives for 30 minutes, up from five. One Lua script does the capacity check, the dedup, and the insert:

```lua
-- KEYS[1] = dedup key for this identity   KEYS[2] = pending set
-- ARGV[1] = dedup TTL (ms)   ARGV[2] = score (ms)   ARGV[3] = set TTL (s)
-- ARGV[4] = member           ARGV[5] = max members
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then
  return -1
end
if redis.call('SET', KEYS[1], '1', 'NX', 'PX', ARGV[1]) == false then
  return 0
end
redis.call('ZADD', KEYS[2], 'GT', ARGV[2], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
```

The script has to be one step: as two round trips, a failure after `SET NX` but before `ZADD` leaves the dedup key set with nothing in the queue, and the identity is not scanned for a whole window; in the other order, a failure duplicates the member.

The capacity check runs before the dedup so that a full queue drops the enqueue without locking the identity out: the key is only set once the member is in the queue. `ZADD GT` keeps a later enqueue from pulling a queued identity forward. Both keys carry the same [hash tag](https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/) (`{scan}`), which keeps the script valid on Redis Cluster, where a script may only touch keys in one slot.

The script returns 1 for a new member, 0 for a dedup hit, and -1 for a dropped enqueue, logged at different levels because a new member is rare and a dedup hit is the steady state.

### Claim

Every consumer instance runs the cron every 10 seconds. Claiming is a second script:

```lua
-- KEYS[1] = pending set
-- ARGV[1] = now (ms)   ARGV[2] = limit   ARGV[3] = lease until (ms)
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
for _, member in ipairs(due) do
  redis.call('ZADD', KEYS[1], ARGV[3], member)
end
return due
```

`ZRANGEBYSCORE` then a separate `ZADD` would let two pods read the same due members before either writes a lease. The lease moves each claimed member's score two minutes ahead, so the next claim skips it; a consumer that dies mid-scan leaves the member to be re-claimed once it expires.

### Consume

Each round claims at most 20 identities and scans four at a time. Twenty per 10 seconds caps the deployment at two scans per second regardless of creation traffic; the four workers shorten the round without moving the ceiling. Three deferred calls wrap every scan:

```go
defer func() { <-sem; wg.Done() }()            // runs last: release the slot
defer func() { svc.dequeue(member) }()          // runs even when the scan panics
defer func() {
    if r := recover(); r != nil {
        panicked.Add(1)
        logger.Error(context.Background(), fmt.Errorf("panic: %v", r), "scan panic")
    }
}()
```

The dequeue is unconditional. A member left in the set after a panic is re-claimed when the lease expires and panics again, and a recurring cause turns that into an unbounded retry loop paid for by the consumer. The same holds for a scan that fails without a panic, on a resolve error or the 10-second timeout: it is dequeued, not retried, and the identity re-enters the queue only on a later creation once the dedup key has expired. The per-identity context times out at 10 seconds, far below the two-minute lease, so a slow scan cannot overlap a second claim of the same member.

The round itself is guarded by a per-instance `TryLock`. The semaphore bounds in-flight scans but not rounds: when Elasticsearch or Firestore slows down, each tick would claim another batch and park its goroutines on the semaphore, 20 per tick, until memory ran out. The lock turns a slow downstream into skipped ticks. Every round logs a summary: scans, dequeues, queue depth, hit rate, failure rate, duration.

Queue depth is reported as -1 when Redis cannot be read, never 0, because a 0 reads as "nothing left to do" and turns a Redis problem into an apparently idle consumer. The idle round logs a heartbeat as well; without it, an empty queue and a cron that never registered leave the same silence.

The set has a hard cap of 20,000 members and expires after six hours. At two per second a full queue drains in about 2.8 hours; past the cap, enqueues are dropped with a warning, and a backlog above 5,000 is warned about as well. Drops are acceptable because this scan is the fallback recycling channel. Progress polling when a user returns and the run queue's own timeout collection carry the primary load.

## Trimming what a scan touches

Rate limiting bounds how often the scan runs. Four smaller changes trim what one scan touches; the Firestore fallback's cost per scan is not among them.

Elasticsearch now receives the identity as routing. The task index is written with the account as its routing key, so the search hits one shard instead of every shard. Guest documents are indexed under a fixed default routing value, and the guest query mirrors that.

For account identities, an empty Elasticsearch result is now the answer: the index is routed by account and complete for accounts, so no candidate IDs means no active task, and the fallback runs only on an error. Guest identities keep the fallback on empty, because historical guest documents were indexed without the device field and their query cannot see older tasks. The cost is a dependency on the index: a task missing from Elasticsearch is not recycled by this scan. The primary channels do not read the index, so the dependency stays inside the fallback's remit.

The fallback query gets a limit of 100 documents. Its filter targets one identity, whose active tasks are normally single digits; the limit only matters when one identity has piled up stuck tasks, where reading the whole pile is the wrong response anyway.

The old in-path dedup key is gone. Left in place, it would have blocked the consumer's first scan of an identity right after a creation, because the key was set by the very request that enqueued it.

## Result

{% asset_img query-insights-after.png Firestore Query Insights after the change: the same account-shaped status query ran 151,503 times with 13,216,491 read operations, 87,711 index entries and 0.009 documents per execution, at 3,032 ms average latency. %}

| | Before | After |
|---|---|---|
| Executions | 347,901 | 151,503 |
| Read operations | 31,610,090 | 13,216,491 |
| Index entries read per execution | 91,334 | 87,711 |
| Documents returned per execution | 0.011 | 0.009 |
| Average latency | 2,712 ms | 3,032 ms |

Executions fell 56 percent and read operations 58 percent. Index entries per execution moved four percent: the change never touched the index, and the saving came from running the query less often, not from making it cheaper. The table cannot separate the queue from the fallback policy, since both show up as fewer executions of this shape; routing and the limit do not appear in it at all, because they change Elasticsearch work and the worst-case document read, not index entries. Average latency rose twelve percent; the change did not touch the query, and the cause was not investigated.

Both captures span 22 hours; the after one was taken a day after the rollout. Executions fell from 4.4 to 1.9 per second, within five percent of the ceiling of two, so read operations from this path are now bounded by that ceiling rather than by creation traffic.

At the published us-central1 Standard rate of $0.03 per 100,000 reads, the 18.4 million reads saved per window come to roughly $180 a month if the windows are typical. That is a small bill. The reason to move the scan was the shape of this cost, not its size: it grew with creation traffic and sat on the request path.

The queue, the longer dedup window, routing, the fallback policy, and the limit shipped together, so the share of each is not measured.

The cost is latency. A stuck task used to be noticed within seconds of the user's next creation; it is now noticed within 30 minutes plus queue wait, up to about 2.8 hours behind a full queue, which is acceptable for a channel that exists for users who never return.

## What this does not fix

One execution still reads about 88,000 index entries and takes three seconds to return 0.009 documents. Nothing in this change addressed that, and at the ceiling it is the remaining cost: the 13 million read operations in the after window. The next lever is the query itself. The likely fix is a composite index that lets Firestore seek by identity instead of scanning the status index, but that is a hypothesis; [Query Explain](https://cloud.google.com/firestore/docs/query-explain) shows which index serves the query and whether index entries are billed, so it decides whether the hypothesis holds before any index is changed.

---

*Previous in this series: [Migrating a Billion Elasticsearch Documents Without Stopping Writes](/posts/engineering-case-study/migrating-a-billion-elasticsearch-documents-without-stopping-writes/)*.
