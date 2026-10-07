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

Four Go engineers. Eighteen Go domain services and one auxiliary backend repository. A consumer transaction platform where correctness was non-negotiable and live-ops shipped weekly. That pressure was manageable only if the right architecture had a low marginal cost to follow — if conventions were **generated instead of policed**. So the platform made the right structure the default: a single API DSL as the contract entry, custom code generation down to [Protocol Buffers](https://protobuf.dev/) and [Swagger/OpenAPI](https://swagger.io/specification/). This is the retrospective of what that bought, and what it cost.

{% asset_img cover.png Go Microservice Platform cover: clients, API gateway, domain services, Kafka, ws-hub, TiDB %}

## Context and Constraints

The product team was assembled from scratch in early 2025 with seventeen people: four Go engineers building the backend, six frontend developers, two QA, two UI designers, and three product managers driving the live-ops roadmap. The product itself was racing to match the feature set and live-ops cadence of the top platforms in its market. I initiated and led the platform program that ran February to May: an architecture template, a contract toolchain, a shared gateway, base libraries, and CI — built in parallel with the first business services. The platform then remained the default path as the backend grew to eighteen Go domain services spanning identity and access, financial transactions and ledger integrations, consumer engagement, growth and live-ops, and platform infrastructure. The repository statistics also include one auxiliary backend repository, `geoip-update`; the API gateway is counted separately.

The same four engineers had to ship against money-movement flows and around-the-clock availability while the platform was being built. We also made one choice early: standardize on [go-zero](https://github.com/zeromicro/go-zero) rather than build another framework. The platform's job was to encode conventions, not to own runtime infrastructure.

## Problem

Four engineers could not hand-maintain conventions across eighteen Go domain services at production grade. Every service would need auth, error codes, structured logging, RPC wiring, gateway registration, and tracing; done by hand, each one would diverge within weeks, and every divergence would cost integration time the schedule did not have. The problem was not cleaning up a mess. It was making sure the mess never got a chance to form — without spending the people who were supposed to ship the product.

## Requirements

- One contract entry per service, from which handlers, RPC, and docs all derive.
- A scaffold that enforced the architecture instead of documenting it.
- Platform-wide error codes, auth, and context propagation as libraries.
- Gateway-managed response caching for consumer-facing interfaces, configured at the interface level rather than rebuilt inside each service.
- CI and tracing by default on every service.
- Generated service shells that carried production defaults from their first commit; there was no move-fast-and-fix-later phase to lean on.
- An onboarding cost we could measure.

## Options Considered

The serious decision was not which framework but the **contract direction**. go-zero already provided service discovery and goctl, its API-first code generator; the team knew it well. The alternative to goctl's `.api` DSL was proto-first: define [gRPC](https://grpc.io/) contracts and derive HTTP from them.

Proto-first would have made proto the canonical internal contract, but the client-facing HTTP route, request shape, auth annotation, cache option, or Swagger document still needed a second definition. That was the double-contract drift we wanted to remove. It also would have pushed us toward maintaining more of the generation chain ourselves. DSL-first gave up some proto-level control: services that needed advanced gRPC features fell back to hand-written proto. We accepted that rare exception because one `.api` file could remain the entry for handlers, generated proto, and Swagger.

## Architecture / Design

The [C4](https://c4model.com/) container view below shows the platform as it runs today. Clients speak HTTPS to a single API Gateway, which routes to domain services over gRPC and generates Protocol Buffer descriptor sets from the shared contract repository; Kubernetes Endpoints resolves live addresses. Services keep per-service schemas in [TiDB](https://docs.pingcap.com/tidb/stable/overview), cache in Redis, and export spans to [Zipkin](https://zipkin.io/). For user-facing pushes, services publish to Kafka and ws-hub fans notifications out over websockets. The collapsed service card represents the other seventeen services, so ws-hub is not counted twice. An i18n hook on the gateway response chain localizes dynamic response content, so **services stay locale-blind**.

{% asset_img architecture-c4.png C4 container view of the Go Microservice Platform: clients, API gateway with jwt, i18n, and configurable response caching, seventeen collapsed domain services plus ws-hub, TiDB per-service schemas, Redis caching, Kafka event publishing, websocket fan-out, and Zipkin tracing %}

## Key Technical Decisions

### DSL as the single contract entry

The mechanism is easier to inspect in one authentication contract. A single `.api` file carried the route, types, and three access-control tiers:

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

The git history made the same point quantitatively. Between March 4 and October 9, 2025, the contract repository absorbed 3,568 commits — more than any single service — while holding fifty-five `.api` contract files and sixty-eight generated proto schemas, with four hundred to seven hundred commits landing every month. Every interface change in the platform flowed through that one repository.

### Fill the generation gaps with plugins

Vanilla goctl generated HTTP handlers from `.api` but not proto or Swagger, and the platform needed both. We wrote two goctl plugins, goctl-proto and goctl-swagger, so one `.api` file produces handlers, proto, and Swagger in the same commit. Both install with `go install` and run in goctl's plugin mode: they extend the standard toolchain instead of replacing it.

### The scaffold as specification

The onion/DDD structure (application, domain, infrastructure, and service-context layers; repository interfaces in the domain with implementations injected from infrastructure; outbox-pattern domain events) lived in a README and in custom goctl templates. A service generated from the template starts compliant: the layering, the event outbox, and the repository seams all exist before the first line of business code. The README stayed the reference; the template did the enforcing.

The outbox rule applied to transactional domain events. It did not apply to every low-latency user notification: services published ws-hub notifications directly to Kafka. Keeping those paths separate avoided forcing interactive pushes through an outbox relay designed for delivery tied to a database transaction.

### Domain boundaries and data ownership

All eighteen services shared one TiDB cluster, so the boundary was drawn at the table level. The user service owned auth, KYC, and customer-profile tables; the ledger service owned currency orders, account balances, and token metadata. Cross-service access ran over gRPC, and a repository-layer scan confirmed zero cross-domain table access. **Disjoint table ownership** preserved service boundaries without operating eighteen databases.

### Platform-wide error codes

bizerr encodes every error as a six-digit code: two digits of service ID, two of function, two of error. Clients match on the prefix; anyone can decode an error to its origin without grep. Errors carry captured stacks and wrap their causes, so production incidents could be traced through the chain without re-running anything. The registry doubles as the coordination point — a new service claims its service ID once, and an unregistered code causes a **runtime panic**.

That panic treated an unregistered code as a programming error rather than an operational error. It was intended to fail in the first test run instead of allowing an error with no message, locale, or service origin to reach a user. The cost was that an untested path could still become a production failure, so centralized registration and error-path tests mattered; a build-time registry check would have been the better enforcement point.

```
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

The gateway wrapped a maintained go-zero fork and owned everything cross-cutting: JWT auth, header processing, response wrapping, CORS, response caching, and an i18n hook on the response chain that localizes response content per user locale. Consumer-facing interfaces enabled caching through gateway configuration, so a service did not have to implement its own response-cache path. Because localization also lived in the gateway, services stayed locale-blind — adding a language was a gateway change, not eighteen service changes.

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

The proto plugin emitted this route as a per-method cache option with a 300-second TTL and `CACHESCOPE_GLOBAL`. At startup, the gateway read the descriptor and installed Redis cache middleware only for routes with a positive TTL. The key covered the HTTP method, path, query, JSON body, `Accept-Language`, and `User-Agent`. JWT ran before cache on protected routes, so provider and user ID also entered the key. An authenticated request was therefore isolated even when the annotation requested a global cache: **response safety over cross-user reuse**.

The i18n hook localized the CMS's dynamic content — product descriptions, promotions, and operational copy — per user locale, managed by operations through the language service. Error messages took a different path by design: services return language-neutral error codes, and the frontend maps each code to a localized string through its own static i18n library — no backend round-trip for error localization.

### Generation over governance

Every convention that could be enforced by generation was: custom goctl templates generated the onion structure, makefile targets pinned the base-library set, and shared CI templates standardized pipelines for Go, React, and Next.js services. Convention reviews do not scale; code generation does.

### What we deliberately did not build

The refusals were as deliberate as the builds. We skipped Istio because go-zero already carried service discovery and the microservice mechanics we needed. We used the Kubernetes API instead of a custom deployment system, kept the maintained go-zero fork instead of a new RPC framework, and left early configuration in ConfigMap until business operations needed config-hub's runtime changes. The rule was **concrete operational need before platform weight**.

## Implementation

A generated service started with an `.api` skeleton, onion directory tree, Dockerfile, and deployment manifests. Its build referenced the six base libraries, the go-zero fork, and service SDKs; shared GitLab includes supplied Go, React, and Next.js pipelines. Zipkin tracing was a config line. The gateway loaded method descriptors at startup and resolved backends through Kubernetes Endpoints, so adding pods did not require gateway redeployment.

## Adoption

With a four-person team, adoption was a **sequencing problem**, not a persuasion problem: the scaffold had to stay ahead of the services while features shipped. The template evolved with the first services; every later service generated from it. The only non-generated convention was claiming a service ID in the bizerr registry.

The platform kept paying after the build window closed. Once the scaffold and the DSL stabilized, team members started writing business logic with AI coding agents, and delivery got faster again. The reason is structural: the contract fixed the interface, the generated tree fixed the layering, and the error registry fixed the failure shape. Agents amplified an already-constrained codebase instead of amplifying divergence.

## Where the Defaults Leaked

### A contract change reached QA

The `.api` files had no change monitoring. When one interface definition changed, no consumer saw the generated proto or Swagger diff before merge. QA's automated consumer-call tests caught the incompatible change before release, which was better than a production failure — but **QA had become the detector** for a contract problem that CI could have exposed at the merge boundary.

### An admin editor crossed four contracts

One admin editor exposed the missing composition boundary. A single page called content/activity, catalog, payment-metadata, and localization services directly. It loaded catalog providers, playable items, token metadata, and localized components. On save, the frontend first upserted localized copy, read back generated references, merged them into the business payload, and then called the business create or update API.

That made the **browser own a cross-service write sequence**. If localization succeeded but the business write failed, localized components remained while the business record did not. Several admin pages also independently fetched catalog providers, payment metadata, or localized labels, so a small visible change could cross multiple domain contracts.

## Results

The adoption result was that all eighteen Go domain services came from the scaffold. Rare advanced gRPC cases used hand-written proto, but no service was hand-rolled outside the template; three shared CI pipelines covered backend and frontend repositories.

The development-cost result was an estimated **60% reduction in onboarding work**, measured in boilerplate lines and person-days to a first deployed endpoint. It was an internal estimate, not a controlled experiment.

The delivery-scale evidence was eighteen services from identity to ledgers to interactive products, plus the auxiliary `geoip-update` repository. Across forty repositories, the platform recorded eleven thousand commits between March 4 and October 9, 2025. The gateway carried fourteen generated descriptor sets — a repository count, not a service count — and services used eight SDKs layered on the six internal base libraries.

## Was It Worth It for Four People?

Fair question: the platform cost the program's first four months of focused time, from a team that was also standing up its first services. The return came from the work it removed. Eighteen Go domain services each needed auth, error codes, tracing, configuration, deployment, and gateway registration; the scaffold generated the recurring shell, turning days of boilerplate per service into a single command. The ledger services raised the stakes: correctness patterns like the outbox and the error-code registry were encoded once, centrally, instead of re-implemented — and re-gotten-wrong — in every service that touched money.

And the beneficiaries were never just the backend — or even just engineering. The shared CI templates covered the React and Next.js pipelines the frontend developers worked in; Swagger generation kept their integration contracts current with every `.api` commit; and the registered error codes made QA's failures decodable to a service and function instead of mysterious. The product managers felt it loudest: the live-ops expansion of June and July — referrals, membership programs, interactive campaigns — shipped off the same scaffold. Seventeen people consumed what four people built.

I would not run this play everywhere. It stops being worth it on a short product runway, with a service count that never passes four or five, or if the platform build slips into its own project. None of those were our world: the roadmap called for what became eighteen Go domain services, the product team was seventeen people from the start, and the platform landed inside its February-to-May window.

## Trade-offs

DSL-first gave up proto-level control: generated proto constrained advanced gRPC features, and services that needed them dropped to hand-written proto (rare, but real). The maintained go-zero fork is a permanent maintenance duty; we took fixes on our schedule, not upstream's. Onion layering adds indirection that is overhead for thin CRUD services — the template made it cheap, not free. And the central error-code registry is a coordination point: two services cannot silently claim the same ID.

## What I Learned

For a small team, the cheapest time to enforce a convention is before the first service exists. Every service generated after that point inherits the platform defaults; every avoidable hand-rolled exception would have spent the schedule twice. Contract drift, when it appeared, turned out to be a tooling problem too: moving the contract into the source of generation ended it without a process. And boring choices compound: standardizing on go-zero and a DSL we did not invent left our innovation budget for the two plugins and the scaffold — the parts that were actually ours.

## What I Would Change Today

### Chaos-test the failover paths

Pod rescheduling, ws-hub reconnection, and gateway instance failure paths were designed but never systematically tested under failure conditions. A chaos suite that restarts gateway instances, interrupts service discovery, and exercises ws-hub reconnection under load would have validated those assumptions before production traffic did.

### Alert on API contract changes

The QA discovery pointed to a missing merge-time signal. I would add a CI step that diffs generated proto and Swagger against the previous version and posts the delta before a consumer contract can change unnoticed.

### Introduce a BFF boundary

For that admin editor, I would introduce a BFF endpoint for the page shape and the localization-plus-business write sequence. Domain services would keep content, catalog, payment, and localization ownership; the BFF would own compensation and idempotency. The same boundary would give other admin pages one composition contract instead of four parallel frontend assembly paths.

Previous in this series: [Designing a Lightweight Scheduler for 200K+ Delayed Execution Commands per Second](/posts/engineering-case-study/designing-a-lightweight-scheduler-for-200k-delayed-execution-commands-per-second/) — a different company, a different problem: the scheduler built before this platform.
