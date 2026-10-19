---
title: "Running a Million-DAU Casual Game on Go: Rooms as the Concurrency Boundary"
date: 2020-01-25 10:00:00
categories:
  - Engineering Case Study
tags:
  - go
  - game-server
  - ecs
  - concurrency
seo_image: architecture.png
description: "The room service of a QQ-licensed casual game with a million daily users, sized for tens of millions: one Go binary running room goroutines under Go's multicore scheduler, with a serial tick-driven ECS (entity–component–system) inside each room. How the concurrency boundary was chosen, and the pprof finding that moved component data from maps to pre-allocated arrays."
---

The capacity target was fixed before the server had a shape. The game was a QQ-licensed casual pet title; growth would arrive as Tencent's publishing team and we opened entry points inside QQ step by step, so activity peaks sat far above the daily waterline. We designed for tens of millions of users — roughly 200,000 concurrent players at peaks — which imposed two requirements: scale out by adding instances without redesign, and keep each instance dense enough that the fleet stayed a practical size.

The game's backend had other services; this article covers the room service. Inside its rooms, game state lived in components that systems iterated over — an entity-component system. But one decision mattered more than that data layout: the room as the concurrency boundary. Every interaction that needed shared state resolved inside one room, so each room ran as a goroutine with private state, scheduled by Go's runtime across processors, serial and data-oriented inside. I led that architecture selection and the ECS implementation.

<!-- more -->

Inside the room service's process, player state lived along two different paths. Outside rooms, players idled and collected — slow-paced, tolerant of seconds of delay, served by plain request-response. Inside rooms, they moved freely on a grid, interacted, explored, and fought over collection spots, with clicks translated into pathing and movement one cell at a time. One service binary, two state paths, and a tick only where state was shared.

## The capacity target and what it implied

The fleet count was an operations problem; per-instance density was the architecture problem, and it set three requirements:

- Two state paths with different latency budgets: room-external idle could lag, room-internal grid movement had to feel responsive. A click on a target cell became server-side pathing and one-cell-per-tick movement — no physics, no interpolation, but a hesitating server was perceptible.
- A bounded update cycle per room. Each room ticked every 50 milliseconds — 20 Hz — and that interval was the wall-clock deadline for everything the room did in it.
- Broadcast costs that stay flat as a room fills. Fanout had to be bounded by the room design itself, not left to monitoring to catch.


## Two ways to organize ownership and execution

The selection question was not "actor or ECS?" An actor model is about ownership — who holds mutable state and how work reaches it; ECS is about data layout — how a simulation stores components and iterates systems. The real question was where the ownership boundary sits, and what runs inside it.

A player-level actor — one goroutine and mailbox per player — would isolate players, but it would cut across the game's interaction boundary: movement, visibility, contested collection spots, and PVP all require several players and room state to be evaluated together. A query such as "which players are within this area of interest?" would become cross-actor messaging and result assembly. The design would pay channel, mailbox, and message-allocation costs on the hot path while making the room's tick semantics harder to keep deterministic. We rejected player-level ownership because the room, rather than the player, was the unit in which state changed together.

A single global tick was the other extreme: one loop would iterate every room and entity in the process. It would make ordering simple, but it would couple unrelated rooms to one scheduler and one latency budget. A slow or unusually busy room could delay every other room, and one serial loop could not use the machine's available processors effectively at the observed density.

The shipped design combined the two useful ideas at different layers. The room became the ownership and scheduling boundary: one room goroutine owned its mutable state, and Go's runtime scheduled room goroutines across the available processors. Inside the room's simulation loop there were no goroutines and no message passing: entities were component records, systems were iteration passes over them, and a tick walked the room's systems serially. Fixed-capacity component arrays made those traversals predictable.

The ECS side of the design was informed by [Overwatch Gameplay Architecture and Netcode](https://www.youtube.com/watch?v=W3aieHjyNvw), but only its architecture principle carried over: components held state, systems held behavior, and iteration favored contiguous storage. Its 60 Hz client-predicted netcode was outside the scope of this server-authoritative casual game.

## The architecture

{% asset_img architecture.png "One Go instance, room goroutines scheduled across cores, serial tick-driven ECS inside each room" %}

At the machine level, the instance manages rooms as pooled resources. Rooms are assigned and initialized according to player load and player stratification; several room classes exist, and players are placed into the class matching their level and intent, so a new player lands among peers rather than among veterans. Rooms are pre-allocated ahead of demand, so a traffic ramp arrives as a wave of room spin-ups rather than allocation work on the hot path, and recycled when the waterline falls. A central scheduler sees every instance's load and places each new room on the least-loaded one; after placement, the room goroutine owns the room's simulation and tick execution locally.

Inside a room, the tick runs two nested serial iterations: the system pass over component types, and within each system, the pass over entities. Component data lives in fixed-capacity arrays, pre-allocated to the room's entity cap and indexed directly — a component lookup is an array subscript, not a hash. Player input arrives through the connection layer and is batched; a tick consumes the batch accumulated since the previous one.

Outside rooms there was no simulation loop at all: the client held a plain protobuf-over-WebSocket request-response connection, and idle progression was computed from heartbeats on demand. No state was shared out there, so nothing needed synchronizing — the room tick exists only where players share a grid.

Broadcast was bounded two ways. Every state change reached only the players whose area of interest contained it, the same field of view that defined PVP interaction, and each room had a population cap. Together, AOI and the room cap bounded the audience of each state change.

Persistence sits outside the tick entirely. Rooms snapshot asynchronously and flush on a timer to MongoDB; on restart, a room is rebuilt from its last snapshot, so the game state that matters survives while seconds of idle movement may be lost. This is a casual-title tolerance, and it keeps write-through work off the hot path.

## Capacity model

The capacity model uses four figures: peak players, players per room, players per instance, and tick rate.

| Input | Value | Meaning |
| --- | ---: | --- |
| Peak concurrency | about 200,000 | Fleet capacity target |
| Players per room | 30–100 | Converts players into rooms |
| Instance density | 10,000 players/instance | Converts players into instances |
| Tick rate | 20 Hz | 50 ms wall-clock deadline |

The key calculations are:

```text
active_rooms = ceil(peak_players / players_per_room)
instances    = ceil(peak_players / players_per_instance)
```

At the peak, 30–100 players per room means roughly 2,000–6,667 active rooms. At 10,000 players per instance:

```text
ceil(200,000 / 10,000) = 20 instances
```

That 20 instances is the active-capacity lower bound. A production fleet needs additional capacity for uneven placement, warm rooms, reconnects, rolling changes, and instance failure.

For a 10,000-player instance, sizing at a 65-player room average, 10,000 / 65 ≈ 154 rooms:

```text
required_cores ≈ rooms × cpu_seconds_per_tick × tick_rate / utilization
```

What a tick costs comes from the tick's own shape: iterate every entity's components, advance pathing one cell, serialize the frame's state changes for in-sight viewers. A full room lands in the low single-digit milliseconds per tick, as a reconstruction from the load-test shape rather than a recorded number; the 65-player sizing average scales that to ~1.7 ms. Sizing used the average:

```text
average load:  154 rooms × ~1.7 ms × 20 Hz / 0.70 ≈ 7.5 cores
activity peak (a third of rooms full):            ≈ 9.7 cores
```

The 8-vCPU shape covered the recorded average room load. It was not sized to absorb every peak on one instance: when room density approached the per-instance limit, the fleet scaled horizontally.

That 8 cores serve over 150 room goroutines because most rooms spend the unused part of each 50-millisecond tick waiting for their next timer event; only a handful are mid-tick at any instant.

Memory follows the same reconstruction discipline as the CPU figure:

```text
memory = process_baseline + rooms × room_memory + buffers + headroom
```

The reconstructed per-room profile was 1–4 MiB. The ~154 rooms therefore contributed roughly 150–600 MiB; the rest of the 16 GiB machine covered the Go process, player connections, queues, snapshots, caches, runtime metadata, and safety margin. The fleet ran one instance shape throughout — 8 vCPU / 16 GiB on [Tencent Cloud](https://cloud.tencent.com/document/product/213/11518) — which is also why the earlier instance count is a clean capacity figure rather than a mix of sizes.

The fleet-level inputs came from the design and the load test below; the per-tick costs are reconstructions. The equations exist to make the capacity decision reviewable.


## The load test that reshaped the data layout

Load testing was part of the design from the start. The method: boot a fleet of slightly lower-spec instances running simulated clients — bots walking the real client protocol, clicking into rooms, moving, collecting — and drive the server fleet to its target density.

The symptom appeared at density: room ticks frequently overran their deadline, and clients showed it first as room-state updates arriving later than the interaction window could tolerate. That localized the problem to the room's update cycle; the profile showed where inside it the budget went.

[pprof](https://go.dev/devtools/pprof) attributed the lost budget to map operations. The hot loop paid for repeated map lookups, while inserts and growth added allocation and resizing costs. At room scale, that overhead consumed the tick deadline. The fix was to move component storage into pre-allocated fixed-capacity arrays indexed directly, and reuse the memory across room lifecycles. Ticks returned inside their deadline, and the hot path stopped showing allocation churn in profiles.

Two non-findings are worth recording. Broadcast fanout was never the problem — area-of-interest filtering and the room population caps had already bounded it. And the failure never reached production: it was found by the load test, which is the load test doing its job.

## Results

The density target held. A single instance carried ten-thousand-plus concurrent users, the figure my resume records from this period, and the fleet scaled by instance count as designed. At activity peaks, when Tencent opened exposure slots, concurrent players reached roughly 200,000 against a daily active population of about one million, spread across 20+ instances. The daily waterline ran at tens of thousands online. Against the tens-of-millions design point, the fleet never approached its architectural ceiling; scaling was a provisioning decision, not an engineering one.

Per-room population caps varied by room class, so no single cap figure is quoted. The garbage-collector improvement is qualitative: allocation churn on the hot path measurably dropped in the profiles, but there is no pause-frequency before/after record to quote.

## Trade-offs

Pre-allocation buys a flat profile with memory. Arrays sized to the room's entity cap hold their slots whether the room is full or sparse, so a fleet provisioned for peak carries the cost of empty capacity; recycling rooms back into the pool mitigates but does not remove it. A layout that grouped entities by component set, the archetype approach, would use memory closer to occupancy, at the price of indirection on every component access. For this workload I would make the same trade again: the tick budget was the scarcer resource.

Room isolation also draws a hard boundary. State shared across rooms does not belong inside any room's tick; it has to live on a separate tier with its own consistency rules. The room model made that boundary explicit rather than accidental — but anything that quietly assumes cross-room state becomes an architectural change, not a feature.

The persistence stance is a genre decision. Asynchronous snapshots with periodic flush worked because a casual title tolerates losing seconds of idle movement. A game where state loss meant money, inventory integrity, or competitive position could not make this trade — its write path would have to sit inside the tick's budget, and the capacity arithmetic of this architecture changes with it.

Serial-within-room is both the safety model and the ceiling. One pathological entity should stall only its own room while the process and scheduler remain healthy — the logical failure domain is a roomful of players, not the instance. The same property means a single room's complexity cannot be parallelized away; a room that outgrows its tick deadline has no remedy inside this architecture except a smaller cap.

## What I would change today

The placement of the concurrency boundary I would keep: it matched a seam the domain already had, and room-level isolation, multicore scheduling, failure isolation, and bounded per-update fanout all followed from that one decision. If I redesigned the interior today, it would be the entity-cap pre-allocation I would revisit: sizing component storage to observed occupancy with hysteresis, or archetype grouping for the hottest components, to return some of the peak-provisioned memory. And I would instrument the flush path from day one — the snapshot loss window was a parameter we lived with comfortably but never measured, and "comfortable" is a weaker claim than a number.

The transferable rule this case left me: when a domain has a natural isolation seam, whether a room, a match, a document, or a tenant, put the concurrency boundary on that seam, keep the inside serial and data-oriented, and you get parallelism and failure isolation from the same decision. The actor and ECS debates are usually about which model to adopt; in practice the durable designs I have built use each at the layer where its costs are zero.

---

*Previous in this series: [Designing a Predicate-Driven Audience Pipeline for Lifecycle Email](/posts/engineering-case-study/building-a-predicate-driven-audience-pipeline-for-lifecycle-email/).*
