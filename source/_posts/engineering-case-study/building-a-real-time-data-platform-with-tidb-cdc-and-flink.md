---
title: Building a Real-Time Data Platform with TiDB CDC and Flink
date: 2026-02-07 12:00:00
categories:
  - Engineering Case Study
tags:
  - tidb
  - flink
  - cdc
  - data-platform
  - real-time
---

The Go backend platform had been established earlier in 2025 and eventually carried nineteen services. Product teams could ship features, but operational questions still required ad-hoc production queries. Dashboards were slow, and linked views could not be trusted to refresh from a consistent snapshot.

The conventional fix was a separate OLAP database, a sync pipeline, and a dedicated data engineering function. The backend team had to absorb this work alongside feature delivery, so that was not practical. This is the retrospective of the platform we built instead: [TiCDC](https://docs.pingcap.com/tidb/stable/ticdc-overview) → [Kafka](https://kafka.apache.org/) → [Apache Flink](https://flink.apache.org/) → analytical tables in TiDB, served by QueryHub, a self-developed SQL-template service.

{% asset_img data-platform-cover.png Real-Time Data Platform architecture cover %}

## Context

The backend foundation came from [Building a Production-Grade Go Microservice Architecture from Zero](/posts/engineering-case-study/building-a-production-grade-go-microservice-architecture-from-zero/). I then led a separate data-platform workstream from June through November 2025; it also included ConfigHub, but this article focuses on the CDC, warehouse, and query-serving path.

Product managers needed transaction, settlement, and promotion metrics. Operations needed to detect abuse while a campaign was still active. Finance needed reconciliation. The production schemas were optimized for writes, not analytical reads.

## Problem

The binding constraint was staffing: the same team had to build the data platform alongside feature delivery. A traditional OLTP/OLAP split required another database, sync pipeline, and transformation layer that we could not operate.

The daily cost appeared in three ways: new metrics required ad-hoc production queries or a new ETL pipeline; metrics varied by dimension, granularity, and refresh requirement; and T+1 reporting was too slow for an active promotion-abuse investigation.

## Constraints

Four Go engineers owned the entire backend, including this data platform. The product had a fast feature cadence, correctness-sensitive transaction flows, and live-ops reports that changed every sprint. We also chose to standardize on TiDB rather than operate a separate OLAP database.

## Requirements

- Hourly aggregation of transaction, settlement, promotion, referral/commission, and wallet-transfer events.
- Multi-stream joins and dimension-table lookups for detail and wide-table analysis.
- Logical ODS → DWD → DWS layering with explicit ownership.
- Analytics tables updated within seconds rather than waiting for T+1 reports.
- Daily and monthly report boundaries in the viewer's timezone.
- Stable pipeline definitions deployed through the existing K8s and CI/CD path.
- Recoverability from TiCDC replay, Flink restarts, and batch corrections without duplicating aggregate rows.

## Options Considered

| Decision | Alternatives considered | Selected | Why |
|---|---|---|---|
| Report access | [Superset](https://superset.apache.org/), self-developed QueryHub + existing admin UI | Self-developed QueryHub + React/ECharts | Kept dashboards product-owned and inside the admin experience |
| Change capture | [Canal](https://github.com/alibaba/canal), direct Flink CDC, [TiCDC](https://docs.pingcap.com/tidb/stable/ticdc-overview) | TiCDC → Kafka | Native TiDB capture; Kafka retained the changefeed while Flink checkpoints stored source offsets and job state |
| Storage/query | Separate OLAP store, TiDB + TiFlash | TiDB + TiFlash | Reused MySQL compatibility, joins, security, and operational knowledge |
| Processing API | Custom streaming pipeline, Flink SQL, DataStream | Flink SQL by default; DataStream for custom state and cleansing | Reused tested checkpoint, keyed-state, recovery, and backpressure primitives; kept common reports reviewable |

Processing was not a simple SQL-versus-DataStream choice. A custom streaming pipeline was considered because it could keep business logic close to the services and avoid adopting another framework. We rejected it because it would have made the team own checkpoint/recovery behavior, state migration, event-time ordering, duplicate suppression, scaling, backpressure, and latency tuning. Flink did not remove those concerns, but it provided tested primitives for them. We still handled correctness at the TiDB sink through idempotent hourly keys and reconciliation.

## Architecture / Design

The platform had two table groups, but both were queryable through TiDB. Selected production tables were stored in TiKV, with [TiFlash](https://docs.pingcap.com/tidb/stable/tiflash-overview) maintaining asynchronous columnar Raft Learner replicas. For derived metrics, TiCDC sent selected changes to Kafka; Flink aggregated them and wrote `ads_*` tables back to TiDB—not directly to TiFlash—over MySQL/JDBC; TiKV persisted the rows and TiFlash maintained the serving replicas.

For the direct replicas, TiKV → TiFlash was a storage-engine operation rather than an external ETL job. One command enabled the replica:

```sql
ALTER TABLE <source_table> SET TIFLASH REPLICA 1;
```

TiFlash then bootstrapped existing rows through a Raft Learner snapshot and applied subsequent Raft updates. We did not write a separate full-load/backfill job, store high-watermark offsets, or run an incremental sync process for those replicas. This did not eliminate operational work: replica progress, storage headroom, IOPS, scans, and compaction became part of the TiDB capacity model. The TiCDC → Kafka → Flink path remained conventional ETL because it transformed selected events into new `ads_*` aggregates.

Logically, the warehouse followed ODS → DWD → DWS. TiCDC-fed source tables formed ODS; Flink joined event streams and dimensions into detail/wide tables for DWD; SQL jobs materialized hourly aggregates into `ads_*` DWS tables. Because all layers lived in TiDB, the layering set naming, ownership, and refresh rules; it did not require a separate database.

{% asset_img architecture-c4.png C4 container view of the real-time data platform: selected production tables with TiFlash replicas, TiCDC, Kafka, Flink SQL and DataStream jobs, ads_* aggregates, QueryHub, Redis caching, and dashboard users %}

TiCDC captured only selected event tables—transaction settlements, order amounts, referral/commission ledgers, promotion records, and wallet transfers. Kafka partitioned high-volume tables by user ID, preserving per-user ordering while allowing parallel consumers.

## Key Technical Decisions

### SQL-first processing

SQL jobs produced hourly aggregate rows keyed by bucket time and business dimensions. A separate DataStream JAR handled workloads that needed custom state or event cleaning: it owned user-session state driven by device and transaction events, and cleansed standard-operating-procedure (SOP) lifecycle-management data. This kept most metrics reviewable while isolating timers, keyed state, and change-only output.

### Idempotent hourly aggregates

Aggregates were not append-only facts. Each hourly table used the bucket start timestamp plus business dimensions as its primary key. Flink JDBC sinks upserted those keys, so early fires, checkpoint restarts, or batch reruns replaced the same row instead of creating duplicates.

```sql
-- Simplified Flink sink shape; several hourly tables followed this pattern.
CREATE TABLE ads_user_transfer_source_symbol_hourly (
    created_at BIGINT NOT NULL,      -- UTC millisecond bucket start
    source     STRING NOT NULL,
    symbol     STRING NOT NULL,
    amount     DECIMAL(38, 18),
    amount_usd DECIMAL(38, 18),
    PRIMARY KEY (created_at, source, symbol) NOT ENFORCED
) WITH (
    'connector' = 'jdbc'
);
```

Batch jobs reread a selected time range and recalculated the same keys, making reconciliation targeted rather than a full rebuild. Streaming and batch paths therefore shared one serving table; that avoided a separate reconciliation target but increased contention on the TiDB cluster and required closer attention to TiFlash sync capacity.

### QueryHub template service

I **designed and built** QueryHub, the self-developed SQL-template service. It stored named SQL templates as versioned configuration. A template carried its data source, SQL, parameters, cache policy, status, and version. Query execution became a configuration change rather than a new Go handler, route, DTO, and deployment. Reviewed SQL seeds were still required, and a new visualization could still require frontend wiring.

Redis keys included the template name, sorted-parameter hash, and cache-group version. Hot queries reused results while related templates could be invalidated together.

### Timezone-aware reporting

Streaming jobs wrote UTC millisecond buckets. QueryHub templates accepted a `:time_zone` parameter, converted report boundaries to UTC, and grouped stored buckets into viewer-local dates or months. Templates generated date/month series, left joined aggregates onto them, and filled inactive periods with zero. The same physical rows supported different local reporting boundaries and consistent MoM/YoY comparisons.

## Implementation

The platform spanned two Kubernetes clusters. TiDB, PD, TiKV, and TiFlash ran in a dedicated TiDB K8s cluster, while TiCDC captured their changes into Kafka. Flink and QueryHub ran in the business K8s cluster, in different namespaces. This preserved database cluster isolation while reusing the business deployment model and a MySQL-compatible query interface.

| Component | Configuration / scale | Role |
|---|---|---|
| Flink cluster | 1.15.4; HA; 2 ZooKeeper-coordinated JobManagers; S3/MinIO checkpoints; 10-second `EXACTLY_ONCE` checkpoints for SQL jobs | Processing runtime |
| Flink SQL | 9 streaming jobs, 4 batch jobs | Aggregation, joins, and reconciliation |
| DataStream JAR | Java JAR on the same Flink cluster | User online/session state and SOP (standard-operating-procedure) lifecycle-management cleansing |
| TiDB | 2 nodes, 16 vCPU / 48 GiB floor | MySQL-compatible query endpoint |
| PD | 3 nodes, 8 vCPU / 16 GiB floor | Metadata and scheduling |
| TiKV | 3 nodes, 16 vCPU / 64 GiB floor | Row storage for production and derived tables |
| TiFlash | 2 nodes, 32 vCPU / 64 GiB floor | Columnar replicas for analytical queries |
| TiCDC | 2 nodes, 16 vCPU / 64 GiB floor | Change capture into Kafka |
| QueryHub | At least 2 replicas behind HPA | SQL templates, parameter binding, caching, and query API |

AWS instance families met or exceeded PingCAP's production floors rather than reproducing them exactly. Each metric followed the same rollout path: Flink job, `ads_*` table, optional TiFlash replica, QueryHub template, and frontend chart mapping. Early jobs landed in June; settlement, commission, promotion, campaign, and wallet-transfer jobs followed over the next months.

For dashboard queries, the admin frontend called QueryHub's named-query API through the gateway. QueryHub returned generic tabular rows, which ECharts rendered in the existing React admin.

## Production Challenges

The first production problem was not Flink SQL or TiCDC correctness; it was TiFlash storage sizing. The TiFlash data volumes initially used **default IOPS provisioning**. As continuous writes arrived, replica synchronization lagged because writes, replica maintenance, and analytical reads competed for the small per-volume IOPS budget. The visible symptom was stale analytical tables.

The diagnosis was concrete: **TiFlash freshness depended on enough disk IOPS**; it was not a free index attached to TiKV.

| Setting | Value | Meaning |
|---|---:|---|
| Initial TiFlash data volume | Cloud-volume default | Left too little headroom for the replica’s concurrent workloads |
| Updated TiFlash data volume | 40,000 provisioned IOPS | Applied independently to each TiFlash data volume |
| TiFlash layer aggregate | 80,000 provisioned IOPS | Two TiFlash nodes; **not a shared cluster-wide pool** |

This table describes the observed bottleneck, not the complete storage model. TiKV also required SSD storage—and preferably NVMe/PCIe SSDs—because TiDB writes became Raft-replicated row storage and TiCDC read those changes. TiKV's RocksDB LSM path also needed IOPS and throughput headroom for WAL writes, memtable flushes, and background compaction; queueing there could raise write and Raft latency even without TiFlash contention. The incident surfaced on TiFlash first because columnar replicas added a second storage workload with scans, merge/compaction, and synchronization traffic.

After the change, TiFlash replicas kept up with the streaming path, and second-level freshness became dependable in normal operation. Public guidance reinforced the direction: PingCAP recommends NVMe/PCIe SSDs for TiKV and says TiFlash's first data disk should not be slower than TiKV. On AWS, gp3 starts at 3,000 IOPS by default, while provisioned-IOPS volumes scale higher at additional cost.

This choice also changed cost. The TiFlash layer added dedicated nodes and 40,000 provisioned IOPS per data volume, so each analytical replica increased baseline storage and IOPS cost—not only query load. We paid for that choice with more storage headroom and provisioned IOPS rather than operating a separate OLAP service.

TiFlash also added an operational checklist. TiCDC does not replicate TiFlash DDL, so we explicitly enabled each derived table's replica and verified that it was queryable before calling the dashboard production-ready.

## Results

The platform moved dashboards from ad-hoc production queries to a repeatable pipeline. Transaction records were the largest write path: one user action produced *one or two* transaction writes, so the path handled roughly **10–20 million rows per day**, with peaks of **at least 500 inserts per second**. The Flink jobs covered transaction/settlement, promotion, commission-ledger, wallet-transfer, campaign, and online/session data; the Java DataStream JAR added SOP lifecycle-management cleansing. That scale became the reference for CDC throughput, Kafka partitioning, Flink parallelism, and TiFlash capacity.

| Outcome | Evidence | Engineering effect |
|---|---|---|
| Near-real-time analytics | Second-level OLTP-to-analytics freshness | Enabled active-campaign monitoring instead of T+1 review |
| Analytical query isolation | QueryHub read analytical tables and cached hot queries | Reduced uncontrolled production-table scans |
| Reporting as configuration | More than 100 parameterized SQL templates | New query-backed metrics became configuration changes, not service deployments |
| Consistent linked dashboards | Cache groups and keyed hourly aggregates | Linked views used the same metric definitions |
| Targeted reconciliation | Batch rewrote the same hourly keys | Corrected selected ranges without rebuilding serving tables |
| Ledger reconciliation | Covered settlement and commission ledgers | Supported repeatable reconciliation |
| Faster delivery | Template reuse plus agent assistance | New query-backed metrics often required only template configuration and review; visualization work still depended on the frontend |

## Trade-offs

The result was **logical decoupling** from production tables, not **physical isolation** from TiDB. That made delivery faster, but analytics still shared the same TiDB cluster’s CPU, storage, IOPS, and operational path.

What it made better:

- One TiDB endpoint preserved MySQL compatibility, operational familiarity, and joins between source and derived tables.
- Hourly primary keys made streaming recovery, checkpoint restarts, and batch reruns target the same rows.
- TiFlash provided a columnar path without introducing a second SQL dialect.
- QueryHub turned report execution into reviewed configuration.

What it made worse:

- CDC, reconciliation, and analytical scans remained coupled through TiDB’s storage and query path.
- TiFlash added dedicated nodes, replica capacity, provisioned IOPS, and the runtime cost of replica maintenance.
- QueryHub removed service-code work but did not remove metric review or frontend wiring.

## What I Learned

Hardware floors were necessary but not sufficient. TiFlash sizing still depended on changed-row volume, scan shape, compaction pressure, and freshness targets.

Idempotency mattered more than connector choice. Shared hourly primary keys let streaming recovery, batch reconciliation, and targeted correction update the same aggregate rows.

Platform boundaries changed team workflow. A reviewed SQL template made metric definitions, parameters, cache invalidation, and access visible as configuration.

## What I Would Change Today

The single-TiDB-cluster design was defensible for this team and initial workload, but TiFlash still introduced a second storage engine whose cost and failure modes were coupled to the analytical path. That footprint was justifiable for correctness and HA, yet it front-loaded infrastructure cost before analytical query volume fully materialized.

Before deciding that TiDB itself was the cost problem, I would measure the write and query path:

| Path to measure | What to measure | Why it mattered |
|---|---|---|
| TiCDC | Changed rows per table and changefeed lag | Separated broad write amplification from a hot source table |
| Kafka | Partition throughput and skew | Checked whether user-ID partitioning stayed parallel |
| Flink | Checkpoint size/duration and JDBC upsert rate | Connected business events to state and sink pressure |
| TiKV | Raft write latency, compaction, and storage queueing | Identified impact on transactional durability |
| TiFlash | Replica sync lag, scan IOPS, and compaction pressure | Linked write-back and scans to freshness and latency |

I would then reduce coupling in stages: route dashboards to analytical tables, cache hot results, isolate batch windows, provision TiFlash storage independently, and keep QueryHub scans bounded. Where the freshness target allowed, I would evaluate TiDB resource groups, placement rules, and stale reads. If sustained detail scans, replica lag, storage queueing, or query load threatened OLTP capacity, I would separate analytical storage/compute and migrate detail/history first.

Hourly aggregates were keyed for targeted reads, so moving them to columnar storage would make sense *only if* width, retention, dimension cardinality, or scan pattern justified it. Migration would also change sink semantics: TiDB primary keys and upserts made recovery, reruns, and reconciliation idempotent, while ClickHouse would require explicit merge/deduplication, ordering, query visibility, and correction semantics.

For a cloud-first product starting small, Aurora → Kafka CDC → ClickHouse *can have* lower starting cost and more independent scaling. The later voice-chat project used that pattern, but its source database, workload, and constraints differed. The next version should make analytical storage cost, write and query paths, and scale ceilings explicit from the beginning.

---

*Previous in this series: [Building a Production-Grade Go Microservice Architecture from Zero](/posts/engineering-case-study/building-a-production-grade-go-microservice-architecture-from-zero/) — the same team, the same product, a different layer of the platform.*
