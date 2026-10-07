---
title: About
date: 2026-10-01 10:55:00
---

I've spent ten years building backend systems, almost all of it in Go. I started with card and casual game backends, spent four and a half years on an SCRM product, and since early 2025 I've been leading backend architecture for an overseas game platform.

A few systems I designed and owned, in the order I built them:

- The SCRM scheduler: a distributed scheduling center that replaced several legacy components and handles more than 200K scheduling operations per second, carrying close to 100 million tasks.
- The game platform's service foundation: a contract-driven Go platform that helped four backend engineers deliver eighteen production services, with about 60% less work to onboard each new one.
- The game platform's data path: TiDB CDC and Flink syncing OLTP data into a layered analytical warehouse with second-level freshness.

Most engineering posts describe the final architecture. The part I find useful is everything around it: the real constraint, the option we rejected, and the trade-off that only showed up after deployment. That's what I try to write down in each case study here.
