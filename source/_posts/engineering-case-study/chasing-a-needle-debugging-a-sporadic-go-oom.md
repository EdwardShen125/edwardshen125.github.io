---
title: "Chasing a Needle: Debugging a Sporadic Go OOM That Left No Trace"
date: 2025-10-01 10:00:00
categories:
  - Engineering Case Study
tags:
  - go
  - json
  - oom
  - production-debugging
  - event-driven
description: A Go consumer hit 8 GB in under a second, days after a codec migration had fixed an unrelated slow-memory climb. Build bisection traced the spike to jsoniter compiling a decoder for a recursive type graph; only the affected decode path moved to sonic.
seo_image: chasing-a-needle-oom.png
---

The alert came from Grafana. A Go service consuming SOP-dispatch events on Pulsar hit its 8 GB limit and restarted; memory went from flat to the ceiling in under a second, with no correlation to traffic or time of day, and the events involved were ordinary.

The service ran across twelve pods, supporting SOP workflows for more than 30,000 enterprise customers. It consumed close to ten million events per day and supported daily outreach to hundreds of thousands of end users. The alerts kept coming for over a week before the cause was found: at least one pod lost per day, three or four on the worst days, and none of the standard instruments captured why.

<!-- more -->

{% asset_img chasing-a-needle-oom.png Incident build: SOP event consumption path, two decode stages, jsoniter decoder compiler, embedded-cycle recursion and the 8 GB alert %}

The consumer decoded each message in two stages: the event SDK decoded the envelope into `Data interface{}`, then the subscription layer turned that value back into bytes and unmarshaled them into a concrete Go event type.

This was the second memory incident on that path in a short window, and the two looked nothing alike. The first was a slow climb: memory rose with business peaks and eventually reached the limit. That one I had already fixed: on March 7 I moved three internal decode paths — envelope, cache, and an executor SDK — from `encoding/json` to [jsoniter](https://github.com/json-iterator/go), and memory fell back and stayed down. Days later, a different change reached the subscription layer: it introduced a concrete Go event type and moved the stage-two typed decode onto the jsoniter I had just put in place. The alerts that followed were the second shape — this article's subject. A growth curve points at accumulation; a spike points at a single allocation path gone wrong — and the instruments that watched the first had nothing to say about the second.

The two changes left the service with four decode paths running jsoniter: the event envelope, the cache, an executor SDK — all three from my migration — and the stage-two typed decode, from the later change. The first three were dependency pins, swappable one at a time. The typed decode was subscription-layer business code and shipped only inside the event SDK's builds. That distinction decided how the suspicion could be tested, and later how the failure was isolated.

## What the failing instrumentation could not see

Four standard instruments were considered:

- **Logs**: the triggering events were ordinary, and the process died before the consumer could record its state.
- **Scheduled pprof** sampled too infrequently to catch a sub-second spike.
- **Threshold-triggered pprof** threw false positives from normal allocation and could still miss a jump between polls.
- **Core dumps**: the memory-limit kill sent `SIGKILL` before a core could be written.

All four needed the process to survive long enough to leave evidence; this one did not. After a week it had no time signature — it was indexed by something other than time, and what it most plausibly indexed was the set of recent changes on the decode path, which only the build could step through one at a time.

## The codec suspicion

The decode-path change I knew about was my own March 7 migration, so jsoniter was the first suspect. On March 11 I swapped it for sonic on the cache path — a dependency swap. The typed decode, business code inside the SDK builds, was beyond that kind of swap and stayed on jsoniter. The OOM recurred within a day; I rolled sonic back the next morning.

That cleared the cache path only: jsoniter still ran on the envelope, the executor SDK, and the typed decode. No dependency swap could reach those remaining paths; stepping the SDK builds could. I stopped swapping libraries and started bisecting builds, treating the recent decode-path changes as a single bundled delta.

## The bisection

On March 12 I rolled back to the last known stable build and bisected the incident delta — one staged deploy and observation window per step, eight days across eight rollbacks. The builds stepped the internal event SDK between versions that carried the new concrete event type and versions that did not; jsoniter itself never moved. The SDK version was the deployable handle for the bundled change: subscription-layer code and its dependency pins shipped together, so stepping it moved the new event type in and out of the process.

The bisection isolated the build delta that introduced the concrete event type. Tracing it through the consumer: the event SDK decoded the envelope into `Data interface{}`, the subscription layer marshaled that value back to bytes and unmarshaled them into the concrete Go event type, and the unmarshal half was where jsoniter, unguarded, compiled a decoder. Reading the code, I matched the mechanism to the production symptoms: an anonymous embedded-pointer cycle. The reduced `NodeEmbed` case reproduced it locally.

**The newest published jsoniter release still reproduced the failure** — `v1.1.12`, the version the service had pinned. The root cause was the collision the two changes had created: a type graph with an anonymous embedded-pointer cycle had arrived on a decode path that jsoniter — unguarded on that branch — now compiled. The `interface{}` round trip was part of the path that exposed it in this service. Neither change was wrong alone; the March 7 migration had held memory down for days, and the recursive type graph was valid Go.

I moved the affected typed event decode path to sonic, and only that path. The jsoniter migration kept the win it had already delivered: the envelope and cache decodes stayed on it, and the slow-climb incident did not come back. Fixing the type instead (adding a field name or tag to break the anonymous embedding) would also have closed this failure, as the named-field control below demonstrates; the migration was chosen because it left the shared event contract untouched while covering every event type at once.

The production OOM stopped with the migration and never recurred through the months that followed, while the service kept running until I left the company. The type graph itself remained unchanged; sonic handled the embedded cycle without unbounded field expansion. The source comparison below explains that difference.

## The mechanism, reconstructed

The production type graph is reconstructed as containing the anonymous embedded-pointer cycle; `NodeEmbed` is a reduced reproduction, not a claim that every production field was identical.

jsoniter [compiles a decoder on first use](https://github.com/json-iterator/go/blob/v1.1.12/reflect.go#L62-L72), before decoding the first byte. Named recursive fields are bounded by jsoniter's [placeholder decoder](https://github.com/json-iterator/go/blob/v1.1.12/reflect.go#L135-L145). An anonymous embedded pointer takes a different path: [`describeStruct` recursively expands the embedded struct](https://github.com/json-iterator/go/blob/v1.1.12/reflect_extension.go#L348-L373) without a visited-type guard. The [decode depth limit](https://github.com/json-iterator/go/blob/v1.1.12/iter.go#L331-L338) is downstream and cannot protect a process that dies while compiling the decoder.

```go
// jsoniter v1.1.12, reflect_extension.go:348-373, abridged
if field.Anonymous() && (tag == "" || tagParts[0] == "") {
    // ...
    structDescriptor := describeStruct(ctx, ptrType.Elem())
}
```

```go
type NodeEmbed struct {
    *NodeEmbed
    ID   string `json:"id"`
    Name string `json:"name"`
}

// jsoniter.Unmarshal([]byte(`{"id":"1","name":"ev"}`), &NodeEmbed{})
// → fatal error: stack overflow
```

The incident ran Go 1.18, and the crash reproduces there with jsoniter `v1.1.12`. The same embedded-pointer case reproduced in every release from `v1.1.5` through `v1.1.12`, while the standard library and a named recursive pointer field remained safe. Leaving the unused `Name` field out of the payload does not change the outcome. Unbounded, the failing decode grows until the goroutine hits the runtime's default 1 GB stack ceiling, which is why the harness below caps it; that measurement describes the failure shape, not the production 8 GB RSS.

The standard library uses a [visited map when resolving fields](https://github.com/golang/go/blob/go1.18/src/encoding/json/encode.go#L1235-L1239). The same domain shape crossed the service boundary daily (upstream services serialized those events with `encoding/json`), and it was only the consumer's jsoniter compilation that died on it.

Sonic avoids the failing traversal at the field-resolution step. In `v1.14.0`, its resolver [delegates to `encoding/json.typeFields`](https://github.com/bytedance/sonic/blob/v1.14.0/internal/resolver/stubs_latest.go#L49-L51); in `v1.14.1` and `v1.15.4`, it performs that traversal locally [with a visited-type map](https://github.com/bytedance/sonic/blob/v1.14.1/internal/resolver/fields.go#L49-L75). Both approaches stop revisiting the anonymously embedded type. Separately, sonic's JIT and optimized decoder compilers [track types already being compiled](https://github.com/bytedance/sonic/blob/v1.14.0/internal/decoder/jitdec/compiler.go#L595-L609) and handle recursive fields without repeatedly expanding their decoders. For this `NodeEmbed` case, the field-resolution guard is the relevant protection. These are retrospective checks against `v1.14.0`, `v1.14.1`, and `v1.15.4` (Go `1.24.9`, macOS, JIT and optimized decoder paths both decoding the payload); they verify the reduced case, not the production sonic version or runtime.

## Reproducing it safely

No production traffic and no large message is needed — the type graph alone triggers it. The abridged program below shows the types and the three decode cases.

```go
// Abridged from the runnable harness; the full program isolates each case
// in a child process, with a timeout and capped output capture.
package main

import (
	"encoding/json"
	"runtime/debug"

	jsoniter "github.com/json-iterator/go"
)

// NodeEmbed is the reduced production type graph: an anonymous embedded
// pointer to its own type. jsoniter's describeStruct follows it without
// recording visited types, so compiling a decoder never terminates.
type NodeEmbed struct {
	*NodeEmbed        // anonymous embedded pointer -> cycle in the type graph
	ID         string `json:"id"`
	Name       string `json:"name"`
}

// NodeNamed is the control: the same cycle as a named field. jsoniter
// memoizes a placeholder decoder for named recursive fields, so compilation
// terminates.
type NodeNamed struct {
	Self *NodeNamed `json:"self,omitempty"` // named pointer -> placeholder decoder
	ID   string     `json:"id"`
	Name string     `json:"name"`
}

// 22 bytes; the crash depends on the type graph, not the input.
var payload = []byte(`{"id":"1","name":"ev"}`)

func runChild(mode string) {
	debug.SetMaxStack(1 << 20) // cap the climb at 1 MiB instead of the runtime's 1 GB
	switch mode {
	case "embed":
		var v NodeEmbed
		// Fatal: jsoniter compiles a decoder for NodeEmbed before reading
		// any input, and the compilation recurses without a visited-type guard.
		_ = jsoniter.Unmarshal(payload, &v)
	case "named":
		var v NodeNamed
		_ = jsoniter.Unmarshal(payload, &v) // terminates: named field -> placeholder
	case "std":
		var v NodeEmbed
		_ = json.Unmarshal(payload, &v) // terminates: visited set ends the walk
	}
}
```

Observed output of the full harness (Go 1.24.9, darwin/arm64; timings and pointer values vary per run):

```text
go=go1.24.9 jsoniter=v1.1.12

case: jsoniter + anonymous embedded pointer (root cause)
  result: child exited with code 2 after 9ms
  child peak RSS: 6.9 MiB
  stderr: runtime: goroutine stack exceeds 1048576-byte limit
  stderr: runtime: sp=0x14000260360 stack=[0x14000260000, 0x14000360000]
  stderr: fatal error: stack overflow
  recursing frame: describeStruct — reflect_extension.go:362 (84 frames captured)
  verdict: as expected — the decoder compiles recursively until the stack is gone

case: jsoniter + named recursive pointer (control)
  result: completed normally in 3ms
  child peak RSS: 4.6 MiB
  stdout: decoded id="1" name="ev"
  verdict: as expected — the control decoded the payload without recursing

case: encoding/json + anonymous embedded pointer (control)
  result: completed normally in 4ms
  child peak RSS: 4.5 MiB
  stdout: decoded id="1" name="ev"
  verdict: as expected — the control decoded the payload without recursing

3/3 cases behaved as expected
```

The full harness exists because a stack overflow is fatal — `recover` cannot intercept it — so each case runs in a child process of the same binary and the parent survives to report:
- **The child caps its own stack.** `debug.SetMaxStack(1 << 20)` bounds that goroutine's stack at 1 MiB, so the climb that would otherwise reach the runtime's 1 GB default ends in milliseconds with a peak under 10 MiB. The parent adds a 20 s timeout as a backstop and caps the output it keeps at 64 KiB. These bounds limit the harness's own footprint; they are not a process-wide memory limit.
- **The parent measures the child's peak RSS**, so the harness's footprint is reported rather than assumed.

The controls carry the argument: the named recursive field and `encoding/json` decode the same payload in about 4 ms at under 5 MiB, and only the anonymous embedded pointer crashes. The embedded pointer is legal Go and another decoder reads it happily — the failure is a property of the codec's traversal, not of an invalid type. The harness asserts each outcome and exits non-zero on a mismatch, so it works as a test, not only a demonstration.

## Lessons from the investigation

- When runtime evidence cannot narrow a sporadic failure, the build is the remaining variable. An observation window without a crash is weak evidence; a build delta is a bounded change set that can be traced and reduced.
- A codec swap tests one path, not the codec. The cache-path swap could not reach the typed decode; only the SDK builds could step through the remaining paths — that asymmetry, not codec preference, chose the method.
- A legal Go type can exercise an unguarded traversal inside a library, and first-use decoder compilation happens before any input is read — so payload size, traffic volume, and throughput benchmarks cannot see the failure class. Representative type graphs can.

This incident made reflected type graphs part of what I review in a dependency change.

---

*Previous in this series: [Building a Production Go Scheduler for 200K+ Delayed Jobs per Second](/posts/engineering-case-study/building-a-production-go-scheduler-for-200k-delayed-jobs-per-second/).* The scheduling center described there is the same platform this incident lived on.

*Next in this series: [Scaling Four Engineers to Eighteen Go Services with Generated Contracts](/posts/engineering-case-study/scaling-four-engineers-to-eighteen-go-services-with-generated-contracts/).*