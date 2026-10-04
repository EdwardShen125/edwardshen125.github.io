---
title: Building a Real-Time Data Platform with TiDB CDC and Flink
date: 2026-12-01 10:00:00
categories:
  - Engineering Case Study
tags:
  - tidb
  - flink
  - cdc
  - data-platform
  - real-time
published: false
---

<!-- ============================================================
  【方向评估块】发布前删除本注释
  评估方法：确认下方"缺失事实"能否补齐 → 补齐后按 AGENTS.md 十四流程出图
  → 按本骨架逐章写作 → hexo generate 验证 → published: true
============================================================ -->
<!--
  【系列衔接】本文与 P1（building-a-production-grade-go-microservice-architecture-from-zero，已发布）同平台同团队：
  - Context 可直接继承 P1：14 人团队 / 4 Go 后端 / go-zero 平台 / 对标市场头部
  - config-hub 与 query-hub 即本平台的平台服务（config-hub 2025-04 首建于 P1 期，cron-hub 2025-06 首建于本期）
  - 开篇可写 "on the platform from the previous post..."，Context 成本减半
  - 交付节奏 git 实证：11.4k commits / 40 repos / 31 周可引用
-->
<!--
  定位：P2，Data Engineering + OLTP→OLAP + 一致性处理
  证明能力：CDC 链路全量建设、多流 Join、三层数仓、平台化（ConfigHub/QueryHub）
  专属风格候选：Event Transit（写作时实测后再定，见 AGENTS.md 十四）
-->

## Context

<!-- 已确认事实（简历）：海外游戏平台，2025.06-2025.11，主导立项；
     背景：配置分散、无规范化数仓、看板查询性能差且联动一致性无保障 -->

## Problem

<!-- TODO：分析查询如何拖慢业务库的具体案例；看板联动的数据不一致实例 -->

## Constraints

<!-- TODO：不能停机同步、业务库写压力、团队数据工程经验现状 -->

## Requirements

<!-- 已确认：秒级 OLTP→OLAP 同步；分析与业务库解耦；多看板联动一致性 -->

## Options Considered

<!-- TODO：TiDB CDC vs Canal vs Debezium vs 双写的对比依据（关键决策点） -->

## Architecture / Design

<!-- 图：Event Transit 风格候选，先实测；内容：TiDB → TiCDC → Flink(多流 Join+维表) → ODS/DWD/DWS → 看板/缓存 -->

## Key Technical Decisions

<!-- TODO：多流 Join 的一致性处理（watermark/状态后端）；维表更新时序；
     ODS/DWD/DWS 分层边界；ConfigHub 与 QueryHub 的设计 -->

## Implementation

<!-- TODO：Airflow H+1/T+1 调度；CI 建设；QueryHub SQL 模板机制 -->

## Failure Modes / Production Challenges

<!-- TODO：CDC 延迟尖峰/schema 变更/Join 数据乱序的真实处理案例 -->

## Results

<!-- 已确认：秒级同步落地；100+ SQL 模板；高频查询缓存显著降低 DB 负载
     TODO：端到端延迟数字；查询性能前后对比 -->

## Trade-offs

## What I Learned

## What I Would Change Today
