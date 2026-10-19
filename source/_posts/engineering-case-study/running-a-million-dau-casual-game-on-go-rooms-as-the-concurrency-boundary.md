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
description: "The room service of a QQ-licensed casual game with a million daily users, sized for tens of millions: one Go binary running room goroutines under Go's multicore scheduler, with a serial tick-driven ECS (entity–component–system) inside each room. How the concurrency boundary was chosen, and the pprof finding that moved component data from maps into pre-allocated arrays."
---

The load test found the defect it was built to find. We had built the room service for a QQ-licensed casual pet title, sized for tens of millions of users, roughly 200,000 concurrent players at activity peaks. The fleet of simulated clients reached target density, and there the room ticks began to overrun — not by getting slower, but by stuttering. A normal tick ran 10–20 ms inside its 50 ms budget; a spike would run 100–300 ms, two to six ticks late, and the clients fell out of their interaction window trying to align room state.

I had led the architecture selection and the ECS implementation, and the profile would show the problem inside my own design: the data layout was spending the tick budget. What follows is the system, the finding, and the fix.

<!-- more -->

## What the load test was built to tell us

Load testing was part of the design from the start, because the traffic plan demanded it: Tencent's publishing team and we would open entry points step by step, and the server had to absorb each step without redesign. The method: boot a fleet of slightly lower-spec instances running simulated clients — bots walking the real client protocol, clicking into rooms, moving, collecting — and drive the server fleet to its target density: 10,000 players per instance, about 154 rooms, ticks at 20 Hz.

The stutter pointed at the room's update cycle before any profile did: room-state updates arrived late in bursts, which localized the jitter to that cycle rather than the network or the broadcast path. That is where the design review paused and the profiler started — but to read that profile, you first need the system it profiled.

## The system under test

The game's backend had other services; this one is the room service. Player state split in two: idle collection outside rooms, handled by another service as plain request-response, and inside rooms a shared grid of movement, interaction, exploration, and contested collection spots, where clicks became server-side pathing, one cell per tick. Only that shared-grid state lived in this service, under a synchronized tick.

The capacity target, fixed before the server had a shape, imposed two requirements: scale out by adding instances without redesign, and keep each instance dense enough that the fleet stayed a practical size. Per-instance density set three requirements on the room service:

- Responsive grid movement. A click on a target cell became server-side pathing and one-cell-per-tick movement; no physics, no interpolation, but a hesitating server was perceptible.
- A bounded update cycle per room. Each room ticked every 50 milliseconds — 20 Hz — and that interval was the wall-clock deadline for everything the room did in it.
- Broadcast costs that stay flat as a room fills. Fanout had to be bounded by the room design itself, not left to monitoring to catch.

## Two ways to organize ownership and execution

The selection question was not "actor or ECS?" An actor model is about ownership (who holds mutable state, how work reaches it); ECS is about data layout (how a simulation stores components and iterates systems). So the question was where the ownership boundary sits, and what runs inside it.

A player-level actor, one goroutine and mailbox per player, would isolate players, but it would cut across the game's interaction boundary. Take the contested collection spot as the concrete case: two players click the same cell within the same tick. Under player-level ownership, that single gameplay event becomes a cross-actor protocol of both mailboxes, result assembly, and a tie-break somewhere; the same shape repeats for visibility queries, movement collisions, and every PVP contact. The design would pay channel, mailbox, and message-allocation costs on the hot path while making the room's tick semantics harder to keep deterministic. We rejected player-level ownership because the room, not the player, was the unit in which state changed together.

A single global tick was the other extreme: one loop iterating every room and entity in the process. It would couple unrelated rooms to one scheduler and one latency budget, one slow room delaying every other, and one serial loop could not use the machine's processors at our density.

The shipped design used each model at a different layer. The room became the ownership and scheduling boundary: one room goroutine owned its mutable state, and Go's runtime scheduled room goroutines across the available processors. Inside the room's simulation loop there were no goroutines and no message passing: game state lived in components that systems iterated over, and a tick walked the systems serially. Component storage was the one part we got wrong before the load test corrected it — the arrays that made those traversals predictable came later, from the profile.

The ECS side of the design was informed by [Overwatch Gameplay Architecture and Netcode](https://www.youtube.com/watch?v=W3aieHjyNvw), but only its architecture principle carried over: components held state, systems held behavior, and iteration favored contiguous storage. Its 60 Hz client-predicted netcode was outside the scope of this server-authoritative casual game.

The boundary had a price I would pay again. A closed border means state shared across rooms has no home inside any room's tick; it lives on a separate tier with its own consistency rules, and anything that quietly assumes cross-room state becomes an architectural change, not a feature. That is the price, and I would pay it again: room-level isolation, multicore scheduling, failure isolation, and bounded per-update fanout all followed from that one placement.

## The architecture

{% asset_img architecture.png "One Go instance, room goroutines scheduled across cores, serial tick-driven ECS inside each room" %}

At the machine level, the instance managed rooms as pooled resources. Rooms were assigned and initialized by player load and player stratification; several room classes existed, and players were placed into the class matching their level and intent, so a new player landed among peers rather than among veterans. Rooms were pre-allocated ahead of demand, so a traffic ramp arrived as a wave of room spin-ups rather than allocation work on the hot path, and recycled when the waterline fell. A central scheduler saw every instance's load and placed each new room on the least-loaded one; after placement, the room goroutine owned the room's simulation and tick execution locally.

Inside a room, the tick ran two nested serial iterations: the system pass over component types, and within each system, the pass over entities. Component storage is where the story turns: it started in entity-keyed maps, and ended in fixed-capacity arrays pre-allocated to the room's entity cap and indexed directly, where a component lookup was an array subscript, not a hash — the load test forced that change, and the profile section shows why. Player input arrived through the connection layer and was batched; a tick consumed the batch accumulated since the previous one.

Outside-room state was not this service's problem — no simulation loop, no shared state, nothing to synchronize; the room tick existed only where players shared a grid.

Broadcast was bounded two ways. Every state change reached only the players whose area of interest contained it, the same field of view that defined PVP interaction, and each room had a population cap. Together, AOI and the room cap bounded the audience of each state change.

Persistence sat outside the tick entirely. Rooms snapshotted asynchronously and flushed on a timer to MongoDB; on restart, a room was rebuilt from its last snapshot, so the game state that mattered survived while seconds of idle movement might be lost. This was a genre decision as much as an engineering one: a game where state loss meant money, inventory integrity, or competitive position could not buy density this way — its write path would have to sit inside the tick's budget, and the capacity arithmetic changes with it.

## What the profile showed

With the architecture in view, the profile's answer lands. [pprof](https://go.dev/devtools/pprof) attributed the lost budget to map operations, 60–85% of it (figures are my confirmed magnitudes from the load-test shape, not instrument records). The visible frame was Go's hash function itself — aeshash, the AES-NI-based hash the runtime runs on every [map access](https://github.com/golang/go/blob/go1.13/src/runtime/map.go), where [hashing](https://github.com/golang/go/blob/go1.13/src/runtime/alg.go) dispatches to the [AESENC chains](https://github.com/golang/go/blob/go1.13/src/runtime/asm_amd64.s) — burning CPU on every component lookup. Component access went through entity-keyed maps: every system, every entity, every tick re-hashed the key just to find the component, roughly 15 million hash computations per second per instance, before the bucket walk and key compare. Inserts and growth added allocation on top, feeding a garbage cycle that ran about once a second. The tick's budget went to hashing data it already knew how to index.

The fix was to finish what the architecture implied: component storage moved from maps into pre-allocated fixed-capacity arrays indexed directly, memory reused across room lifecycles. Ticks returned inside their deadline: p99 back under 50 ms, average room cost stable at ~1.7 ms, instance CPU settling near 70%. The hot path stopped showing allocation churn in profiles.

Two non-findings are worth recording. Broadcast fanout was never the problem; area-of-interest filtering and the room population caps had already bounded it. And the failure never reached production; the load test caught it first.

## The capacity model that sized the fleet

The capacity model used four figures: peak players, players per room, players per instance, and tick rate.

| Input | Value | Meaning |
| --- | ---: | --- |
| Peak concurrency | about 200,000 | Fleet capacity target |
| Players per room | 30–100 | Converts players into rooms |
| Instance density | 10,000 players/instance | Converts players into instances |
| Tick rate | 20 Hz | 50 ms wall-clock deadline |

The key calculations:

```text
active_rooms = ceil(peak_players / players_per_room)
instances    = ceil(peak_players / players_per_instance)
```

At the peak, 30–100 players per room meant roughly 2,000–6,667 active rooms. At 10,000 players per instance:

```text
ceil(200,000 / 10,000) = 20 instances
```

That 20 instances was the active-capacity lower bound; a production fleet needed more for uneven placement, warm rooms, reconnects, rolling changes, and instance failure.

For a 10,000-player instance, sizing at a 65-player room average, 10,000 / 65 ≈ 154 rooms. What a tick cost came from the tick's own shape: iterate every entity's components, advance pathing one cell, serialize the frame's state changes for in-sight viewers. A full room landed in the low single-digit milliseconds per tick, as a reconstruction from the load-test shape rather than a recorded number; the 65-player sizing average scaled that to ~1.7 ms — the same figure the map-to-array fix later held in production. Sizing used the average:

```text
average load:  154 rooms × ~1.7 ms × 20 Hz / 0.70 ≈ 7.5 cores
activity peak (a third of rooms full):            ≈ 9.7 cores
```

The 8-vCPU shape covered the recorded average room load. It was not sized to absorb every peak on one instance: when room density approached the per-instance limit, the fleet scaled horizontally.

That 8 cores served over 150 room goroutines because most rooms spent the unused part of each 50-millisecond tick waiting for their next timer event; only a handful were mid-tick at any instant.

Memory followed the same reconstruction discipline as the CPU figure:

```text
memory = process_baseline + rooms × room_memory + buffers + headroom
```

The reconstructed per-room profile was 1–4 MiB. The ~154 rooms therefore contributed roughly 150–600 MiB; the rest of the 16 GiB machine covered the Go process, player connections, queues, snapshots, caches, runtime metadata, and safety margin. The fleet ran one instance shape throughout, 8 vCPU / 16 GiB on [Tencent Cloud](https://cloud.tencent.com/document/product/213/11518), which is also why the instance count above is a clean capacity figure rather than a mix of sizes.

Pre-allocation bought that flat profile with memory: arrays sized to the room's entity cap hold their slots whether the room is full or sparse, so a fleet provisioned for peak carries the cost of empty capacity. Recycling rooms back into the pool mitigated but did not remove it. A layout that grouped entities by component set — the archetype approach — would use memory closer to occupancy at the price of indirection on every access; for this workload the tick budget was the scarcer resource, so I would make the same trade again. If I revisited anything in the interior, it would be this: sizing component storage to observed occupancy, or archetype grouping for the hottest components.

## Results

The density target held. A single instance carried ten-thousand-plus concurrent users, the figure my resume records from this period, and the fleet scaled by instance count as designed. At activity peaks, when Tencent opened entry points, concurrent players reached roughly 200,000 against a daily active population of about one million, spread across 20+ instances. The daily waterline ran at tens of thousands online. Against the tens-of-millions design point, the fleet never approached its architectural ceiling; scaling was a provisioning decision, not an engineering one.

Per-room population caps varied by room class, so no single cap figure is quoted. The garbage-collector improvement is qualitative: allocation churn on the hot path measurably dropped in the profiles, but there is no pause-frequency before/after record to quote.

## What the boundary costs, and what I would change

Serial-within-room was both the safety model and the ceiling. One pathological entity should stall only its own room while the process and scheduler stayed healthy — the logical failure domain was a roomful of players, not the instance. The same property meant a single room's complexity could not be parallelized away; a room that outgrew its tick deadline had no remedy inside this architecture except a smaller cap.

If I changed one thing with today's tools, it would be instrumentation, not architecture: the flush path got no metrics from day one, the snapshot loss window was a parameter we lived with comfortably but never measured, and "comfortable" is a weaker claim than a number.

The rule I carried out of this case: when a domain has a natural isolation seam, whether a room, a match, a document, or a tenant, put the concurrency boundary on that seam and keep the inside serial and data-oriented. The aeshash finding left a second rule for the interior: a language runtime's container costs are part of the design surface — on a hot path, the question is not only which data structure, but what the runtime does on every access to it. Both rules came out of the same load test: the boundary decision was right from the start, and the layout mistake inside it took a profile to see.

---

*Previous in this series: [Designing a Predicate-Driven Audience Pipeline for Lifecycle Email](/posts/engineering-case-study/building-a-predicate-driven-audience-pipeline-for-lifecycle-email/).*
