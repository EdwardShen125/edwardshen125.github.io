---
title: "Debugging a Sporadic Go OOM in a Recursive JSON Encode Path"
date: 2025-10-01 10:00:00
categories:
  - Engineering Case Study
tags:
  - go
  - json
  - oom
  - production-debugging
  - event-driven
description: A Go service reached its 8 GB Pod memory limit when a recursive event type entered jsoniter's lazy encoder compilation path during publish. Build bisection isolated the type and publish path; moving only that path to sonic stopped the incident.
seo_image: debugging-recursive-json-encode-oom.png
---

The alert came from Grafana. A Go service on the SOP event chain reached its 8 GB Pod memory limit and restarted; process memory went from flat to the limit in under a second, with no correlation to traffic or time of day.

The service ran across twelve pods, supporting SOP workflows for more than 30,000 enterprise customers. It consumed close to ten million events per day and supported daily outreach to hundreds of thousands of end users. The alerts kept coming for over a week: on most days a burst — one pod lost, then another within minutes as if the failure moved between them — and three or four on the worst days, until each burst exhausted itself and went quiet. Nothing in the standard instruments captured why.

<!-- more -->

{% asset_img debugging-recursive-json-encode-oom.png Incident build: SOP event chain, assignment engine to publish path, jsoniter codec compiler, embedded-cycle recursion and the 8 GB alert %}

Events moved through this service in both directions: it consumed upstream events through the SDK's envelope decoder, and published its own events back through the same SDK's `json` package. Each event type had its own code on the wire and its own handler.

This was the second memory incident on that path in a short window, and the two looked nothing alike. The first was a slow climb: memory rose with business peaks and eventually reached the limit. That one I had already fixed: on March 7 I moved the JSON package behind three internal SDK paths — the event SDK's shared `json`, a cache, and an executor SDK — from `encoding/json` to [jsoniter](https://github.com/json-iterator/go). At our consume rate, stdlib's unmarshal allocated heavily per event; jsoniter reused its read buffers, memory fell back and stayed down. One package-level swap armed both directions: decode and publish now went through jsoniter.

Days later, a feature iteration landed in this service. It consumed [WeCom](https://developer.work.weixin.qq.com/document/)'s owner-change event: when an employee departs, WeCom hands their customers over, and this service's assignment engine distributed those customers among the remaining staff by rule, publishing an assignment event for each split. Departures are rare — a handful per tenant per month — so these events were a small fraction of the millions of daily events. The feature had shipped once before with a flat event type, verified end to end by the automated suite on a test tenant.

The second iteration added chain support: a departing employee's customers could exceed one receiver's capacity, so the assignment engine re-dispatched the remainder to the next receiver, and that dispatch was itself an assignment event. Each re-dispatch carried the assignment it continued, so the engine could audit how one departure was split and deduplicate overlapping splits. Every step of that chain was the same event type — modeled once in the shared event SDK — so the field carrying the previous assignment pointed at the type itself. In Go, that field was an anonymous embedded pointer, following the event layer's standing convention. Every event in that chain was published through the SDK's `json` package — the one I had just switched to jsoniter. The alerts that followed were the second shape — this article's subject. A growth curve points at accumulation; a spike points at a single allocation path gone wrong — and the instruments that watched the first had nothing to say about the second.

The migration left jsoniter behind every JSON touchpoint in the service: envelope decode, cache, an executor SDK, and the publish path. The first three were dependency pins, swappable one at a time. The publish path was event-layer business code and shipped only inside the event SDK's builds. That distinction decided how the suspicion could be tested, and later how the failure was isolated.

## What the failing instrumentation could not see

Four standard instruments were considered:

- **Logs**: the triggering events were ordinary, and the process died before the consumer could record its state.
- **Scheduled pprof** sampled too infrequently to catch a sub-second spike.
- **Threshold-triggered pprof** threw false positives from normal allocation and could still miss a jump between polls.
- **Core dumps**: the memory-limit kill sent `SIGKILL` before a core could be written.

All four needed the process to survive long enough to leave evidence; this one did not. After a week it had no time signature — what it most plausibly indexed was the set of recent changes on the JSON path, which only the build could step through one at a time.

## The codec suspicion

The JSON change I knew about was my own March 7 migration, so jsoniter was the first suspect. On March 11 I swapped it for [sonic](https://github.com/bytedance/sonic) on the cache path — a dependency swap. The publish path, business code inside the SDK builds, was beyond that kind of swap and stayed on jsoniter. The OOM recurred within a day; I rolled sonic back the next morning.

That experiment ruled out the cache path, not jsoniter as a whole. Jsoniter still ran on the envelope, the executor SDK, and the publish path. No dependency swap could reach those remaining paths; stepping the SDK builds could. I stopped swapping libraries and started bisecting builds, treating the recent JSON changes as a single bundled delta.

## The bisection

On March 12 I rolled back to the last known stable build and bisected the incident delta — one staged deploy and observation window per step, eight days across eight rollbacks. The rollback gave a baseline, not an answer: with pods still dying daily, a quiet window was weak evidence, and the delta still had to be narrowed to its cause. The builds stepped the internal event SDK between versions that carried the new concrete event type and versions that did not; jsoniter itself never moved. The SDK version was the deployable handle for the bundled change: subscription-layer code and its dependency pins shipped together, so stepping it moved the new event type in and out of the process.

The bisection isolated the build delta that introduced the concrete event type. Tracing it through the service showed the assignment engine building each chain event and publishing it through the SDK's `json` package — and the publish was where jsoniter lazily compiled an encoder for the type. The reduced `TransferEvent` case reproduced the resulting unbounded traversal locally.


## The mechanism, reconstructed

The production type graph is reconstructed as containing the anonymous embedded-pointer cycle; the business shape below is likewise a reconstruction of the iteration's semantics, not a transcript of its fields.

jsoniter [compiles a codec on first use](https://github.com/json-iterator/go/blob/v1.1.12/reflect.go#L62-L72) — encoder and decoder share the same type walk — before the first byte is read or written. Named recursive fields are bounded by jsoniter's [placeholder codec](https://github.com/json-iterator/go/blob/v1.1.12/reflect.go#L135-L145). An anonymous embedded pointer takes a different path: [`describeStruct` recursively expands the embedded struct](https://github.com/json-iterator/go/blob/v1.1.12/reflect_extension.go#L348-L373) without a visited-type guard. The [decode depth limit](https://github.com/json-iterator/go/blob/v1.1.12/iter.go#L331-L338) is downstream and cannot protect a process that dies while compiling the codec.

```go
// jsoniter v1.1.12, reflect_extension.go:348-373, abridged
if field.Anonymous() && (tag == "" || tagParts[0] == "") {
    // ...
    structDescriptor := describeStruct(ctx, ptrType.Elem())
}
```

```go
type TransferEvent struct {
    *TransferEvent // the assignment this event continues
    CompanyID string `json:"companyId"`
    From      string `json:"from"`
    To        string `json:"to"`
    Reason    string `json:"reason"`
}

// jsoniter.Marshal(TransferEvent{...})
// → fatal error: stack overflow, before the first byte is written
```

## Why production became an OOM

The incident ran on Go 1.18, and the reduced case reproduces there with jsoniter `v1.1.12` — the version the service had pinned. The same case reproduced in every release from `v1.1.5` through `v1.1.12`, while the standard library and a named recursive pointer field remained safe.

Production ran multiple goroutines inside an 8 GB Pod, and jsoniter compiled each type's codec lazily, so concurrent first-use cache misses could place several goroutines in the same recursive path: process memory grew in parallel, and the Pod limit could be reached before any single goroutine hit its own stack limit — the harness below demonstrates that arithmetic. Most Pods never received a rare assignment event at all. Because the spike ended too quickly for a useful profile, the exact RSS contribution from goroutine stacks, heap objects, and runtime allocations remains unknown.

The publish call never returned: the assignment event the engine was emitting never reached the broker, and the owner-change message the service had consumed to trigger it was never acknowledged either. When the Pod was OOM-killed, its consumer connection closed with that consumed message unacknowledged. With a shared subscription, Pulsar could then redeliver that message to another consumer Pod, where the same chain would repeat the failure. This was consumer-disconnect redelivery, not an application-issued nack — the OOM never advanced any retry counter. The burst ended only when the message exhausted its redelivery budget and landed in the dead-letter topic: each departing employee's event burned through a handful of pods, then went quiet.

The harness below reproduces that loop locally as a single copy-paste program, scaled down 16× (64 MB stack walls instead of Go's ~1 GB default) and with the pod limit simulated by an RSS threshold. Each child process is one "pod": eight goroutines hit the same first-use compile, and the parent replays the unacknowledged message every time the child dies:

```go
// Command oom-harness reproduces the incident's cross-pod cycle in miniature.
// Each child process is one "pod": N goroutines hit the same first-use
// jsoniter compile of a self-embedding type. The parent is the "cluster":
// on every death it replays the unacknowledged message, as the shared
// subscription did after each OOM-killed pod disconnected.
//
//	go run .          # runs three redelivery rounds, prints per-pod peak RSS
//
// Safety: the child caps each goroutine's stack at 64 MB (16x below the
// runtime default), the parent fixes three rounds, and each pod dies in
// ~100ms — the whole run stays under a second and under 800 MB.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime/debug"
	"sync"
	"syscall"
	"time"

	jsoniter "github.com/json-iterator/go"
)

// Event is the incident's type graph, reduced: an anonymous embedded
// self-pointer. Compiling a codec for it recurses without a visited set.
type Event struct {
	*Event
	ID string `json:"id"`
}

const (
	workers    = 8   // concurrent first-use compiles per pod
	stackMB    = 64  // per-goroutine stack ceiling (production: ~1 GB)
	podLimitMB = 300 // simulated pod memory limit (production: 8 GB)
)

// child is one "pod": workers goroutines, one poison publish each.
func child() {
	debug.SetMaxStack(stackMB << 20)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = jsoniter.Marshal(Event{ID: "assign-1"}) // the publish that never returns
		}()
	}
	wg.Wait() // unreachable: the process dies inside the first-use compile
}

// peakRSS reads the finished child's peak resident set from Rusage.
// Linux reports ru_maxrss in KB, macOS in bytes.
func peakRSS(cmd *exec.Cmd) int {
	if cmd.ProcessState == nil {
		return 0
	}
	ru, ok := cmd.ProcessState.SysUsage().(*syscall.Rusage)
	if !ok {
		return 0
	}
	kb := ru.Maxrss
	if kb > 1<<20 { // bytes -> KB
		kb /= 1024
	}
	return int(kb) / 1024
}

func main() {
	if len(os.Args) > 1 { // child mode: invoked by the parent below
		child()
		return
	}
	for redelivery := 1; redelivery <= 3; redelivery++ {
		cmd := exec.Command(os.Args[0], "pod")
		start := time.Now()
		_ = cmd.Run()
		peak := peakRSS(cmd)
		fmt.Printf("redelivery %d: pod died in %v, peak RSS %d MB", redelivery,
			time.Since(start).Round(time.Millisecond), peak)
		if peak >= podLimitMB {
			fmt.Printf(" — over the %d MB pod limit: an OOMKill before any single %d MB stack wall\n",
				podLimitMB, stackMB)
		} else {
			fmt.Println()
		}
	}
}
```

```text
redelivery 1: pod died in 100ms, peak RSS 773 MB — over the 300 MB pod limit: an OOMKill before any single 64 MB stack wall
redelivery 2: pod died in 85ms, peak RSS 760 MB — over the 300 MB pod limit: an OOMKill before any single 64 MB stack wall
redelivery 3: pod died in 86ms, peak RSS 773 MB — over the 300 MB pod limit: an OOMKill before any single 64 MB stack wall
```

The peak scales with concurrency — eight goroutines × one stack each — which is the arithmetic behind the production OOM: process memory grew in parallel while the stack limit only ever guarded one goroutine at a time. On this laptop the child still dies to the stack wall (there is no cgroup to kill it first); inside a real container limit, the memory wall arrives before any goroutine's stack does, the process dies without a word, and the parent's redelivery loop is exactly the cross-pod cycle the incident showed.

Two controls in the harness's style isolate the trigger — same call, same shape, one property changed each time:

```go
// Named recursive field: jsoniter's placeholder codec terminates compilation.
type NamedEvent struct {
	Previous *NamedEvent `json:"previous,omitempty"`
	ID       string      `json:"id"`
}

_, _ = jsoniter.Marshal(NamedEvent{ID: "assign-1"}) // completes

// Same anonymous shape with the standard library: field resolution terminates.
_, _ = json.Marshal(Event{ID: "assign-1"}) // completes
```

The standard library uses a [visited map when resolving fields](https://github.com/golang/go/blob/go1.18/src/encoding/json/encode.go#L1235-L1239) — the very function jsoniter's branch lacks. The same domain shape had been serialized under `encoding/json` since the feature first shipped; only jsoniter's compilation entered the failing traversal.

Sonic avoids the failing traversal at the field-resolution step. In `v1.14.0`, its resolver [delegates to `encoding/json.typeFields`](https://github.com/bytedance/sonic/blob/v1.14.0/internal/resolver/stubs_latest.go#L49-L51); in `v1.14.1` and `v1.15.4`, it performs that traversal locally [with a visited-type map](https://github.com/bytedance/sonic/blob/v1.14.1/internal/resolver/fields.go#L49-L75). Both approaches stop revisiting the anonymously embedded type. Separately, sonic's JIT and optimized codec compilers [track types already being compiled](https://github.com/bytedance/sonic/blob/v1.14.0/internal/decoder/jitdec/compiler.go#L595-L609) and handle recursive fields without repeatedly expanding their work. For this embedded-cycle case, the field-resolution guard is the relevant protection. These are retrospective checks against `v1.14.0`, `v1.14.1`, and `v1.15.4` (Go `1.24.9`, macOS, both the JIT and optimized paths encoding and decoding the payload); they verify the reduced case, not the production sonic version or runtime.

## Why the automated suite stayed green

The suite that had verified the first release stayed green for a mechanical reason. It exercised the real chain on a test tenant — simulate a departure, let the engine publish, consume — but by the time this iteration ran, that tenant's engine had been switched off for a parallel feature's testing, and nothing flagged the gap: the suite's greens looked exactly like a passed run. With the engine off, no assignment event was ever built; nothing published; and jsoniter compiles a codec only on first use — zero publishes meant zero compilations. The green was real but empty: no test ever reached this change. Unit tests could not either — they call the engine with struct literals and never serialize an event.

## The fix

With the cause isolated, the fix followed directly: I moved the publish path to sonic, and only that path — the publisher took its own sonic reference instead of the SDK's shared `json`, so the envelope and other consumers of the shared variable kept jsoniter. The move was validated first against the reduced reproduction, which sonic encodes without entering the failing traversal. The jsoniter migration kept the win it had already delivered: the envelope and cache paths stayed on it, and the slow-climb incident did not come back. Fixing the type instead (adding a field name or tag to break the anonymous embedding) would also have closed this failure, as the named-field control demonstrates; the migration was chosen because it left the shared event contract untouched while covering every event type at once.

The production OOM stopped after the migration and never recurred through the months that followed, while the service kept running until I left the company. The reduced reproduction also stopped triggering the fatal recursive failure under sonic. These results make the publish-path encoder the strongest operational explanation for the OOM. They do not identify the exact production RSS split between goroutine stacks, heap, and runtime allocations; the spike ended before a useful profile could be captured. The type graph itself remained unchanged; the source comparison in the previous section explains why sonic handles the embedded cycle.

## Lessons from the investigation

- When runtime evidence cannot narrow a sporadic failure, the build is the remaining variable. An observation window without a crash is weak evidence; a build delta is a bounded change set that can be traced and reduced.
- Before swapping a codec to clear a suspicion, map which code paths the swap can actually reach. Reachability, not codec preference, decides what a negative result proves.
- A legal Go type can exercise an unguarded traversal inside a library, and first-use codec compilation happens before any byte is read or written — so throughput benchmarks and payload tests cannot see this failure class. Representative type graphs can.
- A service that dies mid-publish turns a local codec failure into a cross-Pod incident through unacknowledged redelivery. The retry and dead-letter configuration must be treated as part of the failure path, not as an assumption about application-level nack handling.

This incident made reflected type graphs part of what I review in a dependency change.

---

*Previous in this series: [Building a Production Go Scheduler for 200K+ Delayed Jobs per Second](/posts/engineering-case-study/building-a-production-go-scheduler-for-200k-delayed-jobs-per-second/)*.

*Next in this series: [Scaling Four Engineers to Eighteen Go Services with Generated Contracts](/posts/engineering-case-study/scaling-four-engineers-to-eighteen-go-services-with-generated-contracts/)*.
