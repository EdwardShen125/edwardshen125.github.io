---
title: About
date: 2026-10-01 10:55:00
description: About Edward Shen, a Go backend and distributed systems engineer who designs scheduling platforms, service foundations, real-time data systems, and lifecycle marketing pipelines.
---

I've spent ten years building backend systems, almost all of it in Go. I started with card and casual game backends, spent four and a half years on an SCRM product, and since early 2025 I've been leading backend architecture for an overseas game platform.

The through-line is systems that have to hold under real load. At the SCRM company I designed the [scheduling center](/posts/engineering-case-study/designing-a-lightweight-scheduler-for-200k-delayed-execution-commands-per-second/) — a distributed scheduler replacing legacy components at more than 200K operations per second — and later tracked down the platform's [hardest production failure](/posts/engineering-case-study/chasing-a-needle-debugging-a-sporadic-go-oom/): a sporadic consumer OOM that left no log, no profile, and no time signature, closed by a rollback bisection and traced to a JSON decoder's type-graph recursion. On the game platform, the same instinct turned into building: a contract-driven Go platform that let four engineers deliver eighteen services, a TiDB CDC and Flink data path with second-level freshness, and a predicate-driven marketing pipeline.

What I keep coming back to is the point where design and debugging meet: the failure mode that only appears under real load, and the system shape that prevents it.

<p class="motto">STAY HUNGRY, STAY FOOLISH.</p>
<p class="motto-cite">— Steve Jobs</p>
