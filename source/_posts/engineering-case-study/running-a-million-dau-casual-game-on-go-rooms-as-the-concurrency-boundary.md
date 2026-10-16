---
title: "Running a Million-DAU Casual Game on Go: Rooms as the Concurrency Boundary"
date: 2026-10-17 10:00:00
categories:
  - Engineering Case Study
tags:
  - go
  - game-server
  - ecs
  - concurrency
description: "A QQ-licensed casual game with a million daily users sized for tens of millions: one Go binary running rooms truly in parallel on multiple cores, with a serial tick-driven ECS inside each room. How the concurrency boundary was chosen, and the pprof finding that moved component data from maps into pre-allocated arrays."
---

The capacity target was set before the server had a shape. The game was a QQ-licensed pet title in the casual category, and traffic would arrive the way Tencent ramps a national title: exposure slots opened gradually over months, with activity peaks far above the daily waterline. We designed for a user base in the tens of millions, which meant the architecture had to scale horizontally by instance count without any redesign, and each instance had to be dense enough that the instance count stayed operationally sane.

Inside one process, the game had two very different shapes of state to synchronize. Outside rooms, players idled and collected — slow-paced, tolerant of seconds of delay. Inside rooms, they moved freely on a grid, interacted, explored, and fought over collection spots, with clicks translated into pathing and movement one cell at a time. One server binary, two synchronization semantics, and a hard ceiling on how much computation any single room's update cycle could afford.

I led the server architecture selection and the ECS implementation this article describes.

<!-- more -->

## The capacity target and what it implied

A design point in the tens of millions decomposes into two independent numbers: how many instances the fleet runs, and how many players each instance carries. The first is an operations problem; the second is an architecture problem, and it was the one that constrained every decision below.

Per-instance density set the requirements:

- Two sync semantics in one binary. Room-external idle state could lag; room-internal grid movement had to feel responsive. A click on a target cell became server-side pathing and one-cell-per-tick movement — no physics, no interpolation, but perceptible if the server hesitated.
- A bounded update cycle per room. Each room ticked at roughly 10 Hz, so a tick had a budget of about 100 milliseconds; whatever the room did in that budget defined the player's worst-case interaction latency.
- Broadcast costs that stay flat as a room fills. Every movement and interaction was broadcast to the players who could see it. Fanout had to be bounded by design, not by hope.

The 10 Hz figure is a reconstruction, not a record: I no longer have the exact tick rate, but one-cell movement and batched input both point to that order — fast enough that a click lands within a casual player's perception window, slow enough that the per-tick budget is realistic for the entity counts involved.

## Two candidate concurrency models

The selection question was not "which library" but **where to put concurrency**. Two candidates came before the design we shipped.

One actor per player. Every player gets a goroutine and a mailbox; all interaction is message passing. The model parallelizes naturally and isolates failure per player, but in this workload its costs land exactly on the hot path. Player-to-player interaction inside a room — the PVP contact, the contested collection spot — becomes mailbox round trips; a query like "who is within sight of this player" becomes a fan of messages across actors, assembled somewhere, late. Channel operations and message allocation on every interaction feed the garbage collector precisely where the tick budget is spent.

One global tick over all entities. The opposite pole: a single tick loop iterating every entity in the world, serially. Data-oriented and simple, but a serial loop cannot fill a many-core machine, and one laggy room stalls every other room in the process. At our density target that wastes most of an expensive box and couples unrelated players' latency.

The design we shipped put the boundary where the domain already had one. **A room is the concurrency unit**: it owns its state exclusively, runs its own tick, and is the failure and latency domain — actor-shaped at the room level. Inside the room, there are no goroutines and no messages: entities are component records, systems are iteration passes over them, and a tick walks the room's systems serially. Rooms run truly in parallel across the machine's cores; nothing mutable is shared between rooms, so the parallelism needs no locks on the game path.

This is why the actor-versus-ECS framing never quite matched the decision. Both models appear — actor isolation at the room boundary, ECS data layout inside it — each doing what it is good at. ECS was chosen at selection time, before any code ran, to avoid the actor model's costs at player granularity; the room is what made that choice compatible with filling a multicore machine.

## The architecture

At the machine level, the instance manages rooms as pooled resources. Rooms are assigned and initialized according to player load and player stratification; several room classes exist, and players are placed into the class matching their level and intent, so a new player lands among peers rather than among veterans. Rooms are pre-allocated ahead of demand — a traffic ramp arrives as a wave of room spin-ups, not as allocation work on the hot path — and recycled when the waterline falls.

Inside a room, the tick runs two nested serial iterations: the system pass over component types, and within each system, the pass over entities. Component data lives in fixed-capacity arrays, pre-allocated to the room's entity cap and indexed directly — a component lookup is an array subscript, not a hash. Player input arrives through the connection layer and is batched; a tick consumes the batch accumulated since the previous one, which makes the tick period the input-latency floor and keeps per-tick work predictable.

Broadcast is bounded two ways. Every state change reaches only the players whose area of interest contains it — the same field of view that defines PVP interaction defines its audience — and each room has a population cap, which exists for gameplay as much as for load: the casual collection-and-interaction loop only works when a room is not crowded. The combination keeps fanout flat regardless of instance density.

Persistence sits outside the tick entirely. Rooms snapshot asynchronously and flush on a timer; the game state that matters survives a restart, and the state that does not — seconds of idle movement — is accepted as lost. This is a casual-title tolerance, and it is load-bearing: it is what allows the entire game state to live in memory with no write-through on the hot path. The exact flush interval and loss window are not something I can still reconstruct, and I would rather leave that boundary stated than invent a number.

## The load test that reshaped the data layout

Because the game was planned for national-IP traffic from the start, load testing was treated as part of the design, not a release gate at the end. The method: boot a fleet of slightly lower-spec instances running simulated clients — bots walking the real client protocol, clicking into rooms, moving, collecting — and drive the server fleet to its target density.

The symptom appeared at density: room ticks frequently overran their budget, and the clients showed it first as an inability to align state within their latency-tolerance window — the server's answers about room state arrived later than the client's interpolation could absorb. That observation mattered diagnostically: it localized the problem to the room's update cycle rather than to the network or the broadcast path.

pprof attributed the lost budget to map operations. The component-access path still went through maps in the hot loop — lookups and growth on every component touch of every entity in every tick — and at room scale that overhead, plus the allocation churn that came with it, consumed the tick budget. The fix was to finish what the architecture implied: move component storage into pre-allocated fixed-capacity arrays indexed directly, and reuse the memory across room lifecycles. Ticks returned inside their budget, and the same change removed a steady source of garbage-collector pressure — the allocation profile of the hot path went quiet.

Two non-findings are worth recording. Broadcast fanout was never the problem — area-of-interest filtering and the room population caps had already bounded it. And the failure never reached production: it was found by the load test, which is the load test doing its job.

## Results

The density target held. A single instance carried ten-thousand-plus concurrent users — the figure my resume records from this period — and the fleet scaled by instance count as designed. At activity peaks, when Tencent opened exposure slots, concurrent players reached roughly 20% of a million daily actives — on the order of two hundred thousand — spread across twenty-plus high-spec instances. The daily waterline ran at tens of thousands online. Against the tens-of-millions design point, the fleet never approached its architectural ceiling; scaling was a provisioning decision, not an engineering one.

Three boundaries on these numbers. The tick rate is a reconstruction, as noted. The instance specifications and per-room population caps are not something I can still cite precisely — "high-spec" is honest, a specific core-and-RAM figure would be invented. And the garbage-collector improvement is qualitative: allocation churn on the hot path measurably dropped in the profiles, but I have no pause-frequency before/after record to quote.

## Trade-offs

Pre-allocation buys a flat profile with memory. Arrays sized to the room's entity cap hold their slots whether the room is full or sparse, so a fleet provisioned for peak carries the cost of empty capacity; memory reuse across room lifecycles mitigates but does not remove it. A layout that grouped entities by component set — the archetype approach — would use memory closer to occupancy, at the price of indirection on every component access. For this workload I would make the same trade again: the tick budget was the scarcer resource.

Room isolation is also a closed border. State shared across rooms has no natural home inside any room's tick; it has to live on a tier of its own, with its own consistency story. The room model made that boundary explicit rather than accidental — but anything that quietly assumes cross-room state becomes an architectural change, not a feature.

The persistence stance is a genre decision. Asynchronous snapshots with periodic flush worked because a casual title tolerates losing seconds of idle movement. A game where state loss meant money, inventory integrity, or competitive position could not buy density this cheaply — its write path would have to sit inside the tick's budget, and the whole arithmetic of this architecture changes.

Serial-within-room is both the safety model and the ceiling. One pathological entity stalls only its own room — the failure domain is a roomful of players, not the instance. The same property means a single room's complexity cannot be parallelized away; a room that outgrows its tick budget has no remedy inside this architecture except a smaller cap.

## What I would change today

The placement of the concurrency boundary I would keep: it matched a seam the domain already had, and every operational property we needed — parallelism across cores, failure isolation, flat broadcast — fell out of that one decision. If I redesigned the interior today, it would be the entity-cap pre-allocation I would revisit: sizing component storage to observed occupancy with hysteresis, or archetype grouping for the hottest components, to return some of the peak-provisioned memory. And I would instrument the flush path from day one — the snapshot loss window was a parameter we lived with comfortably but never measured, and "comfortable" is a weaker claim than a number.

The transferable rule this case left me: when a domain has a natural isolation seam — a room, a match, a document, a tenant — put the concurrency boundary on that seam, keep the inside serial and data-oriented, and let the seam absorb both the parallelism and the failure. The actor and ECS debates are usually about which model to adopt; in practice the durable designs I have built use each at the layer where its costs are zero.

---

*Previous in this series: [Designing a Predicate-Driven Audience Pipeline for Lifecycle Email](/posts/engineering-case-study/building-a-predicate-driven-audience-pipeline-for-lifecycle-email/).*
