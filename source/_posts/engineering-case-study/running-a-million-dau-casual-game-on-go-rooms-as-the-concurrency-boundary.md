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
description: "A QQ-licensed casual game with a million daily users sized for tens of millions: one Go binary running room goroutines under Go's multicore scheduler, with a serial tick-driven ECS inside each room. How the concurrency boundary was chosen, and the pprof finding that moved component data from maps to pre-allocated arrays."
---

The capacity target was set before the server had a shape. The game was a QQ-licensed pet title in the casual category, and traffic would arrive the way Tencent ramps a national title: exposure slots opened gradually over months, with activity peaks far above the daily waterline. We designed for a user base in the tens of millions, which meant the architecture had to scale horizontally by instance count without any redesign, and each instance had to be dense enough that the instance count stayed operationally sane.

The design point was roughly 200,000 peak concurrent players at activity peaks. The capacity model later shows how that figure, with the room and tick parameters, translates into room count, instance count, and machine resources.

The design decision that made the server scale was not ECS by itself. It was choosing the room as the logical concurrency boundary: each room ran as a goroutine with private state, and Go's runtime scheduled those room goroutines across the machine's processors while each room stayed serial and data-oriented.

Inside one process, the game had two very different shapes of state to synchronize. Outside rooms, players idled and collected — slow-paced, tolerant of seconds of delay. Inside rooms, they moved freely on a grid, interacted, explored, and fought over collection spots, with clicks translated into pathing and movement one cell at a time. One server binary, two synchronization semantics, and a hard ceiling on how much computation any single room's update cycle could afford.

I led the server architecture selection and the ECS implementation this article describes.

<!-- more -->

## The capacity target and what it implied

A design point in the tens of millions decomposes into two independent numbers: how many instances the fleet runs, and how many players each instance carries. The first is an operations problem; the second is an architecture problem, and it was the one that constrained every decision below.

Per-instance density set the requirements:

- Two sync semantics in one binary. Room-external idle state could lag; room-internal grid movement had to feel responsive. A click on a target cell became server-side pathing and one-cell-per-tick movement — no physics, no interpolation, but perceptible if the server hesitated.
- A bounded update cycle per room. Each room ticked at roughly 10 Hz, so each tick had a 100-millisecond wall-clock deadline; the room's actual CPU consumption was only part of that interval. Whatever the room did before that deadline defined the player's worst-case interaction latency.
- Broadcast costs that stay flat as a room fills. Every movement and interaction was broadcast to the players who could see it. Fanout had to be bounded by design, not by hope.


## Two ways to organize ownership and execution

The selection question was not "actor or ECS?" Those models answer different questions. An actor model defines who owns mutable state and how work reaches it. ECS defines how a simulation stores component data and runs systems over entities. The useful comparison for this game was where to place the ownership boundary, and what execution model to use inside that boundary.

A player-level actor was one possible ownership boundary. Each player would own state in a goroutine and receive commands through a mailbox. That would isolate players, but it would cut across the game's interaction boundary: movement, visibility, contested collection spots, and PVP all require several players and room state to be evaluated together. A query such as "which players are within this area of interest?" would become cross-actor messaging and result assembly. The design would pay channel, mailbox, and message-allocation costs on the hot path while making the room's tick semantics harder to keep deterministic. We rejected player-level ownership because the room, rather than the player, was the unit in which state changed together.

A single global tick was the other extreme: one loop would iterate every room and entity in the process. It would make ordering simple, but it would couple unrelated rooms to one scheduler and one latency budget. A slow or unusually busy room could delay every other room, and one serial loop could not use the machine's available processors effectively at the observed density.

The shipped design combined the two useful ideas at different layers. The room became the ownership and scheduling boundary: one room goroutine owned its mutable state, and Go's runtime scheduled room goroutines across the available processors. Inside the room's simulation loop, there were no additional goroutines and no message passing: entities were component records, systems were iteration passes over them, and a tick walked the room's systems serially. Fixed-capacity component arrays made those traversals predictable and avoided unnecessary map and allocation work.

The ECS side of the design was informed by [Overwatch Gameplay Architecture and Netcode](https://www.youtube.com/watch?v=W3aieHjyNvw), but only its architecture principle carried over: components held state, systems held behavior, and iteration favored contiguous storage. Its 60 Hz client-predicted netcode was outside the scope of this server-authoritative casual game.

## The architecture

{% asset_img architecture.png "One Go instance, room goroutines scheduled across cores, serial tick-driven ECS inside each room" %}

At the machine level, the instance manages rooms as pooled resources. Rooms are assigned and initialized according to player load and player stratification; several room classes exist, and players are placed into the class matching their level and intent, so a new player lands among peers rather than among veterans. Rooms are pre-allocated ahead of demand — a traffic ramp arrives as a wave of room spin-ups, not as allocation work on the hot path — and recycled when the waterline falls.

Inside a room, the tick runs two nested serial iterations: the system pass over component types, and within each system, the pass over entities. Component data lives in fixed-capacity arrays, pre-allocated to the room's entity cap and indexed directly — a component lookup is an array subscript, not a hash. Player input arrives through the connection layer and is batched; a tick consumes the batch accumulated since the previous one, which makes the tick period the input-latency floor and keeps per-tick work predictable.

Outside rooms there was no simulation loop at all: the client held a plain protobuf-over-WebSocket request-response connection, and idle progression was computed from heartbeats on demand. That is the other half of the "two sync semantics" the capacity target imposed — the room tick exists only where players share a grid.

Broadcast was bounded two ways. Every state change reached only the players whose area of interest contained it — the same field of view that defined PVP interaction defined its audience — and each room had a population cap. Together, AOI and the room cap bounded the audience of each state change.

Persistence sits outside the tick entirely. Rooms snapshot asynchronously and flush on a timer; the game state that matters survives a restart, while seconds of idle movement may be lost. This is a casual-title tolerance, and it keeps write-through work off the hot path.

## Capacity model

The capacity model uses four figures: peak players, players per room, players per instance, and tick rate. The formulas show how they relate.

| Input | Value | Meaning |
| --- | ---: | --- |
| Peak concurrency | about 200,000 | Fleet capacity target |
| Players per room | 30–100 | Converts players into rooms |
| Instance density | 10,000 players/instance | Converts players into instances |
| Tick rate | roughly 10 Hz | 100 ms wall-clock deadline |

The key calculations are:

```text
active_rooms = ceil(peak_players / players_per_room)
instances    = ceil(peak_players / players_per_instance)
```

At the peak, 30–100 players per room means roughly 2,000–6,667 active rooms. At 10,000 players per instance:

```text
ceil(200,000 / 10,000) = 20 instances
```

Twenty instances is the active-capacity lower bound. A production fleet needs additional capacity for uneven placement, warm rooms, reconnects, rolling changes, and instance failure.

For a 10,000-player instance with 50-player rooms, the CPU model is the next sizing step:

```text
required_cores ≈ rooms × cpu_seconds_per_tick × tick_rate / utilization
```

The 5 ms figure is the full-room measurement — one hundred players, the load-test worst case. Rooms ran at thirty to fifty players on average, where the same linear scaling puts a room near 1.5–2.5 ms per tick. Sizing used the average; the full-room figure was the validation ceiling:

```text
average load:  154 rooms × 2.5 ms × 10 Hz / 0.70 ≈ 5.5 cores
activity peak (a third of rooms full):            ≈ 7.3 cores  (92% of 8)
all-rooms-full hypothetical:                      ≈ 11 cores  (never observed)
```

Eight logical cores per instance, with headroom for networking, persistence, GC, and bursts; the all-full hypothetical exceeds one machine, but an entire instance's rooms simultaneously full was an operational state the population caps made unreachable — matchmaking filled rooms across instances before saturating one.

That eight cores serve over a hundred and fifty room goroutines is not a contradiction: a room goroutine spends most of every 100-millisecond tick asleep in its timer, only a handful of rooms are mid-tick at any instant, and Go's scheduler holds the rest in timer queues. The goroutine-per-room model costs wakeups — on the order of two thousand per second at this scale — which profiling never surfaced as material.

Memory is calculated from the recorded room profile:

```text
memory = process_baseline + rooms × room_memory + buffers + headroom
```

The per-room profile was 1–4 MiB. A hundred and fifty-odd rooms therefore contributed roughly 150–600 MiB; the rest of the 16 GiB machine covered the Go process, player connections, queues, snapshots, caches, runtime metadata, and safety margin. The 32 GiB machines were used where those non-room allocations or pre-allocated room state were larger.

The inputs came from the load test described below; the equations exist to make the capacity decision reviewable.


## The load test that reshaped the data layout

Because the game was planned for national-IP traffic from the start, load testing was treated as part of the design, not a release gate at the end. The method: boot a fleet of slightly lower-spec instances running simulated clients — bots walking the real client protocol, clicking into rooms, moving, collecting — and drive the server fleet to its target density.

The symptom appeared at density: room ticks frequently overran their deadline, and clients showed it first as room-state updates arriving later than the interaction window could tolerate. That was the investigation signal, not proof that the network or broadcast path was innocent; the profile identified where the budget was actually going.

[pprof](https://go.dev/devtools/pprof) attributed the lost budget to map operations. The hot loop paid for repeated map lookups, while inserts and growth added allocation and resizing costs. At room scale, that overhead consumed the tick deadline. The fix was to move component storage into pre-allocated fixed-capacity arrays indexed directly, and reuse the memory across room lifecycles. Ticks returned inside their deadline, and the allocation profile of the hot path quieted.

Two non-findings are worth recording. Broadcast fanout was never the problem — area-of-interest filtering and the room population caps had already bounded it. And the failure never reached production: it was found by the load test, which is the load test doing its job.

## Results

The density target held. A single instance carried ten-thousand-plus concurrent users — the figure my resume records from this period — and the fleet scaled by instance count as designed. At activity peaks, when Tencent opened exposure slots, concurrent players reached roughly 200,000 against a daily active population of about one million, spread across twenty-plus high-spec instances. The daily waterline ran at tens of thousands online. Against the tens-of-millions design point, the fleet never approached its architectural ceiling; scaling was a provisioning decision, not an engineering one.

The exact hardware SKU and per-room population cap are omitted here; the fleet ran on high-spec instances. The garbage-collector improvement is qualitative: allocation churn on the hot path measurably dropped in the profiles, but there is no pause-frequency before/after record to quote.

## Trade-offs

Pre-allocation buys a flat profile with memory. Arrays sized to the room's entity cap hold their slots whether the room is full or sparse, so a fleet provisioned for peak carries the cost of empty capacity; memory reuse across room lifecycles mitigates but does not remove it. A layout that grouped entities by component set — the archetype approach — would use memory closer to occupancy, at the price of indirection on every component access. For this workload I would make the same trade again: the tick budget was the scarcer resource.

Room isolation is also a closed border. State shared across rooms has no natural home inside any room's tick; it has to live on a tier of its own, with its own consistency story. The room model made that boundary explicit rather than accidental — but anything that quietly assumes cross-room state becomes an architectural change, not a feature.

The persistence stance is a genre decision. Asynchronous snapshots with periodic flush worked because a casual title tolerates losing seconds of idle movement. A game where state loss meant money, inventory integrity, or competitive position could not buy density this cheaply — its write path would have to sit inside the tick's budget, and the whole arithmetic of this architecture changes.

Serial-within-room is both the safety model and the ceiling. One pathological entity should stall only its own room while the process and scheduler remain healthy — the logical failure domain is a roomful of players, not the instance. The same property means a single room's complexity cannot be parallelized away; a room that outgrows its tick deadline has no remedy inside this architecture except a smaller cap.

## What I would change today

The placement of the concurrency boundary I would keep: it matched a seam the domain already had, and every operational property we needed — room-level isolation, multicore scheduling, failure isolation, flat broadcast — fell out of that one decision. If I redesigned the interior today, it would be the entity-cap pre-allocation I would revisit: sizing component storage to observed occupancy with hysteresis, or archetype grouping for the hottest components, to return some of the peak-provisioned memory. And I would instrument the flush path from day one — the snapshot loss window was a parameter we lived with comfortably but never measured, and "comfortable" is a weaker claim than a number.

The transferable rule this case left me: when a domain has a natural isolation seam — a room, a match, a document, a tenant — put the concurrency boundary on that seam, keep the inside serial and data-oriented, and let the seam absorb both the parallelism and the failure. The actor and ECS debates are usually about which model to adopt; in practice the durable designs I have built use each at the layer where its costs are zero.

---

*Previous in this series: [Designing a Predicate-Driven Audience Pipeline for Lifecycle Email](/posts/engineering-case-study/building-a-predicate-driven-audience-pipeline-for-lifecycle-email/).*
