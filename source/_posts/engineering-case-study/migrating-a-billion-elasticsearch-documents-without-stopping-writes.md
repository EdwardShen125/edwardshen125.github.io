---
title: Migrating a Billion Elasticsearch Documents Without Stopping Writes
date: 2026-11-08 10:00:00
categories:
  - Engineering Case Study
tags:
  - elasticsearch
  - go
  - data-platform
  - migration
  - cdc
  - distributed-systems
description: Migrating ~1B documents to a new Elasticsearch index without downtime — the mode switch, the resumable reindex runner, and the write-path decisions.
---

The platform's ~1B-document task index moved from one Elasticsearch data model to another — no downtime, no rollback, no user-visible incident. About four weeks of engineering; 1–3 hours of actual data movement. This is how it was done.

<!-- more -->

## Background: what tasks_v1 was doing wrong

`tasks` is the search index behind AI generation task lists — text-to-image, image editing, video generation, app tasks — queried per user as "my tasks, newest first." The access pattern is strictly per-account: a user only ever sees their own tasks, filtered by `account_no`, sorted by `create_at`.

At migration time the index held ~1B documents, 800 GB of primary storage, with data going back to March 2023 — about three and a half years of it.

v1 had been created without routing and without a sharding plan. Documents for one account were scattered across the whole index, so every task-list query fanned out to every shard. At small scale nobody noticed; at a billion documents the fan-out cost is structural — no amount of tuning removes a scatter that the data model requires.

{% asset_img scatter-vs-routing.png Left: tasks_v1 — one account's documents scattered by hash, every query fans out to all shards. Right: tasks_v2 — routing by account_no colocates an account on its two-shard routing partition; a query touches that partition instead of every shard. %}

The v2 target shape:

- 82 shards, [`_routing`](https://www.elastic.co/guide/en/elasticsearch/reference/current/mapping-routing-field.html) required, routed by `account_no` — an account's documents colocated on its routing partition, so a task-list query touches that partition instead of every shard
- `routing_partition_size: 2` — each partition is two shards, so a heavy account's write load cannot concentrate on a single shard
- an explicit mapping, replacing v1's accumulated dynamic one

Constraints: live business, no write downtime, no wrong query results, ~1B documents to move — every decision had to keep v1 serving while v2 came up behind it.

Two simpler approaches were ruled out. A maintenance-window cutover — stop writes, one big `_reindex`, flip — was rejected up front: the business would not accept a write outage. An alias flip after a single background reindex avoids the outage but not the tail: an alias can be switched atomically, yet the index behind it still converges only if something carries the writes that happened during the copy. Either way, the delta problem has to be solved — so the plan was a continuous CDC feed plus a controlled switch; the copy itself was the routine part.

## The switch: built before any data moved

Constraints: reads and writes had to switch separately — v2 becoming readable says nothing about every write path being able to target it. And at this point the direct write APIs did not yet carry the `account_no` routing contract — the guarantee that every write carries the field v2 routes by.

Decision: one global Redis key, `tasks:index:migration_mode`, three modes:

```
0  read v1   | direct writes → v1, CDC → v1+v2   (default, rollback-safe)
1  read v2   | direct writes → v1, CDC → v1+v2
2  read v2   | v2 only
```

{% asset_img migration-modes.png The three migration modes as a matrix of reads, direct writes, and CDC per mode, with rollback preconditions and the clamp guard that forces mode 0 until the routing contract exists. %}

The mechanism, piece by piece:

- A clamp function forces mode 0 unless the direct-write routing contract flag is enabled, so no Redis value can produce a read/write split.
- Redis errors and unparsable values fall back to mode 0 with a warning log; mode changes are logged once, on change.
- Rollback preconditions are written in the code comment next to the mode enum: 1 → 0 at any time (the v1 mirror is still fully written); 2 → rollback requires backfill, because v1 has stopped receiving direct writes.

Cost / not covered at landing: documents without an `account_no`. One fallback, `default_routing`, derived identically by CDC, by business-path deletes, and by the bootstrap — so a document lands on the same shard no matter which path wrote it. The first week after landing produced the first two patches: the CDC no-account fallback and v2 deletes on the business delete path. Contract coverage was confirmed path by path.

## The reindex runner

Start from the manual version, which was already in the runbook:

```
POST /_reindex?wait_for_completion=false&slices=2
{ "conflicts": "proceed",
  "source": { "index": "tasks_v1", "size": 1000 },
  "dest":   { "index": "tasks_v2", "op_type": "create" },
  "script": { /* routing = account_no, else default_routing */ } }
```

then poll the returned task id, then run monthly `date_histogram` aggregations on both indices and compare.

Why not one [`_reindex`](https://www.elastic.co/guide/en/elasticsearch/reference/current/docs-reindex.html) over the whole index and be done? Two mechanisms get in the way.

The first is correctness. `_reindex` copies a point-in-time snapshot: it scans the source once, and v1 was taking live writes the entire time. Documents created after the scan passed them by are simply absent from the copy; documents that changed after being copied land stale. Re-running with `op_type: create` picks up the late arrivals, but never repairs the stale ones — create skips existing documents. A bulk copy of a live index is a snapshot with a tail that a bigger scanner cannot close. This is why reindex was never the delivery mechanism here: it moves the bulk, CDC carries the delta, and the read switch is gated on CDC health — never on reindex completion.

{% asset_img bulk-vs-tail.png How _reindex works: it takes a point-in-time snapshot of the source and copies it batch by batch (scroll slices into bulk). Documents written after the snapshot edge are not in the scan; documents that changed after the scroll passed them are copied stale; create-only replays pick up late inserts but never repair stale copies. %}

The second is operational. The work unit would be ~1B documents, and an ES `_reindex` task that fails or gets cancelled resumes nothing — you restart the entire scan. There is no intermediate checkpoint where partial progress can be verified or resumed, so the first moment anything can be reconciled is after all of it finishes: all of the risk arrives at the end.

Monthly windows — 2023-03 through 2026-09 is roughly 43 of them — address the second problem. Each window can be replayed safely (`op_type: create` + `conflicts: proceed` make replays a no-op for existing documents), reconciled with a `date_histogram` diff, and signed off on its own. Bounded work, incremental verification, failure costs one window instead of the whole scan. They do not address the first — windows bound the bulk copy, CDC closes the tail, and CDC had been writing v2 since before any window ran.

But driving those windows by hand has its own failure surface: manual reconciliation for every window, an interruption restarts the month, and a lost task response means re-issuing the request blind. Hence the runner.

The runner is a single 894-line script — a resumable state machine. Each piece exists to prevent a specific failure:

- **Rerun safety.** Month windows as `[gte, lt)` half-open intervals, `op_type: create`, `conflicts: proceed`. Replaying a window is a no-op for documents that already exist, so "just run it again" is always safe.
- **Lost responses.** The checkpoint is persisted *before* each external action, not after. If the ES response is lost, the persisted state is `creating_unknown`; on restart the runner refuses to auto-resend and asks a human to check `_tasks` — because a blind resend is the one action that can double-execute.
- **Single ownership.** Lock + lease + owned writes: a SetNX token, release via Lua script so only the token holder can release, and every write path checks ownership before touching ES. Starting the script twice does nothing.
- **Cluster footnote.** Lock and summary under one `{run}` hashtag so they share a Redis Cluster slot and the Lua release stays atomic. A defensive fix found in review, not the result of an incident.
- **Refresh before counting.** Refresh the target index before count-reconciling, so index visibility lag is never booked as a data difference.

Throttle: no `requests_per_second` was set; `slices=2` was the whole throttle — low parallelism on a live cluster.

Execution: a single run, exclusive on a dedicated script host. Monthly diffs: all zero. Checkpoint resume: triggered zero times — the recovery path was never exercised in production.

## The write path: sync stayed on v1 until the routing contract landed

v2 requires `_routing = account_no`. At migration start, the direct write APIs — task status updates, full task updates — did not carry it. So through modes 0 and 1, direct sync writes kept going to v1 only. v2 was fed by the CDC consumer (which existed before the migration; from the start it wrote both v1 and v2, deriving routing from each document's `account_no` with the `default_routing` fallback).

The consequence was a known, accepted cost: in mode 1 the serving index had exactly one writer, CDC. Freshness of v2 = CDC lag = a seconds-level fluctuation. For task-list browsing, fine. For "user completes an action, checks the list" flows, the list could lag the action by that window.

One write path that is easy to overlook: deletes. The business delete path learned to delete from v2 as well.

Once the projection layer was reworked to carry `account_no`, sync writes returned to the serving index:

- status updates write v2 directly, with routing — status becomes immediately visible
- full updates write the complete task projection, with routing
- one correction along the way: dropped `doc_as_upsert` from full updates. If the document doesn't exist yet, tolerate the 404 and let CDC/bootstrap write the complete document — sync writes are fast, CDC is authoritative.

In the end state, mode 2: CDC writes v2 only, v1 receives no direct writes, and a create-only bootstrap takes over new documents.

This was the project's one direction change — CDC-only serving, then sync restored. The reason is the visibility cost above, and it was a sequence dependency rather than an oversight: sync writes to v2 were gated on the routing contract, and the routing contract was gated on the projection rework.

## Cutover

Mode 1 ran for about a week before anyone touched mode 2. What was actually watched — there was no formal checklist, and none was retro-fitted — was four signals on dashboards: CDC sync status, v2 query error rate, business feedback channels, ES cluster load.

When the signals stayed quiet, the cutover itself was three moves:

1. push mode 2
2. retire the hot side index (it stopped being queried; one line in the deploy, not a project)
3. CDC to v2-only, create-only bootstrap for new documents, sync writes restored

Rollbacks: designed per mode, preconditions in the code comments. Triggered: zero times.

## Numbers

- Engineering: about 4 weeks (Aug 13 → Sep 9). Actual data movement: 1–3 hours.
- Scale: ~1B documents, 800 GB primary, 82 shards ≈ 10 GB/shard, data spanning 2023-03 → 2026-09 (~3.5 years).
- Reindex: `slices=2`, no `requests_per_second` — parallelism was the throttle.
- Reconciliation: monthly `date_histogram` diffs all zero; count checks zero-diff after refresh-before-count.
- Checkpoint resume: invoked zero times. Rollback: zero times.
- CDC lag while it was v2's only writer: seconds-level fluctuation.

## Notes for next time

Would do the same:

- Rollback preconditions written next to the mode enum — the rollback plan lived where the switch lived.
- The switch clamped to mode 0 until the write path was ready; config could not create a read/write split.
- Checkpoint persisted before the external action, not after.

Would change:

- Reconciliation stopped at count + monthly histogram. Next time: content-level checks (field-by-field sample, or full hash comparison) and schema-level checks. Count-equal histograms can hide wrong field values — the risk was real, and the check did not prove what it was meant to prove.
