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

*Previous in this series: [Building a Production Go Scheduler for 200K+ Delayed Jobs per Second](/posts/engineering-case-study/building-a-production-go-scheduler-for-200k-delayed-jobs-per-second/)*.

*Next in this series: [Scaling Four Engineers to Eighteen Go Services with Generated Contracts](/posts/engineering-case-study/scaling-four-engineers-to-eighteen-go-services-with-generated-contracts/)*.
