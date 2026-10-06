---
title: From Manual Operations to an Automated Lifecycle Marketing Platform
date: 2027-01-01 10:00:00
categories:
  - Engineering Case Study
tags:
  - go
  - marketing-platform
  - event-driven
  - lifecycle-marketing
published: false
---

<!-- ============================================================
  【方向评估块】发布前删除本注释
  评估方法：确认下方"缺失事实"能否补齐 → 补齐后按 AGENTS.md 十四流程出图
  → 按本骨架逐章写作 → hexo generate 验证 → published: true
============================================================ -->
<!--
  【系列衔接】本文与 P1/P2 同平台同团队（go-zero 平台，17 人团队，其中 4 名 Go 后端）：
  - Context 继承 P1；营销/触达服务跑在同一平台（content-promotion 服务 2025-04 起）
  - ws-hub websocket 推送、language 多语言服务为本文的现成基础设施（可引用 P1 的图）
  - 开篇写 "on the platform from the previous posts..."；引用 P1/P2 的链接
-->
<!--
  定位：P3，Cross-team Collaboration + Full-lifecycle Ownership + 海外产品经验
  证明能力：业务→技术转化、规则引擎抽象（谓词模型）、可靠性工程（频控/降级/追踪）
  对标受众：做海外市场的 SG 团队（Grab/Sea/Shopee 类）相关性最高
-->

## Context

<!-- 已确认事实（简历）：海外游戏平台，2025.10-2026.02，与产品共同设计生命周期日历运营；
     人群圈选引擎（统一特征清洗管道、原子+复合谓词）；
     Reach 多通道触达（邮件/站内信、通道策略、智能降级、回执追踪、频控、持久化）；
     Adjust 归因与广告事件上报；圈选→触达→奖励全链路自动化 -->

## Problem

<!-- TODO：人工运营的具体流程与错误案例；规模化的量化瓶颈 -->

## Constraints

<!-- TODO：多渠道供应商限制、合规/骚扰风险、运营团队工具习惯 -->

## Requirements

## Options Considered

<!-- TODO：自建 vs 采购 SaaS；谓词模型 vs 规则引擎 DSL 的选择 -->

## Architecture / Design

<!-- 图：C4 容器图（圈选引擎 / Reach / 频控 / 渠道 / 归因） -->

## Key Technical Decisions

<!-- TODO：原子谓词+复合谓词的抽象设计；频控的维度与存储；
     智能降级的触发条件；消息幂等去重 -->

## Implementation

## Failure Modes / Production Challenges

<!-- TODO：降级触发实例；误发/重复发送的防护案例 -->

## Results

<!-- 已确认：全链路自动化落地
     TODO：触达量、回执覆盖率、人力节省数据 -->

## Trade-offs

## What I Learned

## What I Would Change Today
