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
  - performance
seo_image: architecture.png
description: "Go room-server architecture for a casual game with over one million DAU: serial ECS ticks, room-level concurrency, and map-to-array optimization."
---

During load testing, room ticks began overrunning their 50 ms budget as simulated clients reached target density. Normal ticks took 10–20 ms; spikes took 100–300 ms, leaving clients two to six ticks behind. We had built the room service for a QQ-licensed casual pet game. It was designed for tens of millions of users; actual peak concurrency reached roughly 200,000 players.

I led the architecture selection and ECS implementation. Profiling showed how much CPU time component lookups consumed.

<!-- more -->

## Designing for 10,000 players per instance

Tencent's publishing team would roll out access in stages, and the service had to absorb each traffic jump by adding instances. Load testing ran bots through the real client protocol — entering rooms, moving, collecting — on a fleet of slightly lower-spec instances. The target: 10,000 real players per server instance, about 667 rooms with fifteen players each, updated at 20 Hz.

Those late room-state updates pointed at the room's serial update cycle.

Outside rooms, another service handled idle collection through request-response calls. Inside rooms, players shared a grid of up to 200×200 cells for movement, exploration, combat, and collection. Clicking a destination triggered server-side pathfinding. Player movement step size was defined separately from the simulation tick. A room held about fifteen real players, 30+ combat NPCs, and a varying number of bot players, with a room capacity of 30–100, depending on room class. The room service updated shared state on each tick, with three constraints:

- Players see delayed updates directly — movement had to stay responsive.
- The update cycle was bounded: each room updated every 50 ms (20 Hz), and all work for that tick had to finish inside the interval.
- Broadcast fanout was bounded too: room population and visibility limits capped the audience for each update.

## Choosing the room boundary and its execution model

Two choices shaped the design: what state each execution unit owned, and how it ran the simulation. [Actor-style ownership](https://doc.akka.io/docs/akka/2.5/guide/actors-intro.html) decided who held mutable state and how work reached it; [ECS](https://www.richardlord.net/blog/ecs/what-is-an-entity-framework.html) decided how components were stored and how systems iterated them.

### Keeping shared state within one room

One actor per player separates ownership of player state, but any interaction that crosses players — or touches shared room state — needs coordination between actors. Take two players claiming the same collection cell in one tick. An actor design resolves that by giving a room actor authority over the cell and routing both claims to it; the cost is the forwarding, the return trip for results, and a rule for when player actors apply those results. Visibility queries, movement collisions, and PvP land on the same question: who owns the state? I kept the interacting state under one room owner, so these operations complete within a single simulation pass.

Actor designs can batch inputs and resolve them in a stable order — [Proto.Actor](https://github.com/asynkronit/protoactor-go) is a Go implementation of the pattern. But with player state split across actors, tick boundaries and per-tick state still need explicit coordination.

A single global simulation loop couples unrelated rooms: one slow room delays the rest, and a serial loop leaves the other processors idle.

### Choosing ECS for the room interior

The closest alternative was a room-level actor: one goroutine and mailbox per room, entities stored as objects, events handled by methods. Same ownership boundary as what shipped. But its handlers processed messages in arrival order and dispatched each event separately, while my tick loop batched the frame's inputs and let systems query components directly — finding the players within an area of interest (AOI), for instance.

ECS won on the second axis: gameplay changed constantly, even inside existing rooms. Components held buff effects and expiration times, systems applied them in tick order, and items reused the same components and systems. New mechanics stopped meaning more branching in player objects and message handlers.

Buff application, movement, damage calculation, expiration — I could order all of it explicitly, with no concurrent writes inside the room. Fixed inputs and simulation time made interactions between mechanics reproducible in tests.

The speed-item example below uses an array-based ECS. `EntityID` indexes the component arrays, and masks record which components are present on each entity. `Room.Tick` runs item application, buff expiration, and movement serially. Adding or removing a component changes membership while retaining its pre-allocated slot.

Each tick simulates the 50 ms interval beginning at `nowMS`. Buffs are active on `[appliedAt, expiresAt)`, so a buff expiring at 100 ms does not affect movement over `[100, 150)`. Durations align with ticks, and each player can have one speed buff. Positions use thousandths of a cell; distance depends on speed and elapsed time.

Save as `main.go` and run `go run main.go`:

```go
package main

import "fmt"

type EntityID int

type ComponentMask uint8

const (
	HasPosition ComponentMask = 1 << iota
	HasMoveSpeed
	HasSpeedBuff
)

// Components contain data only.
type Position struct{ MilliCells int }
type MoveSpeed struct{ MilliCellsPerSecond int }
type SpeedBuff struct{ Multiplier, ExpiresAtMS int }

// Room owns component arrays; masks record component membership.
// Entity IDs are fixed array indices in this reduced example.
type Room struct {
	Masks      []ComponentMask
	Positions  []Position
	MoveSpeeds []MoveSpeed
	SpeedBuffs []SpeedBuff
}

func (r *Room) Has(id EntityID, required ComponentMask) bool {
	return r.Masks[id]&required == required
}

// Query visits only entities with all required components.
func (r *Room) Query(required ComponentMask, visit func(EntityID)) {
	for id := range r.Masks {
		if r.Has(EntityID(id), required) {
			visit(EntityID(id))
		}
	}
}

type UseSpeedItem struct {
	Target                 EntityID
	Multiplier, DurationMS int
}

func SpeedItemSystem(r *Room, nowMS int, commands []UseSpeedItem) {
	for _, cmd := range commands {
		if !r.Has(cmd.Target, HasMoveSpeed) {
			continue
		}
		r.SpeedBuffs[cmd.Target] = SpeedBuff{cmd.Multiplier, nowMS + cmd.DurationMS}
		r.Masks[cmd.Target] |= HasSpeedBuff // add component
	}
}

func BuffExpirySystem(r *Room, nowMS int) {
	r.Query(HasSpeedBuff, func(id EntityID) {
		if nowMS >= r.SpeedBuffs[id].ExpiresAtMS {
			r.Masks[id] &^= HasSpeedBuff // remove component
			r.SpeedBuffs[id] = SpeedBuff{}
		}
	})
}

func MovementSystem(r *Room, dtMS int) {
	r.Query(HasPosition|HasMoveSpeed, func(id EntityID) {
		speed := r.MoveSpeeds[id].MilliCellsPerSecond
		if r.Has(id, HasSpeedBuff) {
			speed *= r.SpeedBuffs[id].Multiplier
		}
		r.Positions[id].MilliCells += speed * dtMS / 1000
	})
}

func (r *Room) Tick(nowMS, dtMS int, commands []UseSpeedItem) {
	SpeedItemSystem(r, nowMS, commands)
	BuffExpirySystem(r, nowMS)
	MovementSystem(r, dtMS)
}

func main() {
	const player, control, stationary EntityID = 0, 1, 2
	r := Room{
		Masks:      []ComponentMask{HasPosition | HasMoveSpeed, HasPosition | HasMoveSpeed, HasPosition},
		Positions:  make([]Position, 3),
		MoveSpeeds: []MoveSpeed{{1000}, {1000}, {}},
		SpeedBuffs: make([]SpeedBuff, 3),
	}
	want := []int{100, 200, 250, 300}
	for step, nowMS := range []int{0, 50, 100, 150} {
		var commands []UseSpeedItem
		if step == 0 {
			commands = []UseSpeedItem{{Target: player, Multiplier: 2, DurationMS: 100}}
		}
		r.Tick(nowMS, 50, commands)
		if r.Positions[player].MilliCells != want[step] ||
			r.Positions[control].MilliCells != (step+1)*50 ||
			r.Positions[stationary].MilliCells != 0 ||
			r.Has(player, HasSpeedBuff) != (nowMS < 100) {
			panic(fmt.Sprintf("unexpected state at %d ms: %+v", nowMS, r))
		}
		fmt.Printf("[%d,%d) ms: positions=%d,%d,%d buff=%t\n",
			nowMS, nowMS+50, r.Positions[player].MilliCells,
			r.Positions[control].MilliCells, r.Positions[stationary].MilliCells,
			r.Has(player, HasSpeedBuff))
	}
	fmt.Println("PASS: component add/remove, expiry boundary, and movement query")
}
```

Output (positions in thousandths of a cell):

```text
[0,50) ms: positions=100,50,0 buff=true
[50,100) ms: positions=200,100,0 buff=true
[100,150) ms: positions=250,150,0 buff=false
[150,200) ms: positions=300,200,0 buff=false
PASS: component add/remove, expiry boundary, and movement query
```

The position-only entity stays still, and the control player keeps its base speed. The buffed player returns to base speed at the expiration boundary.

A room-level actor could implement the same gameplay and tests, including ECS internally. In the candidate's event-handler design, interactions between effects would require ordering rules across handlers. I chose component composition and an explicit system sequence to keep those rules together as gameplay grew.

In the shipped service, one goroutine owned each room's mutable state, and [Go's runtime scheduled room goroutines across the available processors](https://golang.org/pkg/runtime/#GOMAXPROCS). Systems ran serially within that goroutine, accessing components for the relevant entities on every tick.

Cross-room state lived on a separate tier with its own consistency rules, so features spanning rooms required additional coordination.

A slow entity could delay its room's tick while unrelated rooms continued, provided the process and scheduler stayed healthy. Extra cores could run other rooms, but could not shorten that room's serial tick. A room that exceeded its deadline needed less work per tick, further optimization, or a lower population cap.

## Room scheduling, serial ticks, and state management

{% asset_img architecture.png "One Go instance, room goroutines scheduled across cores, serial tick-driven ECS inside each room" %}

Each instance pooled rooms, pre-allocating them to keep allocation off the hot path and recycling them as demand fell. Players joined room classes matching their level and intent, keeping new players among peers. A central scheduler tracked instance load and placed each new room on the least-loaded instance.

I initially stored components in entity-keyed maps to support changing entity counts without reserving full-capacity arrays for every room. Rooms with fewer entities could allocate storage as needed, though maps carried their own bucket and key overhead. Each system looked up components while iterating its entities. Player input arrived through the connection layer; each tick consumed the inputs accumulated since the previous update.

State changes were sent only to players whose area of interest included the affected location. PvP interaction used the same visibility boundary. AOI filtering and room population caps bounded broadcast fanout.

Persistence ran outside the tick. Room snapshots were taken asynchronously and flushed periodically to [MongoDB](https://docs.mongodb.com/manual/). A restart restored each room from its last persisted snapshot, potentially losing subsequent updates. That was acceptable for this casual game. Snapshot flush lag and the recovery loss window were not measured; I would add metrics for both.

## Map lookups exhausted the tick budget

[pprof](https://blog.golang.org/profiling-go-programs) showed map operations consuming 60–85% of the profiled CPU time. These figures reflect the load-test results I confirmed at the time; they are not quoted from retained profiles. The hot frame was `aeshash`, Go's AES-NI-based hash implementation. The Go 1.13 runtime routed [map lookups](https://github.com/golang/go/blob/go1.13/src/runtime/map.go) through its [hashing functions](https://github.com/golang/go/blob/go1.13/src/runtime/alg.go) to [AESENC-based code](https://github.com/golang/go/blob/go1.13/src/runtime/asm_amd64.s).

Across all systems and rooms, component lookups required roughly 13 million hash computations per second per instance, before bucket traversal and key comparison. Map insertions and growth added allocations. GC ran about once a second during the test. Entity IDs could directly index component arrays; the maps added a hash lookup to each access.

I kept the room boundary and serial system order, and replaced component maps with pre-allocated fixed-capacity arrays indexed by entity ID. Storage was reused across room lifecycles. Sequential component traversal also favored cache locality, though cache misses were not measured separately.

Pre-allocated arrays reserved space up to each room's entity cap even when occupancy was low. Room reuse saved allocation work but retained that storage. Growing arrays with occupancy or grouping entities by component set could reduce unused slots, but would add storage-management work. I accepted the reserved space to keep lookups direct and reuse storage.

After the change, p99 tick elapsed time, measured with `time.Since`, fell below 50 ms, and instance CPU utilization settled near 70%. Profiles showed less hot-path allocation churn, but I do not have before-and-after measurements of GC pause frequency.

Broadcast fanout was not the bottleneck in this test. The tick overruns were resolved before production.

## Production results and capacity

At 10,000 players per instance and fifteen players per room, each instance ran about 667 rooms at 20 Hz. A typical room contained roughly 60–80 entities: players, combat NPCs, bots, and collection objects. At that density, the 8-vCPU instance averaged 70% CPU utilization during the same load-test window. Dividing its CPU consumption by the number of room ticks gives about 0.42 ms per room tick:

```text
CPU consumption = 8 vCPU × 70% = 5.6 CPU-seconds per second
room tick rate  = 667 rooms × 20 ticks/second = 13,340 room ticks/second
CPU per room tick = 5.6 / 13,340 seconds ≈ 0.42 ms
```

This average includes connection handling, serialization, GC, and other instance work.

Room goroutines waited between updates, allowing hundreds of rooms to share the 8 vCPUs. We added instances as room density approached the per-instance limit.

The memory model was:

```text
memory = process_baseline + rooms × room_memory + buffers + headroom
```

Estimated per-room memory was a few hundred KiB at fifteen players. At ~667 rooms per instance, that amounted to a few hundred MiB. The 16 GiB instances also provided capacity for the Go process, player connections, queues, snapshots, caches, runtime metadata, and headroom. The fleet used the same instance configuration throughout: 8 vCPU / 16 GiB on [Tencent Cloud](https://cloud.tencent.com/document/product/213/11518).

Concurrency outside activity peaks was in the tens of thousands. A single instance carried over 10,000 concurrent players. At activity peaks, the fleet served roughly 200,000 concurrent players across 20+ instances, with over one million DAU.

---

*The talk [Overwatch Gameplay Architecture and Netcode](https://www.youtube.com/watch?v=W3aieHjyNvw) gave me many of the ideas behind this design, especially separating component state from system behavior and organizing data for sequential access.*

**Next in this series: [One Queue for Every State Change: Fixing Silent Over-Assignment in a Live QR Code System](/posts/engineering-case-study/one-queue-for-every-state-change-fixing-silent-over-assignment-in-a-live-qr-code-system/).*.*
