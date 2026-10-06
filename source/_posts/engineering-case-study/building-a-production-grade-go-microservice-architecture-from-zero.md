---
title: Building a Production-Grade Go Microservice Architecture from Zero
date: 2025-10-03 12:00:00
categories:
 - Engineering Case Study
tags:
 - go
 - microservices
 - api-gateway
 - platform-engineering
 - developer-productivity
---

Four Go engineers. Nineteen production services. A consumer transaction platform where correctness was non-negotiable and live-ops cadence was measured in days. That pressure was manageable only if the right architecture had a low marginal cost to follow — if conventions were generated instead of policed. So the platform made the right structure the default: a single API DSL as the contract entry, custom code generation down to [Protocol Buffers](https://protobuf.dev/) and [Swagger/OpenAPI](https://swagger.io/specification/). This is the retrospective of what that bought, and what it cost.

{% asset_img platform-cover.png Go Microservice Platform cover: clients, API gateway, nineteen domain services, ws-hub, TiDB %}

## Context

The product team was assembled from scratch in early 2025: seventeen people — four Go engineers building the backend, six frontend developers, two QA, two UI designers, and three product managers driving the live-ops roadmap. The product itself was racing to match the feature set and live-ops cadence of the top platforms in its market. I initiated and led the platform program that ran February to May: an architecture template, a contract toolchain, a shared gateway, base libraries, and CI — built in parallel with the first business services, everything in this post shipped against that codebase. The platform then remained the default path as the backend grew to nineteen services spanning identity and access, financial transactions and ledger integrations, consumer engagement, growth and live-ops, and platform infrastructure.

## Problem

Four engineers couldn't hand-maintain conventions across nineteen services at production grade. Every service would need auth, error codes, structured logging, RPC wiring, gateway registration, and tracing; done by hand, each one would diverge within weeks, and every divergence would cost integration time the schedule did not have. The problem was not cleaning up a mess. It was making sure the mess never got a chance to form — without spending the people who were supposed to ship the product.

## Constraints

Four Go engineers for the entire backend. The product's benchmark was the top platforms in its market: feature cadence measured in days, money-movement flows where correctness was non-negotiable, and around-the-clock availability. And one constraint by choice: we standardized on [go-zero](https://github.com/zeromicro/go-zero) rather than building a framework — the platform's job was to encode conventions, not to own runtime infrastructure.

## Requirements

- One contract entry per service, from which handlers, RPC, and docs all derive.
- A scaffold that enforced the architecture instead of documenting it.
- Platform-wide error codes, auth, and context propagation as libraries.
- CI and tracing by default on every service.
- Services production-grade at their first commit; there was no move-fast-and-fix-later phase to lean on.
- An onboarding cost we could measure.

## Options Considered

The serious decision was not which framework but how deep to standardize on the one we had. go-zero is one of the most widely used Go microservice frameworks in the Chinese ecosystem — performance-oriented, with built-in [etcd](https://etcd.io/) service discovery and a code generator (goctl). The team knew it well. The open question was the contract direction. goctl's native toolchain is API-first: it generates handlers, types, and routes from a `.api` DSL file. The alternative was proto-first — define [gRPC](https://grpc.io/) contracts and derive HTTP from them. We stayed DSL-first; the reasoning is in the next section.

## Architecture / Design

The [C4](https://c4model.com/) container view below shows the platform as it runs today. Clients speak HTTPS to a single API Gateway, which routes to the domain services over gRPC. Service descriptors live on the gateway side; discovery runs through [Kubernetes EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/). Services keep per-service schemas in [TiDB](https://docs.pingcap.com/tidb/stable/overview) over the MySQL protocol, cache in Redis, and export spans to [Zipkin](https://zipkin.io/). ws-hub terminates websockets and fans pushes out to clients on behalf of the services. The gateway card carries the piece I would highlight: an i18n hook on the response chain that localizes response content per user locale, so services stay locale-blind.

{% asset_img platform-architecture-c4.png C4 container view of the Go Microservice Platform: clients, API gateway with i18n and jwt, nineteen domain services on go-zero with onion/DDD scaffold, TiDB per-service schemas, Redis caching, Kubernetes discovery, Zipkin tracing, and ws-hub websocket fan-out %}

## Key Technical Decisions

### DSL as the single contract entry

The platform had a double-contract problem: clients spoke HTTP/JSON through the gateway while services spoke gRPC to each other. With proto-first, the HTTP side still needs its own route and type definitions; the same interface lives in two files and drifts. With DSL-first, one `.api` file expressed the complete feature — including its access-control tiers:

```
syntax = "v1"

// public: login, 2fa check, token refresh, password reset
@server(
 prefix: /v1/admin/auth
)
service AdminAuthService {
 @doc "check whether 2fa login is enabled"
 @handler Check2FA
 post /check2fa (Check2FAReq) returns (Check2FARes)

 @handler Login
 post /login (LoginReq) returns (LoginRes)

 @handler RefreshToken
 post /refresh_token (RefreshTokenReq) returns (RefreshTokenRes)

 @handler ForgetPassword
 post /forget_password (ForgetPasswordReq) returns (ForgetPasswordRes)
}

// admin-jwt required: 2fa verification
@server(
 prefix: /v1/admin/auth
 auth: admin
)
service AdminAuthService {
 @handler Verify2FA
 post /verify2fa (Verify2FAReq) returns (Verify2FARes)
}

// permission-gated: temporary-token password reset
@server(
 prefix: /v1/admin/auth
 auth: "admin=permissionUserResetPwd"
)
service AdminAuthService {
 @handler ResetPassword
 post /reset_password (ResetPasswordReq) returns (ResetPasswordRes)
}

type LoginReq {
 Identifier string `json:"identifier"`
 Password string `json:"password"`
 DeviceID string `json:"device_id"`
 Code string `json:"code"`
}

type Token {
 AccessToken string `json:"access_token"`
 AccessTokenExpireIn int64 `json:"access_token_expire_in"`
 RefreshToken string `json:"refresh_token"`
 RefreshTokenExpireIn int64 `json:"refresh_token_expire_in"`
}
```

Three access tiers in one contract: public login flow, admin-jwt verification, permission-gated password reset. Handlers, types, proto via our plugin, Swagger via the other — all generated from this one file. A single interface stops drifting because there is no second copy to drift from.

The git history made the same point quantitatively. The contract repository absorbed 3,568 commits in the platform's first seven months — more than any single service, holding fifty-five `.api` contract files and sixty-eight generated proto schemas, with four hundred to seven hundred commits landing every month. Every interface change in the platform flowed through that one repository.

### Domain boundaries and data ownership

All nineteen services shared one TiDB cluster, so the boundary that mattered was drawn at the table level: every service owned a disjoint set of tables — the user service held its auth, KYC, and customer-profile tables; the ledger service held currency orders, account balances, and token metadata. Each service's data layer reached only its own tables. Cross-service access ran exclusively over gRPC, with service discovery through Kubernetes EndpointSlices and the dependency graph explicit in every service's configuration; a repository-layer scan confirmed zero cross-domain table access. Shared infrastructure, owned data: one operational cluster, hard logical boundaries.

### Fill the generation gaps with plugins

Vanilla goctl generated HTTP handlers from `.api` but not proto or Swagger, and the platform needed both. We wrote two goctl plugins, goctl-proto and goctl-swagger, so one `.api` file produces handlers, proto, and Swagger in the same commit. Both install with `go install` and run in goctl's plugin mode: they extend the standard toolchain instead of replacing it.

### The scaffold as specification

The onion/DDD structure (application, domain, infrastructure, and service-context layers; repository interfaces in the domain with implementations injected from infrastructure; outbox-pattern domain events) lived in a README and in custom goctl templates. A service generated from the template starts compliant: the layering, the event outbox, and the repository seams all exist before the first line of business code. The README stayed the reference; the template did the enforcing.

### Platform-wide error codes

bizerr encodes every error as a six-digit code: two digits of service ID, two of function, two of error. Clients match on the prefix; anyone can decode an error to its origin without grep. Errors carry captured stacks and wrap their causes, so production incidents could be traced through the chain without re-running anything. The registry doubles as the coordination point — a new service claims its service ID once, and using an unregistered code panics at runtime.

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

The gateway wrapped a maintained go-zero fork and owned everything cross-cutting: JWT auth, header processing, response wrapping, CORS, and an i18n hook on the response chain that localizes response content per user locale. Because localization lived in the gateway, services stayed locale-blind — adding a language was a gateway change, not nineteen service changes.

The i18n hook localized the CMS's dynamic content — product descriptions, promotions, and operational copy — per user locale, managed by operations through the language service. Error messages took a different path by design: services return language-neutral error codes, and the frontend maps each code to a localized string through its own static i18n library — no backend round-trip for error localization.

### Generation over governance

Every convention that could be enforced by generation was: custom goctl templates generated the onion structure, makefile targets pinned the base-library set, and shared CI templates standardized pipelines for Go, React, and Next.js services. Convention reviews do not scale; code generation does.

### What we deliberately did not build

The refusals were as considered as the builds. No service mesh: go-zero already carried service discovery and the microservice mechanics we needed on Kubernetes, and Istio's operational weight was a tax a four-person team should not pay. No custom deployment system or RPC framework: the Kubernetes API and the maintained go-zero fork covered both, and a small team stays agile by standing on the platform it runs on. Even the config center waited: Kubernetes ConfigMap carried the early services, and config-hub was built only when business operations needed runtime-flexible configuration — self-service changes without engineering deploy cycles. One rule ran through every refusal: nothing heavy gets built before a concrete operational need forces it.

None of these decisions are specific to go-zero. The contract-entry choice, the plugin chain, and scaffold-as-specification transfer to any codegen-first stack — swap the framework and the pattern holds.

## Implementation

A new service started from the scaffold: the templates generated the `.api` skeleton, the onion directory tree, the Dockerfile, and deployment manifests. The makefile pinned the shared libraries at latest: utils, ddd-style, bizerr, go-zero, pubsub, auth, bizctx, plus any service SDKs. CI came from a shared GitLab include with pipelines for Go, React, and Next.js. Tracing was a config line: Zipkin batcher, full sampling in dev. The gateway discovered gRPC methods dynamically from Kubernetes endpoints at startup — new services were picked up without gateway redeployment as the platform grew toward nineteen services.

## Adoption

With a four-person team there was no convincing to do. The same people built the platform and the services, so adoption was a sequencing problem, not a persuasion problem: the scaffold had to stay ahead of the services while features shipped. In practice the template evolved with the first services, and every service that followed generated from it. Where a convention could not be generated, it had exactly one coordination point: claiming a service ID in the bizerr registry.

The platform kept paying after the build window closed. Once the scaffold and the DSL stabilized, team members started writing business logic with AI coding agents, and delivery got faster again. The reason is worth naming; I return to it in the closing note below.

## Results

- Nineteen services on the platform, from identity to ledgers to interactive products.
- The build itself: eleven thousand commits across forty repositories in the platform's first seven months.
- All nineteen generated from the scaffold, zero hand-rolled exceptions, by a team of four, while the product shipped weekly.
- Onboarding cost down roughly 60%, measured in boilerplate lines and person-days to a first deployed endpoint (an internal estimate, not a controlled measurement).
- Fourteen service descriptors registered at the gateway, and eight service SDKs layered on top of the six base libraries.
- Three CI pipelines covering every service and frontend.

## Was It Worth It for Four People?

Fair question: the platform cost the program's first four months of focused time, from a team that was also standing up its first services. The return came from the work it removed. Nineteen services each needed auth, error codes, tracing, configuration, deployment, and gateway registration; the scaffold generated all of it, turning days of boilerplate per service into a single command. The ledger services raised the stakes: correctness patterns like the outbox and the error-code registry were encoded once, centrally, instead of re-implemented — and re-gotten-wrong — in every service that touched money.

And the beneficiaries were never just the backend — or even just engineering. The shared CI templates covered the React and Next.js pipelines the frontend developers worked in; Swagger generation kept their integration contracts current with every `.api` commit; and the registered error codes made QA's failures decodable to a service and function instead of mysterious. The product managers felt it loudest: the live-ops expansion of June and July — referrals, membership programs, interactive campaigns — shipped off the same scaffold. Seventeen people consumed what four people built.

I would not run this play everywhere. It stops being worth it on a short product runway, with a service count that never passes four or five, or if the platform build slips into its own project. None of those were our world: the roadmap called for what became nineteen services, the team grew to seventeen, and the platform landed inside its February-to-May window.

## Trade-offs

DSL-first gave up proto-level control: generated proto constrained advanced gRPC features, and services that needed them dropped to hand-written proto (rare, but real). The maintained go-zero fork is a permanent maintenance duty; we took fixes on our schedule, not upstream's. Onion layering adds indirection that is overhead for thin CRUD services — the template made it cheap, not free. And the central error-code registry is a coordination point: two services cannot silently claim the same ID.

## What I Learned

For a small team, the cheapest time to enforce a convention is before the first service exists. Every service generated after that point inherits it for free; every hand-rolled exception would have spent the schedule twice. Contract drift, when it appeared, turned out to be a tooling problem too: moving the contract into the source of generation ended it without a process. And boring choices compound: standardizing on go-zero and a DSL we did not invent left our innovation budget for the two plugins and the scaffold — the parts that were actually ours.

## What I Would Change Today

### Chaos-test the failover paths

Pod rescheduling, ws-hub reconnection, and gateway instance failure paths were designed but never systematically tested under failure conditions. A chaos suite that restarts gateway instances, interrupts service discovery, and exercises ws-hub reconnection under load would have validated those assumptions before production traffic did.

### Alert on API contract changes

The `.api` contract files had no change monitoring - when an interface definition changed, no consumer was notified, and no team saw the diff before it merged. The change surfaced only when a consumer's call failed at runtime. A CI step that diffs the generated proto and Swagger against the previous version and posts the delta to the team channel would have made every contract change visible before it shipped.

### Introduce a BFF boundary

One admin editor showed the missing boundary. A single page called content/activity, catalog, payment-metadata, and localization services directly. It loaded catalog providers, playable items, token metadata, and localized components. On save, the frontend first upserted localized copy, read back generated references, merged them into the business payload, and then called the business create or update API.

That made the browser own a cross-service write sequence. If localization succeeded but the business write failed, the localized components remained while the business record did not. A backend-for-frontend endpoint for this editor would have made the composition explicit: the domain services would keep content, catalog, payment, and localization ownership, while the BFF owned the admin page shape and the localization-plus-business write path, including compensation or idempotency. It would not replace domain services; it would stop each page from assembling service boundaries by itself.

The same assembly cost appeared elsewhere. Several admin pages independently fetched catalog providers, payment metadata, or localized labels to build dropdowns and display names. A change to one visible page could therefore cross multiple domain contracts even when the business change was small.

## A Closing Note from the Agent Era

This platform was built before AI coding agents entered our workflow, and it turned out to be exactly what they needed. Agents amplify whatever the codebase already is: the contract repository, the per-service table ownership, and the generated scaffold got amplified into consistent, fast agent output, while a weak top-level design would have been amplified just as fast into something unmaintainable. What made the boundaries work was not the act of splitting services but encoding them into contract files, table ownership, and generated structure. When a boundary lives in a contract file, every future change automatically respects it. When it lives only in a meeting discussion, the next sprint forgets it.

*Previous in this series: [Designing a Distributed Scheduler Handling 200K+ Scheduling Operations per Second](/posts/engineering-case-study/designing-a-distributed-scheduler-handling-200k-scheduling-operations-per-second/) — a different company, a different problem: the scheduler built before this platform.*
