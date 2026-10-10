---
title: About
date: 2026-10-01 10:55:00
description: About Edward Shen, a Go backend and distributed systems engineer who designs scheduling platforms, service foundations, real-time data systems, and lifecycle marketing pipelines.
---

I've spent ten years building backend systems, almost all of it in Go. I started with card and casual game backends, spent four and a half years on an SCRM product, and since early 2025 I've been leading backend architecture for an overseas game platform.

A few systems I designed and owned, in the order I built them:

- The [SCRM scheduler](/posts/engineering-case-study/designing-a-lightweight-scheduler-for-200k-delayed-execution-commands-per-second/): a distributed scheduling center that replaced several legacy components and handles more than 200K scheduling operations per second, carrying close to 100 million tasks.
- The game platform's [service foundation](/posts/engineering-case-study/scaling-a-four-engineer-backend-to-eighteen-go-services-with-generated-contracts/): a contract-driven Go platform that helped four backend engineers deliver eighteen production services, with about 60% less work to onboard each new one.
- The game platform's [data path](/posts/engineering-case-study/building-a-real-time-data-platform-with-tidb-cdc-and-flink/): TiDB CDC and Flink syncing OLTP data into a layered analytical warehouse with second-level freshness.
- The game platform's [marketing pipeline](/posts/engineering-case-study/building-a-predicate-driven-audience-pipeline-for-lifecycle-email/): predicate-driven audience segmentation and multi-channel reach that turned manually operated campaigns into automated execution.

After ten years, I still come back to the same part of backend work: finding the failure mode that only appears under real load.

<p class="motto">STAY HUNGRY, STAY FOOLISH.</p>
<p class="motto-cite">— Steve Jobs</p>
