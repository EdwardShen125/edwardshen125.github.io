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
description: "A monitoring alert showed a consumer pod pinning 8 GB of memory in under a second, with no pattern to when. Logs, scheduled pprof, and threshold-triggered pprof all missed it. This is the investigation: failed library swaps, a rollback bisection, and a root cause in a JSON library's type compiler."
seo_image: chasing-a-needle-oom.png
---

The alert came from Grafana. A Go service consuming SOP-dispatch events on Pulsar had hit its 8 GB limit and restarted — the memory trace was a single vertical line, memory flat and low one moment, pinned to the ceiling the next. There was no gradual slope, no warning ramp, no correlation with traffic or time of day. Over the following week it fired at least once a day, up to three or four times on the worst days, and nothing in the logs explained any occurrence.

The service consumes SOP-dispatch events off Pulsar. In this marketing-automation platform, a SOP (standard operating procedure) plan routes each customer through a branching graph of nodes — messages, employee tasks, tag changes — entered either by a matching CRM event (order created, friend bound, twenty-odd more) or by a batch audience import; every step a customer takes through the graph becomes one dispatch event on the bus, consumed and acted on by this service. The path decodes in two stages: the event SDK decodes the envelope into a struct with a generic `Data interface{}` field, and the subscription layer re-marshals that field and decodes it into the concrete event model. Traffic was normal and payloads were ordinary business events; nothing about the input suggested it could exhaust 8 GB in under a second.

<!-- more -->

{% asset_img chasing-a-needle-oom.png SOP event consumption path: two decode stages, jsoniter decoder compiler, embedded-cycle recursion and the 8 GB alert %}

That week was spent narrowing the search from the outside in. The one thing visible about the death was where it happened: the goroutine was blocked inside unmarshal when the process went down, and it never returned. That blockage was the one usable lead, and it pointed the search at JSON decoding.

## What the failing instrumentation could not see

Four standard debugging moves were tried over that week. They share one assumption this failure did not honor: that an incident leaves a trace proportional to its duration.

**Logs.** The blocked goroutine never returned, never logged. Nothing before the spike pointed at it either — the events that triggered death were ordinary ones — the same kinds processed without consequence every day.

**Scheduled external pprof.** A cron-driven heap profile captures a snapshot at a moment of its choosing. This failure occupied a sub-second window at an unpredictable time, on an unpredictable pod, between deploys. The odds of a scheduled snapshot landing inside that window were effectively zero.

**In-process threshold-triggered pprof.** The next refinement: watch memory in-process and dump a profile when it crosses a threshold. Two problems surfaced. False positives — ordinary allocations crossed the low thresholds constantly. And a subtler one: the threshold check itself ran on a timer, polling memory at intervals. A needle that goes from baseline to 8 GB between two polls is invisible to a poller; by the time the alarm condition was detectable, the process was already gone.

**Core dumps.** This path was considered and set aside. A memory-limit kill is SIGKILL — no configuration turns it into a core, so the dominant death mode here produced nothing to analyze. And the failure was too fast for the cases core dumps do serve, where a process lingers long enough to capture on the way down. This one was gone before anything could attach.

The instrument that would not have needed luck was not part of the platform: a continuously-running profiler that records every window instead of chosen moments, so the frames of a sub-second recursion would already be stored when the alert fired.

After a week of this, the conclusion was more specific than "we need better tools": the failure had no time signature. Whatever it was, it indexed by something other than time — and the one system variable not yet varied was the build.

## The library swaps that failed

With the search pointed at JSON decoding, the first action varied the codec. On March 7 I swapped the stage-one envelope decoder in the event SDK from `encoding/json` to jsoniter, configuring `ConfigCompatibleWithStandardLibrary` across the consumer entry points, and made the same swap in a Redis cache SDK the same day. The alerts did not stop.

Four days later the escalation was sonic — a JIT-compiled codec with its own stack discipline and depth limit — tried in the cache path. The OOM recurred within a day. I rolled it back the next morning.

The failure survived both swaps, and in doing so exonerated the envelope and cache paths; through every variation the decode target had never changed. What remained to examine was the **typed event model** itself on the consumption side.

## The bisection

On March 12 the approach changed from patching to reverting. The service was rolled back to the last known stable build; the difference between that build and the incident builds became the search space. Then a binary search over that delta, one staged deploy and observation window per step.

The version trail in git records the search: eight rollback commits over eight days, pinning the event SDK back and forth between versions — the stdlib build (v1.1.18) and three jsoniter builds (v1.1.22, v1.1.23, v1.1.25) — before the terminal rollback to the stdlib build.

The search converged in a single afternoon of five commits, in sequence: logging added around the suspect consumer, a distributed lock removed and the message-aggregation key changed from node ID to message ID to redistribute partitions, a panic guard added to a consumer handler, a code rollback, and finally the consumer registration rolled back. The build that finally carried no recurrence was the one with the offending code gone from the process entirely.

## The mechanism, reconstructed

With the incident closed, I reconstructed the mechanism down to the source level. The bisection had isolated a single commit's difference — and the class of that difference, cross-referenced with the symptoms, pointed at the JSON type compiler in jsoniter. The analysis below was verified against library source and controlled reproduction; nothing here was captured from the production incident itself.

jsoniter compiles a decoder per type on first use. Named self-referential fields are safe: the decoder factory (`createDecoderOfType`) publishes a `placeholderDecoder` into the type table before expanding a type, so recursion back to a type already being expanded terminates. Bounded compile, safe decode.

Embedded fields take a different branch, one that bypasses the placeholder table. An untagged embedded pointer — `type Node struct { *Node; ID string }`, no field name, no JSON tag — recurses into the embedded type directly, with no visited-set on that path. This is the jsoniter code in question, from `reflect_extension.go` in v1.1.12 (the version the service had pinned; the same branch crashes in every release I tested back to v1.1.5 — the frame sits at line 339 in v1.1.5-v1.1.10 and line 362 in v1.1.12 — and it is still unfixed upstream):

```go
// reflect_extension.go:348-373 (jsoniter v1.1.12), abridged
if field.Anonymous() && (tag == "" || tagParts[0] == "") {
    ...
    } else if field.Type().Kind() == reflect.Ptr {
        ptrType := field.Type().(*reflect2.UnsafePtrType)
        if ptrType.Elem().Kind() == reflect.Struct {
            structDescriptor := describeStruct(ctx, ptrType.Elem()) // ← recurses, no cycle check
            ...
        }
    }
}
```

If the type graph cycles through an embedded pointer, the compiler recurses without bound. Each level allocates field bindings, reflect2 type descriptors, and per-level slice splices; the stack climbs toward Go's 1 GB goroutine limit while the heap climbs with it. The process dies — `fatal error: stack overflow` on the repro, OOM-killed in production — on a payload that can be as small as 22 bytes:

```go
type NodeEmbed struct {
    *NodeEmbed
    ID   string `json:"id"`
    Name string `json:"name"`
}
// jsoniter.Unmarshal([]byte(`{"id":"1","name":"ev"}`), &NodeEmbed{})
// → fatal error: stack overflow (goroutine stack exceeds 1000000000-byte limit)
```

Reproduced on the incident-locked toolchain (go1.18, jsoniter v1.1.12), the crash reaches a peak RSS of about 1.04 GB in roughly a third of a second — the goroutine stack limit is the natural brake, and the heap climbs alongside it. That is the needle from the opening paragraph, reproduced: baseline to ceiling on an input of 22 bytes. The crash frame in the stack trace lands on `reflect_extension.go:362` in v1.1.12 — the exact recursive call quoted above. And the per-process decoder cache is measurable: the first decode of a type costs ~280 µs (compile plus decode) while subsequent decodes of the same type run in ~0.3 µs — an 800× gap. Compilation happens once per process; every decode after the first rides the cache.

The standard library, for contrast, resolves fields with a breadth-first walk guarded by a `visited` map — a cyclic type is visited once and both marshal and unmarshal stay safe. Producer services that serialize events with `encoding/json` never saw the problem: same types, different compiler, safe traversal. That asymmetry — "marshal fine, unmarshal fatal" — resolves here: the producers and the consumer never ran the same compiler.

Source references (pinned versions, verified line-exact against the module cache):
- jsoniter v1.1.12 `reflect_extension.go:348-373` — the unguarded embedded-pointer branch: [github.com/json-iterator/go/blob/v1.1.12/reflect_extension.go#L348-L373](https://github.com/json-iterator/go/blob/v1.1.12/reflect_extension.go#L348-L373)
- jsoniter v1.1.12 `reflect.go:135-145` — the placeholder memoization the embedded branch bypasses: [github.com/json-iterator/go/blob/v1.1.12/reflect.go#L135-L145](https://github.com/json-iterator/go/blob/v1.1.12/reflect.go#L135-L145)
- go1.18 `encoding/json/encode.go:1235-1239` — the visited-set guard: [github.com/golang/go/blob/go1.18/src/encoding/json/encode.go#L1235-L1239](https://github.com/golang/go/blob/go1.18/src/encoding/json/encode.go#L1235-L1239)

What this mechanism explains:

- **Data-independence.** A flat, tiny, valid event triggers it. Payload size and nesting depth of the *data* are irrelevant — the cycle is in the *type graph*, walked at decoder-compile time, before any data is read.
- **The needle.** Unbounded recursion allocating at every level is as fast as memory can be allocated — no ramp, no slope.
- **Sporadicness.** Decoder compilation happens once per process, on first use of a type; the first-decode versus steady-state gap above is that cache at work. A warm pod has the cache hot and processes the same event harmlessly; a fresh pod — after a deploy, a scale-up, a restart — dies on first encounter. The failure indexed by process lifetime and deploy schedule, not by wall-clock time. This is why the time-axis instruments of the previous section were structurally blind to it.
- **Why the library swaps failed.** The fatal compilation happened in stage two, on the typed event model — a decoder that had been jsoniter since 2022 and that neither swap touched. Only removing the offending type from the process (the rollback) stopped the failure.
- **Why logs showed nothing.** The compile happens inside `Unmarshal` before any data is read and never returns. Blocked-in-unmarshal with no output is exactly what an infinite compile loop looks like from the outside.

## The evidence boundary

The final missing piece — the exact struct that formed the cycle — is the one thing the reconstruction cannot deliver. The bisection isolated the change that removed it, but the type itself lived outside version control: the service's go.mod carried `replace` directives pointing at local directories, and the offending definition died with that working tree. Later, embedded-aware cycle scans of the service's full git history found no embedded cycle in any registered event model — the type was real at runtime, absent from the repo.

Two things are worth keeping distinct. The mechanism — an embedded-pointer cycle driving jsoniter's type compiler into unbounded recursion — is verified: against library source across jsoniter v1.1.5 through v1.1.12, by controlled reproduction on the incident-locked toolchain, and by the standard library's contrasting design. The identity of the offending type is a reconstruction from the bisection plus the symptom set. The mechanism is reproducible on demand; the structure identity is the best-supported inference from a converging bisection. An incident can be fully closed while its forensics stay incomplete; knowing which parts of your understanding are which is part of the job.

## What I would change today

**Warm the cache deliberately.** The failure mode is first-use-per-process. Today I would treat JSON decoder compilation as a startup step for event consumers: at process start, iterate the registered event types and force decoder compilation (`DecoderOf` / a decode of an empty object). A cyclic type then fails fast at boot, on every pod, deterministically — turning the needle into a deploy-time error. The 22-byte reproduction makes this a one-line smoke test for any codebase using jsoniter with reflected types.

**Treat third-party codecs as untrusted compilers.** jsoniter compiles code from type definitions; a type graph is untrusted input to that compiler. A one-off AST scan for embedded-pointer cycles in event-model packages, wired into CI, closes the gap between "library with a known unguarded branch" and "codebase that cannot express the fatal shape".

**Cap the stack to fail louder, not to survive.** `debug.SetMaxStack` cannot stop this failure — the recursion is inside the library, and the process dies either way. What a low cap (16 MB in my repro, against the 1 GB default) changes is the death: peak RSS drops from ~1 GB to ~64 MB, and the fatal trace arrives carrying ninety-odd `describeStruct` frames instead of exhausting memory first. On a shared node that spares neighbors; for whoever reads the log, it turns an unexplained OOM into a printed stack. The generic advice for recursion you own — depth limits, iteration, explicit stacks — does not apply here: the recursion was not ours to rewrite.

**Know what the newer tools do not fix.** Go 1.25's `runtime/trace.FlightRecorder` buffers the last seconds of execution trace in a ring — but it snapshots only when program logic calls `WriteTo`. It answers the failure class where detection survives the incident: a slow request triggers the dump, and the trace explains it. It does not answer this one, where the process dies before anything can notice. The distinction that matters is triggered versus untriggered recording; for a failure with no time signature, only the untriggered kind — a profiler sampling continuously, storing regardless — has the evidence already saved when the alert fires.

**Rollback first, patch second.** Five days went to attempted fixes before the bisection began. The swaps had diagnostic value — they exonerated the envelope and cache paths — but as *fixes* those were five days of exposure. Today the sequencing rule is: restore stability first (rollback), then investigate the delta. A fix attempted before the mechanism is understood is a guess with deploy risk; the bisection that followed was both safer and, in the end, the actual diagnostic instrument.

**The transferable rule.** When an incident's signature is "no time signature", stop instrumenting the time axis. The failure was indexed by process lifetime and build identity, and the instrument that finally resolved it — a bisection over builds — is the one that queries those axes. Choose the instrument that matches the failure's indexing variable, not the one your tooling defaults to.

## Trade-offs and costs

The rollback-bisection path has a real cost profile. Eight staged deploys over eight days, each an observation window with on-call attention. It requires a known-stable baseline build to roll back to. And it converges on a diff, not a mechanism: the bisection isolated the change, and understanding why still required the post-hoc source analysis. Both instruments are needed; neither substitutes for the other.

The terminal stable build also carried costs of its own. The consumer-group rollback and lock removal changed message partitioning and removed serialization that had existed for a reason; the logging cleanup removed whole-response logging that, while it fed the same memory pressure, was also the only record of what events contained. Some observability was spent to buy stability. The compression change that followed (LZ4 to ZLib on the Pulsar producer, a teammate's change — memory relief, not cause) traded CPU for consumer-side memory headroom: reasonable adjacent hardening, never the root cause.

## Closing

The fixes that failed were diagnostic, the fix that worked was removal, and the full understanding arrived months later: a type graph cycle, compiled without bound, killing fresh pods on first sight of an ordinary event. For a failure like this, the discipline that pays is not profiling skill but the willingness to distrust instrumentation when the failure declines to be observed, and to vary the variable the failure actually depends on. The needle had no time signature — the build was the only clock it answered to.
