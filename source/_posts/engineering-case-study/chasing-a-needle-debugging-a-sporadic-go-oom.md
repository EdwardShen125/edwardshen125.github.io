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
description: A Go consumer hit 8 GB in under a second, days after a codec migration had fixed an unrelated slow-memory climb. Build bisection traced the spike to a nested type meeting jsoniter's decoder compilation; only the affected decode path moved to sonic.
seo_image: chasing-a-needle-oom.png
---

The alert came from Grafana. A Go service consuming SOP-dispatch events on Pulsar hit its 8 GB limit and restarted; memory went from flat to the ceiling in under a second, with no correlation to traffic or time of day, and the events involved were ordinary.

The service ran across twelve pods, supporting SOP workflows for more than 30,000 enterprise customers. It consumed close to ten million events per day and supported daily outreach to hundreds of thousands of end users. The alerts kept coming for over a week before the cause was found: at least one pod lost per day, three or four on the worst days, and none of the standard instruments (logs, scheduled pprof, threshold-triggered pprof, core dumps) captured why.

<!-- more -->

{% asset_img chasing-a-needle-oom.png Incident build: SOP event consumption path, two decode stages, jsoniter decoder compiler, embedded-cycle recursion and the 8 GB alert %}

The consumer decoded each message in two stages: the event SDK decoded the envelope into `Data interface{}`, then the subscription layer turned that value back into bytes and unmarshaled them into the concrete event model.

This was the second memory incident on that path in a short window, and the two looked nothing alike. The first was a slow climb: memory rose with business peaks and eventually reached the limit. That one I had already fixed: on March 7 I moved three internal decode paths — envelope, cache, and an executor SDK — from `encoding/json` to [jsoniter](https://github.com/json-iterator/go), and memory fell back and stayed down. Days later, a different change reached the subscription layer: it introduced a typed event model and moved the stage-two typed decode onto the jsoniter I had just put in place. The alerts that followed were the spike this article is about: flat to ceiling in under a second, tied to no traffic pattern. A growth curve points at accumulation; a spike points at a single allocation path gone wrong — and the instruments that watched the first had nothing to say about the second.

The two changes left the service with four decode paths running jsoniter: the event envelope, the cache, an executor SDK — all three from my migration — and the stage-two typed decode, from the later change. The first three were dependency pins, swappable one at a time. The typed decode was subscription-layer business code and shipped only inside the event SDK's builds. That distinction decided how the suspicion could be tested, and later how the failure was isolated.

## What the failing instrumentation could not see

Four standard instruments were considered:

- **Logs**: the triggering events were ordinary, and the process died before the consumer could record its state.
- **Scheduled pprof** sampled too infrequently to catch a sub-second spike.
- **Threshold-triggered pprof** threw false positives from normal allocation and could still miss a jump between polls.
- **Core dumps**: the memory-limit kill sent `SIGKILL` before a core could be written.

All four needed the process to survive long enough to leave evidence; this one did not. After a week it had no time signature — it was indexed by something other than time, and what it most plausibly indexed was the set of recent changes on the decode path, which only the build could step through one at a time.

## The codec suspicion

The most recent decode-path change was my own March 7 migration, so jsoniter was the first suspect. On March 11 I swapped it for sonic on the cache path — a dependency swap. The typed decode, business code inside the SDK builds, was beyond that kind of swap and stayed on jsoniter. The OOM recurred within a day; I rolled sonic back the next morning.

That cleared the cache path only: jsoniter still ran on the envelope, the executor SDK, and the typed decode, and the root cause sat on the last of those. No dependency swap could step through those paths one at a time; stepping the SDK builds could. I stopped swapping libraries and started bisecting builds, treating the recent decode-path changes as a single bundled delta.

## The bisection

On March 12 I rolled back to the last known stable build and bisected the incident delta — one staged deploy and observation window per step, eight days across eight rollbacks. The builds stepped the internal event SDK between versions that carried the typed-event change and versions that did not; jsoniter itself never moved. The SDK version was the deployable handle for the bundled change: subscription-layer code and its dependency pins shipped together, so stepping it moved the nested-structure change in and out of the process.

The bisection isolated the typed-event build delta. Tracing it through the consumer: the event SDK decoded the envelope into `Data interface{}`, the subscription layer marshaled that value back to bytes and unmarshaled them into the concrete event model, and the unmarshal half was where jsoniter, unguarded, compiled a decoder. Reading the code, I matched the mechanism to the production symptoms: an anonymous embedded-pointer cycle. The reduced `NodeEmbed` case reproduced it locally.

**The newest published jsoniter release still reproduced the failure** — `v1.1.12`, the version the service had pinned. The root cause was the collision the two changes had created: a type graph with an anonymous embedded-pointer cycle had arrived on a decode path that jsoniter — unguarded on that branch — now compiled. The `interface{}` round trip was part of the path that exposed it in this service. Neither change was wrong alone; the March 7 migration had held memory down for days, and the nested type was legal Go.

I moved the affected typed-event decode path to sonic, and only that path. The jsoniter migration kept the win it had already delivered: the envelope and cache decodes stayed on it, and the slow-climb incident did not come back. Fixing the type instead (adding a field name or tag to break the anonymous embedding) would also have closed this failure, as the named-field control below demonstrates; the migration was chosen because it left the shared event contract untouched while covering every event model at once.

The production OOM stopped with the migration and never recurred through the months that followed, while the service kept running until I left the company. The type graph itself remained unchanged; sonic handled the embedded cycle without unbounded field expansion. The source comparison below explains that difference.

## The mechanism, reconstructed

The production event model is reconstructed as containing the self-nesting structure; `NodeEmbed` is a reduced reproduction, not a claim that every field was identical. The 8 GB ceiling and sub-second jump are production observations; the local reproduction, with its bounded stack, is separate evidence.

jsoniter compiles a decoder on first use, before decoding the first byte. Named recursive fields are bounded by jsoniter's placeholder decoder. An anonymous embedded pointer takes a different path: `describeStruct` recursively expands the embedded struct without a visited-type guard. The decode depth limit is downstream and cannot protect a process that dies while compiling the decoder.

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

The incident ran Go 1.18, and the crash reproduces there with jsoniter `v1.1.12`. The same embedded-pointer case reproduced in every release from `v1.1.5` through `v1.1.12`, while the standard library and a named recursive pointer field remained safe. Leaving the unused `Name` field out of the payload does not change the outcome either. Unbounded, the failing decode grows until the goroutine hits the runtime's default 1 GB stack ceiling, which is why the harness below caps it; that measurement describes the failure shape, not the production 8 GB RSS.

The standard library uses a visited map when resolving fields. The same domain shape crossed this boundary daily (upstream services serialized those events with `encoding/json`), and it was only the consumer's jsoniter compilation that died on it.

Sonic avoids the failing traversal at the field-resolution step. In `v1.14.0`, its resolver delegates to `encoding/json.typeFields`; in `v1.14.1` and `v1.15.4`, it performs that traversal locally with a visited-type map. Both approaches stop revisiting the anonymously embedded type. Separately, sonic's JIT and optimized decoder compilers track types already being compiled and handle recursive fields without repeatedly expanding their decoders. For this `NodeEmbed` case, the field-resolution guard is the relevant protection.

Source references:

- jsoniter v1.1.12 `reflect_extension.go:348-373` — [embedded-pointer branch](https://github.com/json-iterator/go/blob/v1.1.12/reflect_extension.go#L348-L373)
- jsoniter v1.1.12 `reflect.go:62-72` — [decoder cache lookup](https://github.com/json-iterator/go/blob/v1.1.12/reflect.go#L62-L72)
- jsoniter v1.1.12 `reflect.go:135-145` — [placeholder memoization](https://github.com/json-iterator/go/blob/v1.1.12/reflect.go#L135-L145)
- jsoniter v1.1.12 `iter.go:331-338` — [decode depth guard](https://github.com/json-iterator/go/blob/v1.1.12/iter.go#L331-L338)
- Go 1.18 `encoding/json/encode.go:1235-1239` — [visited-field guard](https://github.com/golang/go/blob/go1.18/src/encoding/json/encode.go#L1235-L1239)
- sonic v1.14.0 `internal/resolver/stubs_latest.go:49-51` — [delegation to standard-library field resolution](https://github.com/bytedance/sonic/blob/v1.14.0/internal/resolver/stubs_latest.go#L49-L51)
- sonic v1.14.1 `internal/resolver/fields.go:49-75` — [visited-type guard for embedded fields](https://github.com/bytedance/sonic/blob/v1.14.1/internal/resolver/fields.go#L49-L75)
- sonic v1.14.0 `internal/decoder/jitdec/compiler.go:595-609` — [decoder recursion table](https://github.com/bytedance/sonic/blob/v1.14.0/internal/decoder/jitdec/compiler.go#L595-L609)

## Reproducing it safely

The failure needs no production traffic and no large message: the type graph alone is enough. The abridged program below shows the types and the three decode cases; the full harness also wraps each case in a child process and asserts the outcomes.

```go
// Abridged from the runnable harness. The full program runs each case in a
// child process (a stack overflow is fatal; recover cannot intercept it),
// with a timeout and capped output capture.
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
var payload = []byte(`+"`"+`{"id":"1","name":"ev"}`+"`"+`)

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

Observed output of the full harness (Go 1.24.9, darwin/arm64; , darwin/arm64; timings and pointer values vary per run):

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
PARENT_EXIT=0
```

The harness exists because the failure it triggers cannot be handled inside a process:

- **A stack overflow is fatal, and `recover` cannot intercept it.** The failing decode therefore runs in a child process of the same binary, so the parent survives and can report what happened.
- **The child caps its own stack.** `debug.SetMaxStack(1 << 20)` bounds that goroutine's stack at 1 MiB, so the climb that would otherwise reach the runtime's 1 GB default ends in milliseconds with a peak under 10 MiB. The parent adds a 20 s timeout as a backstop and caps the output it keeps at 64 KiB. These bounds limit the harness's own footprint; they are not a process-wide memory limit.
- **The parent measures the child's peak RSS**, so the harness's footprint is reported rather than assumed.

The controls carry the argument: the named recursive field and `encoding/json` decode the same payload in about 4 ms at 4.4 MiB, and only the anonymous embedded pointer crashes. The embedded pointer is legal Go and another decoder reads it happily — the failure is a property of the codec's traversal, not of an invalid type. The harness asserts each outcome and exits non-zero on a mismatch, so it works as a test, not only a demonstration.

## Evidence boundary

The production event model is reconstructed as containing the self-nesting shape; `NodeEmbed` is a reduced reproduction, not a claim that every production field was identical. The embedded-pointer cycle driving jsoniter into unbounded decoder compilation is verified against source and controlled reproduction. The production 8 GB observation and the local bounded-stack measurements are separate pieces of evidence.

The sonic comparison is a retrospective check against `v1.14.0`, `v1.14.1`, and `v1.15.4` (Go `1.24.9`, macOS): the same `NodeEmbed` payload decoded successfully through both the JIT and optimized decoder paths, confirming sonic's native implementation. These checks support the source explanation for the reduced case; they do not recover the production sonic version or runtime.

## Lessons from the investigation

The decisive step was telling the two incidents apart before anything else. A growth curve that tracks business peaks is an accumulation problem; a flat-to-ceiling spike with no traffic correlation is a single allocation path gone wrong. The first shape was already fixed by the codec migration; conflating the two would have pointed the investigation at the wrong variable. What actually narrowed the search was build bisection: it identified a small enough change to trace through the consumer and reduce to a deterministic local failure.

- Use build comparisons when runtime evidence cannot narrow the search: a stable build is a baseline, a suspect build is a bounded change set, and an observation window without a crash is weaker than a reproduction tied to a code path.
- Trace the library's actual input. The envelope and cache decoders sat next to the failing path, but the concrete event type reached a separate jsoniter decoder; following that handoff revealed the type graph the library was compiling.
- Validate a replacement against the failure case. The retrospective sonic checks show the same type and payload decoding successfully — representative event models belong in codec evaluation alongside throughput.

This incident made reflected type graphs part of what I review in a dependency change. A legal Go type can exercise an unguarded traversal inside a library. Testing only payload size, traffic volume, or steady-state throughput would miss a failure during first-use decoder compilation.

The investigation connected a production symptom to a build change, a concrete decode path, and a reproducible library failure — and drew the line between the two incidents cleanly enough that the first fix survived the second crisis: jsoniter kept the paths it had stabilized, and only the typed path moved. That chain left a small test that readers can run without recreating the production memory spike.

---

*Previous in this series: [Building a Production Go Scheduler for 200K+ Delayed Jobs per Second](/posts/engineering-case-study/building-a-production-go-scheduler-for-200k-delayed-jobs-per-second/).* The scheduling center described there is the same platform this incident lived on.

*Next in this series: [Scaling Four Engineers to Eighteen Go Services with Generated Contracts](/posts/engineering-case-study/scaling-four-engineers-to-eighteen-go-services-with-generated-contracts/).*