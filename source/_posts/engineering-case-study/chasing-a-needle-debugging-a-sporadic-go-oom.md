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

This was the second memory incident on that path in a short window, and the two looked nothing alike. The first was a slow climb: memory rose with business peaks and eventually reached the limit. That one I had already fixed: on March 7 I moved three internal decode paths — envelope, cache, and an executor SDK — from `encoding/json` to [jsoniter](https://github.com/json-iterator/go), and memory fell back and stayed down. Days later, a different change reached the subscription layer: it introduced a typed event model and moved the stage-two typed decode onto the jsoniter I had just put in place. The alerts that followed were the spike this article is about: flat to ceiling in under a second, tied to no traffic pattern. A growth curve points at accumulation; a spike points at a single allocation path gone wrong. The first incident, a curve that built over hours, was exactly what dashboards are for; the second, over in under a second, was invisible to all of them.

## What the failing instrumentation could not see

Four standard instruments were considered:

- **Logs** left no useful clue. The triggering events were ordinary, and the process died before the consumer could record its state.
- **Scheduled pprof** sampled too infrequently to catch an unpredictable sub-second spike.
- **Threshold-triggered pprof** both produced false positives from normal allocation and could miss a jump between polling intervals.
- **Core dumps** could not help with the dominant failure mode: the memory-limit kill sent `SIGKILL` before a core could be written.

All four assumed the process would survive long enough to leave evidence. This failure did not. After a week, the failure had no time signature: it was indexed by something other than time, and what it most plausibly indexed was the set of recent changes on the decode path, which only the build could step through one at a time.

## The codec suspicion

The most recent decode-path change was my own March 7 migration, so jsoniter was the first suspect. On March 11 I swapped it for sonic on the cache path. The OOM recurred within a day; I rolled sonic back the next morning.

That cleared the cache path only. The swap had touched none of the other paths jsoniter ran on — and the root cause sat on one of them, the typed decode the second change had wired onto jsoniter. A codec swap cannot step through paths one at a time; a build bisection can. I stopped swapping libraries and started one, treating the recent decode-path changes as a single bundled delta.

## The bisection

On March 12 I rolled the service back to the last known stable build and bisected the incident delta, using one staged deploy and observation window per step, for eight days across eight rollbacks. The builds in the search stepped the internal event SDK between versions that carried the typed-event change and versions that did not (SDK versions, not jsoniter versions — jsoniter itself never moved during the bisection). The SDK version was the deployable handle for the bundled change: subscription-layer code and its dependency pins shipped together in those builds, so stepping it moved the nested-structure change in and out of the process.

The bisection isolated the build delta that introduced the typed event model — the change carrying the nested structure — onto the jsoniter decode path my migration had put in place. I then traced that delta through the consumer: the event SDK decoded the envelope into `Data interface{}`, the subscription layer marshaled that value back to bytes and unmarshaled them again, and the unmarshal half was where jsoniter, unguarded, compiled a decoder for the concrete event model. Reading that delta's code, I matched the mechanism to the production symptoms: an anonymous embedded-pointer cycle. The reduced `NodeEmbed` case reproduced that failure mechanism locally.

**The newest published jsoniter release still reproduced the failure.** That release was `v1.1.12`, which the service had pinned and which was also the newest published. The root cause was the collision the two changes had created: a type graph with an anonymous embedded-pointer cycle had arrived on a decode path that jsoniter — unguarded on that branch — now compiled. The `interface{}` round trip was part of the path that exposed it in this service. Neither change was wrong alone; the March 7 migration had held memory down for days, and the nested type was legal Go.

I therefore evaluated alternative codecs and moved the affected typed-event decode path to sonic, and only that path. The jsoniter migration kept the win it had already delivered: the envelope and cache decodes stayed on it, and the slow-climb incident did not come back. Fixing the type instead (adding a field name or tag to break the anonymous embedding) would also have closed this failure, as the named-field control below demonstrates; the migration was chosen because it left the shared event contract untouched while covering every event model at once.

The production OOM stopped with the migration and never recurred through the months that followed, while the service kept running until I left the company. The type graph itself remained unchanged; sonic handled the embedded cycle without unbounded field expansion. The source comparison below explains that difference.

## The mechanism, reconstructed

The production event model is reconstructed as containing the self-nesting structure; `NodeEmbed` is a reduced reproduction, not a claim that every production field was identical. The 8 GB ceiling and sub-second jump are production observations. The local reproduction verifies the mechanism and failure location, while its bounded stack settings are separate from the production RSS measurement.

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

The failure needs no production traffic and no large message: the type graph alone is enough. The program below reproduces it together with the two controls that separate the trigger from the noise:

```bash
mkdir oom-demo && cd oom-demo && go mod init oom-demo && go get github.com/json-iterator/go@v1.1.12
# save the program as main.go, then (Linux or macOS: the harness reads syscall.Rusage):
go run .
```

```go
// Command oom-demo reproduces the jsoniter decoder-compilation failure from the
// incident: an anonymous embedded pointer creates a cycle in the type graph, and
// jsoniter's field walk expands that cycle without tracking visited types, so
// compiling a decoder for the type recurses until the goroutine stack is gone.
//
//	go run .        # runs the three cases and prints a per-case verdict
//
// Safety. A stack overflow is a fatal runtime error: recover cannot intercept it,
// and left unbounded the recursion grows that goroutine's stack to the runtime's
// default ceiling of 1 GB before the process dies. The failing decode therefore
// runs in a child process of this same binary, under three bounds:
//
//  1. debug.SetMaxStack caps the goroutine stack at maxStackSize, so the crash is
//     small and fast instead of reaching the runtime default;
//  2. a context timeout kills the child if it does not die on its own;
//  3. captured stdout and stderr are capped, so the dump cannot grow the harness.
//
// These bounds keep a reduced reproduction small. They are not a process-wide
// memory limit, and peakRSS uses syscall.Rusage, so the harness runs on Linux and
// macOS.
//
// The payload is deliberately tiny: the failure is a property of the type graph,
// not of the input, so no large message is needed to trigger it.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	jsoniter "github.com/json-iterator/go"
)

// NodeEmbed is the reduced production type graph: an anonymous embedded pointer
// to its own type. jsoniter's describeStruct follows an anonymous embedded struct
// pointer without recording that the type was already visited, so compiling a
// decoder for NodeEmbed never terminates.
type NodeEmbed struct {
	*NodeEmbed        // anonymous embedded pointer -> cycle in the type graph
	ID         string `json:"id"`
	Name       string `json:"name"`
}

// NodeNamed is the control for the same cycle expressed as a named field.
// jsoniter memoizes a placeholder for named recursive fields, so compilation
// terminates and the type is usable.
type NodeNamed struct {
	Self *NodeNamed `json:"self,omitempty"` // named pointer -> placeholder decoder
	ID   string     `json:"id"`
	Name string     `json:"name"`
}

const (
	childEnvVar  = "OOM_DEMO_CHILD"
	maxStackSize = 1 << 20  // 1 MiB, instead of the runtime default of 1 GB
	captureLimit = 64 << 10 // 64 KiB of child output; the crash dump is ~26 KiB
	childTimeout = 20 * time.Second
	errExitCode  = 3
	decodedLine  = `decoded id="1" name="ev"`
)

// payload is 22 bytes; the crash does not depend on its content, only on the type.
var payload = []byte(`{"id":"1","name":"ev"}`)

// testCase is one comparison, with the outcome the harness asserts on.
type testCase struct {
	mode      string
	name      string
	wantCrash bool // true: the child must die of a stack overflow
	wantOut   string
}

func main() {
	// Child mode: run one case in an isolated process so the fatal error cannot
	// take the parent down with it.
	if mode := os.Getenv(childEnvVar); mode != "" {
		runChild(mode)
		return
	}

	fmt.Printf("go=%s jsoniter=%s\n", runtime.Version(), dependencyVersion("github.com/json-iterator/go"))
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		fmt.Println("verdict: UNSUPPORTED platform for the peak-RSS measurement")
		os.Exit(1)
	}
	fmt.Println()

	cases := []testCase{
		{"embed", "jsoniter + anonymous embedded pointer (root cause)", true, ""},
		{"named", "jsoniter + named recursive pointer (control)", false, decodedLine},
		{"std", "encoding/json + anonymous embedded pointer (control)", false, decodedLine},
	}
	unexpected := 0
	for _, c := range cases {
		if !runCase(c) {
			unexpected++
		}
	}
	fmt.Printf("%d/%d cases behaved as expected\n", len(cases)-unexpected, len(cases))
	if unexpected > 0 {
		os.Exit(1)
	}
}

// runCase runs one case in a child process, prints what happened, and reports
// whether the observation matched the expectation. The harness exits non-zero on
// any mismatch, so it can be used as a test rather than only as a demonstration.
func runCase(c testCase) bool {
	ctx, cancel := context.WithTimeout(context.Background(), childTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, os.Args[0])
	cmd.Env = append(os.Environ(), childEnvVar+"="+c.mode)
	stdout, stderr := &cappedBuffer{max: captureLimit}, &cappedBuffer{max: captureLimit}
	cmd.Stdout, cmd.Stderr = stdout, stderr

	fmt.Printf("case: %s\n", c.name)
	start := time.Now()
	err := cmd.Run()
	elapsed := time.Since(start)

	timedOut := ctx.Err() != nil
	crashed := strings.Contains(stderr.String(), "fatal error: stack overflow")
	switch {
	case timedOut:
		fmt.Printf("  result: killed by the %s timeout after %s\n", childTimeout, elapsed.Round(time.Millisecond))
	case err == nil:
		fmt.Printf("  result: completed normally in %s\n", elapsed.Round(time.Millisecond))
	default:
		fmt.Printf("  result: child exited with code %d after %s\n", exitCode(err), elapsed.Round(time.Millisecond))
	}
	if peak := peakRSS(cmd); peak > 0 {
		fmt.Printf("  child peak RSS: %.1f MiB\n", float64(peak)/(1<<20))
	}
	// The first stderr lines name the failure; the repeated describeStruct frames
	// show where the recursion happens.
	for _, line := range headLines(stderr.String(), 3) {
		fmt.Printf("  stderr: %s\n", line)
	}
	if n := strings.Count(stderr.String(), "go.describeStruct"); n > 0 {
		fmt.Printf("  recursing frame: describeStruct — reflect_extension.go:362 (%d frames captured)\n", n)
	}
	for _, line := range headLines(stdout.String(), 2) {
		fmt.Printf("  stdout: %s\n", line)
	}

	// A truncated capture can hide both the failure text and the decoded values,
	// so treat it as an inconclusive case instead of a pass.
	if stdout.truncated || stderr.truncated {
		fmt.Printf("  verdict: INCONCLUSIVE — capture truncated at %d KiB\n\n", captureLimit>>10)
		return false
	}
	switch {
	case timedOut:
		fmt.Printf("  verdict: UNEXPECTED — the child was killed by the timeout\n\n")
		return false
	case c.wantCrash && !crashed:
		fmt.Printf("  verdict: UNEXPECTED — no stack overflow in the child's stderr\n\n")
		return false
	case c.wantCrash && crashed:
		fmt.Printf("  verdict: as expected — the decoder compiles recursively until the stack is gone\n\n")
		return true
	case !c.wantCrash && err != nil:
		fmt.Printf("  verdict: UNEXPECTED — control failed instead of decoding\n\n")
		return false
	case !c.wantCrash && !strings.Contains(stdout.String(), c.wantOut):
		fmt.Printf("  verdict: UNEXPECTED — child stdout lacks %q\n\n", c.wantOut)
		return false
	default:
		fmt.Printf("  verdict: as expected — the control decoded the payload without recursing\n\n")
		return true
	}
}

// runChild performs a single case. The "embed" case never returns.
func runChild(mode string) {
	switch mode {
	case "embed":
		debug.SetMaxStack(maxStackSize) // safety 1: bound stack growth
		var v NodeEmbed
		// Fatal here: jsoniter compiles a decoder for NodeEmbed before reading
		// any input, and that compilation recurses without a visit guard.
		_ = jsoniter.Unmarshal(payload, &v)
		fmt.Println("unreachable: jsoniter did not fail on the embedded cycle")
		os.Exit(1)

	case "named":
		debug.SetMaxStack(maxStackSize)
		var v NodeNamed
		if err := jsoniter.Unmarshal(payload, &v); err != nil {
			fmt.Printf("jsoniter named field failed: %v\n", err)
			os.Exit(errExitCode)
		}
		reportDecoded(v.ID, v.Name)

	case "std":
		// encoding/json walks embedded fields with a visited set, so the cycle
		// terminates there and the nil embedded pointer is harmless here.
		var v NodeEmbed
		if err := json.Unmarshal(payload, &v); err != nil {
			fmt.Printf("encoding/json returned an error (not fatal): %v\n", err)
			os.Exit(errExitCode)
		}
		reportDecoded(v.ID, v.Name)

	default:
		fmt.Printf("unknown child mode %q\n", mode)
		os.Exit(errExitCode)
	}
}

// reportDecoded prints the decoded values, and fails the child if the decoder
// returned without error but produced the wrong fields.
func reportDecoded(id, name string) {
	if id != "1" || name != "ev" {
		fmt.Printf("decoded unexpected values: id=%q name=%q\n", id, name)
		os.Exit(errExitCode)
	}
	fmt.Printf("decoded id=%q name=%q\n", id, name)
}

// cappedBuffer keeps the first max bytes written and records that it truncated,
// so a child that emits a large dump cannot grow this process's memory.
type cappedBuffer struct {
	buf       bytes.Buffer
	max       int
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if room := c.max - c.buf.Len(); room > 0 {
		if len(p) > room {
			c.buf.Write(p[:room])
			c.truncated = true
		} else {
			c.buf.Write(p)
		}
	} else {
		c.truncated = true
	}
	return len(p), nil
}

func (c *cappedBuffer) String() string { return c.buf.String() }

// peakRSS reports the child's peak resident set size in bytes.
// Linux reports ru_maxrss in kilobytes; Darwin reports it in bytes.
func peakRSS(cmd *exec.Cmd) int64 {
	if cmd.ProcessState == nil {
		return 0
	}
	ru, ok := cmd.ProcessState.SysUsage().(*syscall.Rusage)
	if !ok || ru == nil {
		return 0
	}
	if runtime.GOOS == "linux" {
		return ru.Maxrss * 1024
	}
	return ru.Maxrss
}

func exitCode(err error) int {
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode()
	}
	return -1
}

// headLines keeps only the first n non-empty lines of captured output.
func headLines(s string, n int) []string {
	var out []string
	for _, line := range strings.Split(s, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		out = append(out, line)
		if len(out) == n {
			break
		}
	}
	return out
}

func dependencyVersion(path string) string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	for _, dep := range info.Deps {
		if dep.Path == path {
			return dep.Version
		}
	}
	return "unknown"
}
```

Observed output (Go 1.24.9, darwin/arm64; timings and pointer values vary per run):

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

The controls carry the argument. The named recursive field and `encoding/json` decode the same payload in about 4 ms at 4.4 MiB; only the anonymous embedded pointer crashes. That is what makes this a property of the codec's traversal rather than of an invalid type: the embedded pointer is legal Go, and another decoder reads it happily. The harness also asserts the outcome of each case and exits non-zero on a mismatch, so the reproduction works as a test rather than only as a demonstration.

## Evidence boundary

The production event model is reconstructed as containing the self-nesting shape; `NodeEmbed` is a reduced reproduction, not a claim that every production field was identical. The embedded-pointer cycle driving jsoniter into unbounded decoder compilation is verified against source and controlled reproduction. The production 8 GB observation and the local bounded-stack measurements are separate pieces of evidence.

The sonic comparison is a retrospective check against `v1.14.0`, `v1.14.1`, and `v1.15.4`. With Go `1.24.9` on macOS, amd64 builds decoded the same `NodeEmbed` payload successfully through both the JIT and optimized decoder paths; the API check confirmed sonic's native implementation rather than its `encoding/json` compatibility API. These checks support the source explanation for the reduced case. They do not recover the exact production sonic version or recreate the production runtime.

## Lessons from the investigation

The decisive step was telling the two incidents apart before anything else. A growth curve that tracks business peaks is an accumulation problem; a flat-to-ceiling spike with no traffic correlation is a single allocation path gone wrong. The first shape had already been fixed with a codec migration; treating the second as more of the first would have sent the investigation chasing the wrong variable. What actually narrowed the search was build bisection: it identified a small enough change to trace through the consumer and reduce to a deterministic local failure.

- Use build comparisons when runtime evidence cannot narrow the search. A stable build provides a baseline. A suspect build provides a bounded set of changes to investigate. For a sporadic failure, an observation window without a crash is still weaker evidence than a reproduction tied to a specific code path.
- Trace the library's actual input. The envelope and cache decoders were adjacent to the failing path, but the concrete event type reached a separate jsoniter decoder. Following that handoff revealed the type graph the library was compiling. The small payload and recursive `describeStruct` frames then explained how an ordinary event could trigger rapid memory growth.
- Validate a replacement against the failure case. The reduced case remains useful after diagnosis: it tests the behavior that motivated the migration. The retrospective sonic checks show that the same type and payload can decode successfully. Representative event models and decoded values should be part of codec evaluation alongside throughput.

This incident made reflected type graphs part of what I review in a dependency change. A legal Go type can exercise an unguarded traversal inside a library. Testing only payload size, traffic volume, or steady-state throughput would miss a failure during first-use decoder compilation.

The investigation connected a production symptom to a build change, a concrete decode path, and a reproducible library failure — and drew the line between the two incidents cleanly enough that the first fix survived the second crisis: jsoniter kept the paths it had stabilized, and only the typed path moved. That chain left a small test that readers can run without recreating the production memory spike.

---

*Previous in this series: [Building a Production Go Scheduler for 200K+ Delayed Jobs per Second](/posts/engineering-case-study/building-a-production-go-scheduler-for-200k-delayed-jobs-per-second/).* The scheduling center described there is the same platform this incident lived on.

*Next in this series: [Scaling Four Engineers to Eighteen Go Services with Generated Contracts](/posts/engineering-case-study/scaling-four-engineers-to-eighteen-go-services-with-generated-contracts/).*