---
title: Scaling a Four-Engineer Backend to Eighteen Go Services with Generated Contracts
date: 2025-10-10 12:00:00
categories:
 - Engineering Case Study
tags:
 - go
 - microservices
 - api-gateway
 - platform-engineering
 - developer-productivity
---

Four Go engineers built eighteen domain services and one auxiliary backend repository for a consumer transaction platform with weekly live-ops releases. To keep integration work manageable, we used a single API DSL to generate service conventions, [Protocol Buffers](https://protobuf.dev/) contracts, and [Swagger/OpenAPI](https://swagger.io/specification/) documentation.

{% asset_img cover.png Go Microservice Platform cover: clients, API gateway, domain services, Kafka, ws-hub, TiDB %}

## Context and requirements

The product team was assembled from scratch in early 2025 with seventeen people: four Go engineers building the backend, six frontend developers, two QA, two UI designers, and three product managers driving the live-ops roadmap. That roadmap required weekly feature releases rather than a long platform-build cycle. I **initiated and led** the platform program that ran February to May: an architecture template, a contract toolchain, a shared gateway, base libraries, and CI — built in parallel with the first business services. The platform then remained the default path as the backend grew to eighteen Go domain services spanning identity and access, financial transactions and ledger integrations, consumer engagement, growth and live-ops, and platform infrastructure. The repository statistics also include one auxiliary backend repository, `geoip-update`; the API gateway is counted separately.

The same four engineers had to ship against money-movement flows and around-the-clock availability while the platform was being built. We also made one choice early: standardize on [go-zero](https://github.com/zeromicro/go-zero) rather than build another framework. We used the platform to encode conventions while relying on go-zero for runtime infrastructure.

Each service needed auth, error codes, structured logging, RPC wiring, gateway registration, and tracing. Maintaining these by hand across the service fleet would consume integration time and let implementations diverge. The platform needed:

- One contract entry per service, from which handlers, RPC, and docs all derive.
- A scaffold that generated the required architecture.
- Platform-wide error codes, auth, and context propagation as libraries.
- Gateway-managed response caching for consumer-facing interfaces, configured at the interface level rather than rebuilt inside each service.
- CI and tracing by default on every service.
- Generated service shells with production defaults from their first commit.
- An onboarding cost we could measure.

## Options Considered

The main choice was the contract direction. go-zero already provided service discovery and goctl, its API-first code generator; the team knew it well. The alternative to goctl's `.api` DSL was proto-first: define [gRPC](https://grpc.io/) contracts and derive HTTP from them.

Proto-first would have made proto the canonical internal contract, but the client-facing HTTP route, request shape, auth annotation, cache option, or Swagger document still needed a second definition. That was the **double-contract drift** we wanted to remove. It also would have pushed us toward maintaining more of the generation chain ourselves. DSL-first gave up some proto-level control: services that needed advanced gRPC features fell back to hand-written proto. We accepted that *rare exception* because one `.api` file could remain the entry for handlers, generated proto, and Swagger.

## Architecture / Design

The [C4](https://c4model.com/) container view below shows the platform as it runs today. Clients speak HTTPS to a single API Gateway, which routes to domain services over gRPC using Protocol Buffer descriptor sets generated from the shared contract repository; Kubernetes Endpoints resolves live addresses. Services keep per-service schemas in [TiDB](https://docs.pingcap.com/tidb/stable/overview), cache in Redis, and export spans to [Zipkin](https://zipkin.io/). For user-facing pushes, services publish to Kafka and ws-hub fans notifications out over websockets. The collapsed service card represents the other seventeen services, so ws-hub is not counted twice. An i18n hook on the gateway response chain localizes dynamic response content, so services stay locale-blind.

{% asset_img architecture-c4.png C4 container view of the Go Microservice Platform: clients, API gateway with jwt, i18n, and configurable response caching, seventeen collapsed domain services plus ws-hub, TiDB per-service schemas, Redis caching, Kafka event publishing, websocket fan-out, and Zipkin tracing %}

## Key Technical Decisions

### DSL as the single contract entry

A single authentication `.api` file carried the routes, types, and three access-control tiers:

```
syntax = "v1"

// public login
@server(
 prefix: /v1/admin/auth
)
service AdminAuthService {
 @handler Login
 post /login (LoginReq) returns (LoginRes)
}

// admin JWT required
@server(
 prefix: /v1/admin/auth
 auth: admin
)
service AdminAuthService {
 @handler Verify2FA
 post /verify2fa (Verify2FAReq) returns (Verify2FARes)
}

// permission-gated reset
@server(
 prefix: /v1/admin/auth
 auth: "admin=permissionUserResetPwd"
)
service AdminAuthService {
 @handler ResetPassword
 post /reset_password (ResetPasswordReq) returns (ResetPasswordRes)
}
```

Handlers and types came from goctl; our plugins generated proto and Swagger from the same source. There was no second route definition to drift from.

The contract repository held fifty-five `.api` contract files and sixty-eight generated proto schemas. Between March 4 and October 9, 2025, it absorbed 3,568 commits — more than any single service — with four hundred to seven hundred landing every month. Every interface change in the platform flowed through that one repository.

### Fill the generation gaps with plugins

Vanilla goctl generated HTTP handlers from `.api` but not proto or Swagger, and the platform needed both. We wrote two goctl plugins, goctl-proto and goctl-swagger, so one `.api` file produces handlers, proto, and Swagger in the same commit. Both install with `go install` and run in goctl's plugin mode: they extend the standard toolchain instead of replacing it.

### The scaffold as specification

The onion/DDD structure (application, domain, infrastructure, and service-context layers; repository interfaces in the domain with implementations injected from infrastructure; outbox-pattern domain events) lived in a README and in custom goctl templates. A service generated from the template starts compliant: the layering, the event outbox, and the repository seams all exist before the first line of business code. The README documented the structure, and the template generated it.

### Transactional domain events through the outbox

Services persisted domain events in an outbox table within the same TiDB transaction as the business-state change. TiCDC captured committed outbox rows and delivered them to Kafka as `domain_event_*` topics. This kept event persistence consistent with the business transaction and removed the gap between committing data and publishing an event. Delivery remained asynchronous, and consumers still needed idempotent handling on replay.

Low-latency ws-hub notifications were published directly to Kafka. Transactional domain events followed the outbox path.

### Domain boundaries and data ownership

All eighteen services shared one TiDB cluster, so the boundary was drawn at the table level. The user service owned auth, KYC, and customer-profile tables; the ledger service owned currency orders, account balances, and token metadata. Cross-service access ran over gRPC, and a repository-layer scan confirmed zero cross-domain table access. Disjoint table ownership preserved service boundaries without operating eighteen databases.

### Platform-wide error codes

bizerr encodes every error as a six-digit code: two digits of service ID, two of function, two of error. Clients match on the prefix; anyone can decode an error to its origin without grep. Errors carry captured stacks and wrap their causes, so production incidents could be traced through the chain without re-running anything. The registry doubles as the coordination point — a new service claims its service ID once, and an unregistered code causes a runtime panic.

That panic treated an unregistered code as a **programming error** rather than an operational error. It was intended to fail in the first test run instead of allowing an error with no message, locale, or service origin to reach a user. The cost was that an untested path could still become a production failure, so centralized registration and error-path tests mattered; a build-time registry check would have been the better enforcement point.

```go
// each service claims an id; codes are registered with metadata
const errUserNotFound = bizerr.ErrCode(120401)

func init() {
 bizerr.RegisterErrorCode(errUserNotFound, bizerr.ErrorMeta{
 DefaultMessage: "user not found",
 })
}

// call sites build from registered codes only —
// an unregistered code panics before it can reach a user
return errUserNotFound.Build(err)
```

### Gateway as the composition edge

The gateway wrapped a maintained go-zero fork and owned everything cross-cutting: JWT auth, header processing, response wrapping, CORS, response caching, and an i18n hook on the response chain that localizes response content per user locale. Consumer-facing interfaces enabled caching through gateway configuration, so a service did not have to implement its own response-cache path. Because localization also lived in the gateway, services stayed locale-blind; adding a language required one gateway change.

The cache setting stayed in the same interface contract. A consumer-facing banner route looked like this:

```
@server(
 prefix: /v1/banner/noauth
 auth: none
 i18n: enabled
)
service BannerService {
 @doc(
 summary: "get banner list for web"
 cache: "expiresIn=300"
 )
 @handler GetBannerListForWeb
 post /get/banner/list (GetBannerListRequest) returns (GetBannerListResponse)
}
```

The proto plugin emitted this route as a per-method cache option with a 300-second TTL and `CACHESCOPE_GLOBAL`. At startup, the gateway read the descriptor and installed Redis cache middleware only for routes with a positive TTL. The key covered the HTTP method, path, query, JSON body, `Accept-Language`, and `User-Agent`. On protected routes, JWT ran before cache, so the authenticated provider and user IDs also entered the key. An authenticated request was therefore isolated even when the annotation requested a global cache.

The i18n hook localized the CMS's dynamic content — product descriptions, promotions, and operational copy — per user locale, managed by operations through the language service. Error messages took a different path by design: services return language-neutral error codes, and the frontend maps each code to a localized string through its own static i18n library, avoiding a backend round-trip for error localization.

### Shared generation and CI templates

Every convention that could be enforced by generation was enforced there: custom goctl templates generated the onion structure, makefile targets pinned the base-library set, and shared CI templates standardized pipelines for Go, React, and Next.js services.

### Runtime and deployment choices

We skipped Istio because go-zero already carried service discovery and the microservice mechanics we needed. We used the Kubernetes API instead of a custom deployment system, kept the maintained go-zero fork instead of a new RPC framework, and left early configuration in ConfigMap until business operations needed config-hub's runtime changes.

## Implementation

A generated service started with an `.api` skeleton, onion directory tree, Dockerfile, and deployment manifests. Its build referenced the six base libraries, the go-zero fork, and service SDKs; shared GitLab includes supplied Go, React, and Next.js pipelines. Zipkin tracing was a config line. The gateway loaded method descriptors at startup and resolved backends through Kubernetes Endpoints, so adding pods did not require gateway redeployment.

Pod rescheduling, ws-hub reconnection, and gateway instance failure paths were designed but never systematically tested under failure conditions. A chaos suite that restarts gateways, interrupts service discovery, and exercises ws-hub reconnection under load would validate those assumptions.

## Adoption

The scaffold had to stay ahead of the services while the four-person team shipped features. The template evolved with the first services; every later service generated from it. The only non-generated convention was claiming a service ID in the bizerr registry.

Once the scaffold and DSL stabilized, team members started writing business logic with AI coding agents while feature delivery continued. The contract defined interfaces, the generated tree supplied the layering, and the error registry defined failure shapes, constraining the code agents produced.

## Where the Defaults Leaked

### A contract change reached QA

The `.api` files had no change monitoring. When one interface definition changed, no consumer saw the generated proto or Swagger diff before merge. QA's automated consumer-call tests caught the incompatible change before release. A CI step that diffs generated proto and Swagger against the previous version and posts the delta would expose these changes before merge.

### An admin editor crossed four contracts

One admin editor exposed the missing composition boundary. A single page called content/activity, catalog, payment-metadata, and localization services directly. It loaded catalog providers, playable items, token metadata, and localized components. On save, the frontend first upserted localized copy, read back generated references, merged them into the business payload, and then called the business create or update API.

The browser owned the cross-service write sequence. If localization succeeded but the business write failed, localized components remained while the business record did not. Several admin pages also independently fetched catalog providers, payment metadata, or localized labels, so a small visible change could cross multiple domain contracts.

For this editor, I would add a BFF endpoint that owns the page shape and localization-plus-business write sequence, including compensation and idempotency. Domain services would retain content, catalog, payment, and localization ownership. Other admin pages could use the same boundary instead of assembling four separate contracts in the frontend.

## Results

The adoption result was that all eighteen Go domain services came from the scaffold. Rare advanced gRPC cases used hand-written proto, but no service was hand-rolled outside the template; three shared CI pipelines covered backend and frontend repositories.

The development-cost result was an estimated 60% reduction in onboarding work, measured in boilerplate lines and person-days to a first deployed endpoint. It was *an internal estimate, not a controlled experiment*.

The repository-scale context also included the auxiliary `geoip-update` repository. Across forty repositories, the platform recorded eleven thousand commits over that same March-to-October window. Those numbers show the volume of concurrent change the platform supported; they are not productivity measurements by themselves. The gateway carried fourteen generated descriptor sets — *a repository count, not a service count* — and services used eight SDKs layered on the six internal base libraries.

The platform took four months of focused work alongside the first business services. It replaced days of recurring boilerplate per service with a generation command and shared outbox and error-registry conventions for services handling money. Its users included the full seventeen-person product team: frontend developers used the shared React and Next.js pipelines and generated Swagger, and QA could trace errors to a service and function. The June and July live-ops expansion shipped referrals, membership programs, and interactive campaigns on the same scaffold.

## Trade-offs

The maintained go-zero fork is a permanent maintenance duty; we took fixes on our schedule, not upstream's. Onion layering adds indirection for thin CRUD services even when generated. The central error-code registry requires coordination so two services cannot silently claim the same ID.

This investment would be harder to justify on a short product runway, with no more than four or five services, or if platform work became a separate project that delayed product delivery.

The remaining leaks were at the seams rather than inside services: a contract change with no generated diff visible to consumers, and an admin page composing four domain contracts in the browser. Generation made per-service defaults cheap; the next platform work was making cross-contract change and cross-service composition visible before release.

---

*Previous in this series: [Designing a Lightweight Scheduler for 200K+ Delayed Execution Commands per Second](/posts/engineering-case-study/designing-a-lightweight-scheduler-for-200k-delayed-execution-commands-per-second/).*

*Next in this series: [Building a Real-Time Data Platform with TiDB CDC and Flink](/posts/engineering-case-study/building-a-real-time-data-platform-with-tidb-cdc-and-flink/).*
