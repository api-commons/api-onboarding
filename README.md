# API Onboarding Descriptor (AID)

**Spec home:** [apicommons.org/onboarding](https://apicommons.org/onboarding/) · **Live descriptors:** [apis.io/.well-known/api-onboarding](https://apis.io/.well-known/api-onboarding) · [apievangelist.com/.well-known/api-onboarding](https://apievangelist.com/.well-known/api-onboarding) · **Story:** [What 36 Providers Taught Me About Programmatic API Onboarding](https://apievangelist.com/2026/07/02/what-36-providers-taught-me-about-programmatic-api-onboarding/)

**We standardized the API. We didn't standardize the application.** OpenAPI describes what an API does. OAuth, DCR (RFC 7591), and Client ID Metadata Documents describe the credential handshake. Nothing describes what it takes to *get there* — the account, the plan tier, the terms of service, the verification queue, the provider's private vocabulary for "application," and the console you have to click through before any of the standards apply.

The API Onboarding Descriptor is a machine-readable document, discoverable at `/.well-known/api-onboarding` (and referenced from an [APIs.json](https://apisjson.org) index), that closes that gap. It was derived by induction from working onboarding scripts written against 36 API providers and gateways — not designed in the abstract.

## What it declares

- **maturity** — the honest bucket: `self-serve` (a stranger or their agent walks up, authenticates through a public flow, and leaves with credentials — the SoundCloud bar), `bootstrap-token` (a real management API, but a human mints the first token in a console), or `console-only`.
- **account** — signup, prerequisites, plan gates, ToS, and an `agentPolicy` field: whether the provider actually permits non-human onboarding, or just says they're all-in on AI.
- **verification** — the human-in-the-loop queues between "app created" and "app usable," with expected latency.
- **registration** — the mechanisms that exist (`browser-oauth`, `management-api`, `portal-api`, `dcr`, `cimd`, `console-only`), their endpoints, and what the provider calls an application.
- **authentication** — how you reach the registration surface, and the one-time human `bootstrap` each method still requires. An empty bootstrap is the goal state.
- **credentials** — what you walk away with, mapped from the provider's vocabulary (consumerKey, integration token) to canonical fields (client_id, api_key), with TTL, rotation, and one-time-display flags.
- **scopes** — which of the six-plus authorization models this provider uses (scope strings, API products, permission matrices, capability checkboxes, product tiers, resource selection).
- **flow** — the executable half: ordered HTTP steps with env/arg templating, per-status recovery (409 → read the existing app back), and output mappings, sufficient for a generic engine to run.
- **economics** — pointers to pricing, quotas, and SLAs (the [SLA4OAI](https://github.com/isa-group/SLA4OAI-Specification) graft point).
- **gaps** — an honest list of what still needs a human, so every descriptor doubles as the provider's punch list.

## The proof test

A descriptor is *sufficient* when the generic engine can onboard from metadata alone:

```
node engine/api-onboard.mjs descriptors/<provider>.onboarding.json --name "My Agent App"
```

The engine ([engine/api-onboard.mjs](engine/api-onboard.mjs), Node 18+ stdlib, no npm install) reads a descriptor, reports the requirements and gates, executes the flow, and prints canonical `client_id=` / `client_secret=` / `api_key=` lines plus the credential JSON to stdout — the same contract as the per-provider scripts it replaces. Where the engine can't finish, the descriptor grows a field. That loop is the spec process.

## Repo layout

- [schema/api-onboarding.schema.json](schema/api-onboarding.schema.json) — JSON Schema (2020-12) for the descriptor
- [descriptors/](descriptors/) — descriptors for real providers, retrofitted from the script corpus
- [engine/api-onboard.mjs](engine/api-onboard.mjs) — the generic engine
- [data/](data/) — the extraction dataset from the 36-provider script corpus that the schema was induced from

## Relationship to existing standards

This spec deliberately does **not** reinvent the handshake. Where a provider supports RFC 7591 DCR or CIMD, the descriptor just points at it. Where a provider is an OAuth 2.1 authorization server with RFC 8414 metadata, the descriptor references those endpoints. The descriptor is the layer *around* those standards: discovery of which ones apply, plus the account/plan/ToS/verification reality they all assume away.

## Part of API Commons

A machine-readable building block from **[API Commons](https://apicommons.org)** — open specifications and schemas for the APIs you produce and consume. See all building blocks and tools at **[apicommons.org](https://apicommons.org)** and the tools at **[apicommons.org/tools](https://apicommons.org/tools/)**.

**Related building blocks**
- [api-authorization](https://github.com/api-commons/api-authorization) — the two-tier OAuth 2.1 / FAPI 2.0 profile this descriptor references via `securityProfile`
- [plans](https://github.com/api-commons/plans) — machine-readable API access plans, tiers, and pricing
- [use-cases](https://github.com/api-commons/use-cases) — machine-readable API use-case building blocks
