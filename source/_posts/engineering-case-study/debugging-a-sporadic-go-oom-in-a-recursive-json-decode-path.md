---
title: "Debugging a Sporadic Go OOM in a Recursive JSON Decode Path"
date: 2025-10-01 10:00:00
categories:
  - Engineering Case Study
tags:
  - go
  - json
  - oom
  - production-debugging
  - event-driven
description: A Go consumer reached its 8 GB Pod memory limit when a recursive event type entered jsoniter's lazy decoder compilation path. Build bisection isolated the type and decode path; moving only that path to sonic stopped the incident.
seo_image: debugging-recursive-json-decode-oom.png
---

The alert came from Grafana. A Go service consuming SOP-dispatch events on Pulsar reached its 8 GB Pod memory limit and restarted; process memory went from flat to the limit in under a second, with no correlation to traffic or time of day.

The service ran across twelve pods, supporting SOP workflows for more than 30,000 enterprise customers. It consumed close to ten million events per day and supported daily outreach to hundreds of thousands of end users. The alerts kept coming for over a week: at least one pod lost per day, three or four on the worst days, and none of the standard instruments captured why.

<!-- more -->

{% asset_img debugging-recursive-json-decode-oom.png Incident build: SOP event consumption path, two decode stages, jsoniter decoder compiler, embedded-cycle recursion and the 8 GB alert %}

The consumer decoded each message in two stages: the event SDK decoded the envelope into `Data interface{}`, then the subscription layer turned that value back into bytes and unmarshaled them into a concrete Go event type. Each event type had its own code on the wire — send-message, tag-change, assignment — and its own registered handler with its own typed unmarshal.

This was the second memory incident on that path in a short window, and the two looked nothing alike. The first was a slow climb: memory rose with business peaks and eventually reached the limit. That one I had already fixed: on March 7 I moved three internal decode paths — envelope, cache, and an executor SDK — from `encoding/json` to [jsoniter](https://github.com/json-iterator/go), and memory fell back and stayed down. Days later, a feature iteration reached the subscription layer. The feature consumed [WeCom](https://developer.work.weixin.qq.com/document/)'s owner-change event: when an employee departs, WeCom hands their customers over, and the producing service's assignment engine distributed those customers among the remaining staff by rule. Departures themselves are rare — a handful per tenant per month — so the event was a small fraction of the millions of daily events. The feature had shipped once before with a flat event type, verified end to end by the automated suite on a test tenant.

The second iteration added chain support: a departing employee's customers could exceed one receiver's capacity, so the producing service's assignment engine re-dispatched the remainder to the next receiver, and that dispatch was itself an assignment event. Each re-dispatch carried the assignment it continued, so the engine could audit how one departure was split and deduplicate overlapping splits. Every step of that chain was the same event type — modeled once in the shared event SDK — so the field carrying the previous assignment pointed at the type itself. In Go, that field was an anonymous embedded pointer, following the event layer's standing convention. The stage-two typed decode now ran on the jsoniter I had just put in place. The alerts that followed were the second shape — this article's subject. A growth curve points at accumulation; a spike points at a single allocation path gone wrong — and the instruments that watched the first had nothing to say about the second.

The two changes left the service with four decode paths running jsoniter: the event envelope, the cache, an executor SDK — all three from my migration — and the stage-two typed decode, from the later change. The first three were dependency pins, swappable one at a time. The typed decode was subscription-layer business code and shipped only inside the event SDK's builds. That distinction decided how the suspicion could be tested, and later how the failure was isolated.

## What the failing instrumentation could not see

Four standard instruments were considered:

- **Logs**: the triggering events were ordinary, and the process died before the consumer could record its state.
- **Scheduled pprof** sampled too infrequently to catch a sub-second spike.
- **Threshold-triggered pprof** threw false positives from normal allocation and could still miss a jump between polls.
- **Core dumps**: the memory-limit kill sent `SIGKILL` before a core could be written.

All four needed the process to survive long enough to leave evidence; this one did not. After a week it had no time signature — what it most plausibly indexed was the set of recent changes on the decode path, which only the build could step through one at a time.

## The codec suspicion

The decode-path change I knew about was my own March 7 migration, so jsoniter was the first suspect. On March 11 I swapped it for sonic on the cache path — a dependency swap. The typed decode, business code inside the SDK builds, was beyond that kind of swap and stayed on jsoniter. The OOM recurred within a day; I rolled sonic back the next morning.

That experiment ruled out the cache path, not jsoniter as a whole. Jsoniter still ran on the envelope, the executor SDK, and the typed decode. No dependency swap could reach those remaining paths; stepping the SDK builds could. I stopped swapping libraries and started bisecting builds, treating the recent decode-path changes as a single bundled delta.

## The bisection

On March 12 I rolled back to the last known stable build and bisected the incident delta — one staged deploy and observation window per step, eight days across eight rollbacks. The rollback gave a baseline, not an answer: with pods still dying daily, a quiet window was weak evidence, and the delta still had to be narrowed to its cause. The builds stepped the internal event SDK between versions that carried the new concrete event type and versions that did not; jsoniter itself never moved. The SDK version was the deployable handle for the bundled change: subscription-layer code and its dependency pins shipped together, so stepping it moved the new event type in and out of the process.

The bisection isolated the build delta that introduced the concrete event type. Tracing it through the consumer showed that the event SDK decoded the envelope into `Data interface{}`, then the subscription layer marshaled that value back to bytes and unmarshaled it into the concrete Go event type. That second unmarshal was where jsoniter lazily compiled the decoder. The reduced `TransferEvent` case reproduced the resulting unbounded traversal locally.

The production service consumed messages with multiple goroutines, which shaped how the spike reached the Pod limit — that mechanism is reconstructed below.

## The mechanism, reconstructed

The production type graph is reconstructed as containing the anonymous embedded-pointer cycle; the business shape below is likewise a reconstruction of the iteration's semantics, not a transcript of its fields.

jsoniter [compiles a decoder on first use](https://github.com/json-iterator/go/blob/v1.1.12/reflect.go#L62-L72), before decoding the first byte. Named recursive fields are bounded by jsoniter's [placeholder decoder](https://github.com/json-iterator/go/blob/v1.1.12/reflect.go#L135-L145). An anonymous embedded pointer takes a different path: [`describeStruct` recursively expands the embedded struct](https://github.com/json-iterator/go/blob/v1.1.12/reflect_extension.go#L348-L373) without a visited-type guard. The [decode depth limit](https://github.com/json-iterator/go/blob/v1.1.12/iter.go#L331-L338) is downstream and cannot protect a process that dies while compiling the decoder.

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

// jsoniter.Unmarshal([]byte(`{"companyId":"acme",...}`), &TransferEvent{})
// → fatal error: stack overflow, before the first byte is read
```

## Why production became an OOM

The incident ran on Go 1.18, and the reduced case reproduces there with jsoniter `v1.1.12` — the newest published release, and the version the service had pinned. The same embedded-pointer case reproduced in every release from `v1.1.5` through `v1.1.12`, while the standard library and a named recursive pointer field remained safe.

The local reproduction used one goroutine and ended when that goroutine reached Go's default maximum stack of about 1 GB. Production used multiple consumer goroutines inside an 8 GB Pod. Several first-use decodes could therefore grow process memory concurrently, allowing the Pod limit to be reached before any individual goroutine reached its own stack limit. Because the spike ended too quickly for a useful profile, the exact RSS contribution from goroutine stacks, heap objects, and runtime allocations remains unknown.

Jsoniter compiled each type's decoder lazily. Most Pods never received the rare assignment event. A Pod that did receive one could enter the recursive path through several consumer goroutines; because the decoder became available only after compilation completed, concurrent first-use cache misses could have placed several goroutines in the same recursive path.

The decode call never returned to the message handler. The handler therefore had no opportunity to acknowledge or negatively acknowledge the message. When the Pod was OOM-killed, its consumer connection closed with the assignment message unacknowledged. With a shared subscription, Pulsar could then redeliver that message to another consumer Pod, where the same type and decode path could repeat the failure. This was consumer-disconnect redelivery, not an application-issued negative acknowledgment. Whether the cycle eventually reached a dead-letter topic depended on the configured retry and dead-letter behavior; the OOM itself did not advance a business-level nack counter.

The standard library uses a [visited map when resolving fields](https://github.com/golang/go/blob/go1.18/src/encoding/json/encode.go#L1235-L1239). The same domain shape crossed the service boundary daily under `encoding/json`; only the consumer's jsoniter compilation entered the failing traversal.

Sonic avoids the failing traversal at the field-resolution step. In `v1.14.0`, its resolver [delegates to `encoding/json.typeFields`](https://github.com/bytedance/sonic/blob/v1.14.0/internal/resolver/stubs_latest.go#L49-L51); in `v1.14.1` and `v1.15.4`, it performs that traversal locally [with a visited-type map](https://github.com/bytedance/sonic/blob/v1.14.1/internal/resolver/fields.go#L49-L75). Both approaches stop revisiting the anonymously embedded type. Separately, sonic's JIT and optimized decoder compilers [track types already being compiled](https://github.com/bytedance/sonic/blob/v1.14.0/internal/decoder/jitdec/compiler.go#L595-L609) and handle recursive fields without repeatedly expanding their decoders. For this embedded-cycle case, the field-resolution guard is the relevant protection. These are retrospective checks against `v1.14.0`, `v1.14.1`, and `v1.15.4` (Go `1.24.9`, macOS, JIT and optimized decoder paths both decoding the payload); they verify the reduced case, not the production sonic version or runtime.

## Reproducing the mechanism safely

The smallest useful reproduction keeps only the recursive type and the decoder call. Run the failing case in a child process or with a low stack limit; it is a fatal runtime error and cannot be recovered with `recover`.

```go
package main

import (
	"encoding/json"
	"fmt"

	jsoniter "github.com/json-iterator/go"
)

type Event struct {
	*Event // anonymous embedded pointer to the same type
	ID string `json:"id"`
}

func main() {
	payload := []byte(`{"id":"assign-1"}`)
	var event Event
	jsoniter.Unmarshal(payload, &event)
	fmt.Println("unreachable")
}

// jsoniter v1.1.12:
// fatal error: stack overflow
// before the first JSON byte is decoded
```

The payload is ordinary JSON. The failure happens while jsoniter lazily compiles a decoder for `Event`: `describeStruct` sees the anonymous embedded pointer, expands `Event` again, and never reaches the payload. Two controls isolate the trigger:

```go
// Named recursive field: jsoniter's placeholder decoder terminates compilation.
type NamedEvent struct {
	Previous *NamedEvent `json:"previous,omitempty"`
	ID       string      `json:"id"`
}

var named NamedEvent
_ = jsoniter.Unmarshal(payload, &named) // completes

// Same anonymous shape with the standard library: field resolution terminates.
var stdlib Event
_ = json.Unmarshal(payload, &stdlib) // completes
```

The production type had more fields; this is a reduced type graph, and the single-goroutine demo does not reproduce the Pod's memory profile — that difference is reconstructed above.

## Why the automated suite stayed green

The suite that had verified the first release stayed green for a mechanical reason. It drove real events through the consumer on a test tenant, but by the time this iteration ran, that tenant's assignment toggle had been turned off for a parallel feature's testing. Every event type carries its own code on the wire, and the consumer dispatches on that code — each code reaches its own unmarshal into its own Go type. With the toggle off, no message carried the assignment code, so its typed unmarshal never executed. And jsoniter builds each type's decoder lazily: it compiles it the first time that type is decoded, and caches it for the process's life — zero executions meant zero compilations. The suite did not test this change and pass; it never reached it. Neither did unit tests, which call handlers with struct literals and never touch a codec.

## The fix

With the cause isolated, the fix followed directly: I moved the affected typed event decode path to sonic, and only that path — validated first against the reduced reproduction, which sonic decodes without entering the failing traversal. The jsoniter migration kept the win it had already delivered: the envelope and cache decodes stayed on it, and the slow-climb incident did not come back. Fixing the type instead (adding a field name or tag to break the anonymous embedding) would also have closed this failure, as the named-field control below demonstrates; the migration was chosen because it left the shared event contract untouched while covering every event type at once.

The production OOM stopped after the migration and never recurred through the months that followed, while the service kept running until I left the company. The reduced reproduction also stopped triggering the fatal recursive failure under sonic. These results make the typed decoder path the strongest operational explanation for the OOM. They do not identify the exact production RSS split between goroutine stacks, heap, and runtime allocations; the spike ended before a useful profile could be captured. The type graph itself remained unchanged; the source comparison below explains why sonic handles the embedded cycle.

## Lessons from the investigation

- When runtime evidence cannot narrow a sporadic failure, the build is the remaining variable. An observation window without a crash is weak evidence; a build delta is a bounded change set that can be traced and reduced.
- Before swapping a codec to clear a suspicion, map which decode paths the swap can actually reach. Reachability, not codec preference, decides what a negative result proves.
- A legal Go type can exercise an unguarded traversal inside a library, and first-use decoder compilation happens before any input is read — so throughput benchmarks and payload tests cannot see this failure class. Representative type graphs can.
- A consumer that dies before acknowledging a poison message can turn a local decoder failure into a cross-Pod incident. The retry and dead-letter configuration must be treated as part of the failure path, not as an assumption about application-level nack handling.

This incident made reflected type graphs part of what I review in a dependency change.

*Previous in this series: [Building a Production Go Scheduler for 200K+ Delayed Jobs per Second](/posts/engineering-case-study/building-a-production-go-scheduler-for-200k-delayed-jobs-per-second/).* The scheduling center described there is the same platform this incident lived on.

*Next in this series: [Scaling Four Engineers to Eighteen Go Services with Generated Contracts](/posts/engineering-case-study/scaling-four-engineers-to-eighteen-go-services-with-generated-contracts/).*