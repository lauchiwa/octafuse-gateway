# Octafuse Gateway

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/OctaFuse/octafuse-gateway?sort=semver&display_name=tag&color=2f80ed)](https://github.com/OctaFuse/octafuse-gateway/releases)
[![Package Versions](https://github.com/OctaFuse/octafuse-gateway/actions/workflows/verify-package-versions.yml/badge.svg)](https://github.com/OctaFuse/octafuse-gateway/actions/workflows/verify-package-versions.yml)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](./.nvmrc)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1-F38020?logo=cloudflare&logoColor=white)](./docs/operators/deployment/cloudflare-quickstart.md)
[![Docker](https://img.shields.io/badge/Docker-optional-2496ED?logo=docker&logoColor=white)](./docs/operators/deployment/docker.md)

**Octafuse Gateway** is a self-hostable, open-source AI gateway built for agents. It brings together models from multiple providers, image generation and editing, speech-to-text transcription, Agent Tools, and self-hosted or privately deployed AI services behind a single endpoint. Centralized routing, key management, budgets, usage tracking, and auditing make these resources easier to operate, orchestrate, and govern. More than a model proxy, Octafuse provides a centralized, extensible foundation for discovering, invoking, and managing AI capabilities.

**Languages:** [中文](./README.md) · [English](./README.en.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · **Website:** [octafuse.dev](https://octafuse.dev/en/)

## Core Capabilities

Octafuse Gateway is designed to serve as a **unified AI capability hub for one-person companies (OPCs) and enterprises**. It brings multimodal AI resources and tool capabilities under one entry point with enterprise-grade distribution, billing, and operational control.

Its core capabilities include:

1. Provider onboarding: Connect model vendors and aggregation platforms. A large preset catalog, including Coding / Token Plans, lets you import endpoints with one click and then add the corresponding API key. See the [Providers Catalog](https://octafuse.dev/en/catalog/providers/); PRs for additional preset Providers are welcome.
2. AI model onboarding: Import models from built-in catalog data without manually configuring common parameters and pricing. See the [Models Catalog](https://octafuse.dev/en/catalog/models/); PRs for additional models are welcome.
3. Multi-protocol access:
    - OpenAI endpoints:
      - Chat Completions: `POST /v1/chat/completions`
      - Images: `POST /v1/images/generations`, `POST /v1/images/edits`
      - Audio Transcriptions: `POST /v1/audio/transcriptions`
      - Models: `GET /v1/models`
    - Anthropic endpoint: `POST /v1/messages`
    - Google Gemini endpoint: `POST /v1beta/models/{model}:generateContent` (including `streamGenerateContent`)
4. Agent tool access: Use `/v1/tools/*` to expose tools to agents with centralized logging, billing, and cost control, so models and tools share one Gateway:
    - Web search (`POST /v1/tools/web-search`): Bocha, Tavily, Alibaba Cloud CleverSee, Tencent Cloud WSA
    - Web fetch (`POST /v1/tools/web-fetch`): Firecrawl, Tavily Extract, Jina Reader
    - Deep search (`POST /v1/tools/web-deep-search`, search + read): Firecrawl Search, Jina Search
    - More Agent tools are planned, and contributions are welcome.
5. Unified AI capability endpoint: All connected models, platforms, and tools are exposed through the deployed Octafuse Gateway Base URL, so clients only need to remember one endpoint.
6. Multiple routing strategies: When a model has several upstream resources, choose the strategy that best matches the workload:
    - `hash_affinity`: Default; keeps the same user, model, and protocol on a stable upstream for a **high prompt-cache hit rate** and session continuity, though short-term traffic may be uneven
    - `weighted_random`: Weighted random distribution with **strong load balancing**, suitable for proportional cost allocation or A/B testing; users may switch Providers more often, reducing cache hits
    - `weight_priority`: Deterministic ordering from highest to lowest weight, suitable for explicit primary / backup behavior; the first Provider receives most traffic
    - `weighted_round_robin`: Weighted rotation for more even distribution; counters are maintained per runtime instance and are not globally synchronized across instances
7. Integrated user management and accounting:
    - Three-level External system, User, and API Key hierarchy: the external-system field separates systems or teams, while API Keys authenticate calls and drive charging and auditing
    - Three ledgers: every invocation records catalog price, actual provider cost, and user charge separately
    - Time-of-day multipliers: peak / off-peak pricing improves cost accuracy and enables flexible customer pricing and promotions
8. Admin console and management APIs:
    - Full Admin UI and APIs for manual operation or integration with other portals
    - Observability and analytics for request details, statistics, and operational analysis
    - Playground / Simulator for quickly validating Provider, model, route, and client configurations
9. Flexible deployment:
    - Free deployment on **Cloudflare Workers + D1**
    - Docker deployment with Postgres / MySQL

## How It Differs from Other Open-Source AI Gateways

[New API](https://github.com/QuantumNous/new-api), [LiteLLM](https://github.com/BerriAI/litellm), [Sub2API](https://github.com/Wei-Shaw/sub2api), and [Bifrost](https://github.com/maximhq/bifrost) are mature open-source AI gateways with different strengths. The table below evaluates them through Octafuse's focus on **Agent capability delivery and AI resource operations**, breaking the comparison into onboarding, routing, governance, billing, and deployment.

- **✅ Complete**: The public edition provides a cohesive mechanism covering the main scenarios in this dimension
- **🟡 Strong**: Mature core support, with comparatively narrower coverage or operational depth
- **🟠 Basic**: A usable foundation that still requires substantial external components or custom development
- **⚪ None**: Official public documentation does not list a comparable built-in capability

| Area | Capability dimension | Octafuse Gateway | New API | LiteLLM | Sub2API | Bifrost |
|------|----------------------|------------------|---------|---------|---------|---------|
| Onboarding | Provider / model presets and one-click import | **✅ Complete** | 🟡 Strong | 🟡 Strong | 🟡 Strong | 🟡 Strong |
| Onboarding | Native protocol and multimodal coverage | **🟡 Strong (in progress)** | ✅ Complete | ✅ Complete | ✅ Complete | ✅ Complete |
| Agent | Built-in web search, fetch, and deep search | **✅ Complete** | ⚪ None | 🟠 Basic | 🟠 Basic | 🟠 Basic |
| Agent | Tool Provider configuration, invocation logs, and billing | **✅ Complete** | ⚪ None | 🟡 Strong | 🟠 Basic | 🟠 Basic |
| Routing | Protocol / operation-level Surfaces and independent Route Pools | **✅ Complete** | 🟠 Basic | 🟡 Strong | 🟡 Strong | 🟡 Strong |
| Routing | Multiple distribution strategies and layered overrides | **✅ Complete** | 🟡 Strong | ✅ Complete | 🟡 Strong | 🟡 Strong |
| Routing | Prompt Cache affinity routing | **✅ Complete** | 🟡 Strong | ✅ Complete | ✅ Complete | ✅ Complete |
| Routing | Priority failover and Provider circuit breakers | **✅ Complete** | 🟡 Strong | ✅ Complete | 🟡 Strong | ✅ Complete |
| Governance | External system, user, and API Key hierarchy | **✅ Complete** | 🟡 Strong | ✅ Complete | 🟡 Strong | ✅ Complete |
| Governance | Recurring budgets, status, and model access control | **✅ Complete** | ✅ Complete | ✅ Complete | ✅ Complete | ✅ Complete |
| Billing | Three ledgers: catalog price, provider cost, and user charge | **✅ Complete** | ⚪ None | ⚪ None | ✅ Complete | ⚪ None |
| Billing | Business-timezone time-of-day multipliers | **✅ Complete** | ⚪ None | ⚪ None | 🟡 Strong | ⚪ None |
| Billing | Differentiated image / audio pricing | **✅ Complete** | 🟡 Strong | 🟡 Strong | 🟡 Strong | 🟠 Basic |
| Billing | Per-call Agent tool billing | **✅ Complete** | ⚪ None | 🟡 Strong | 🟠 Basic | 🟠 Basic |
| Operations | Admin console, management APIs, and observability | **✅ Complete** | ✅ Complete | ✅ Complete | ✅ Complete | ✅ Complete |
| Deployment | SQLite / D1, Postgres, and MySQL support | **✅ Complete** | ✅ Complete | 🟠 Basic | 🟠 Basic | 🟡 Strong |
| Deployment | Docker self-hosting | **✅ Complete** | ✅ Complete | ✅ Complete | ✅ Complete | ✅ Complete |
| Deployment | Cloudflare Workers edge deployment | **✅ Complete** | ⚪ None | ⚪ None | ⚪ None | ⚪ None |

Ratings are based on each project's current public repository and official documentation, with emphasis on whether the capability is built in as a cohesive mechanism. Performance, community size, commercial support, and custom-development potential are out of scope. This table reflects Octafuse's product positioning rather than ranking every feature across all projects. Refer to each project's latest official documentation for current capabilities and licensing.

## Quick Start

Requires **Node.js 20+**. Run Proxy and Admin concurrently in **two terminals**.

```bash
git clone https://github.com/OctaFuse/octafuse-gateway.git
cd octafuse-gateway
npm install
npm run db:migrate
```

Terminal 1 — Proxy (`:8787`):

```bash
npm run dev:proxy
```

Terminal 2 — Admin (`:8789`):

```bash
npm run dev:admin
```

| Service | URL | Description |
|---------|-----|-------------|
| Proxy | http://127.0.0.1:8787 | Inference endpoint |
| Admin | http://127.0.0.1:8789 | Console; local default credentials: **`admin` / `admin`** |

The first `dev:admin` run creates `packages/admin/.dev.vars`. Open Admin, configure a Provider, Route, and user API key, then call Proxy with that key. See [docs/users/quickstart.md](./docs/users/quickstart.md) for detailed steps and `curl` examples.

### Deploy to Cloudflare

```bash
npx wrangler login
npm run bootstrap:cloudflare
```

See [Cloudflare quickstart](./docs/operators/deployment/cloudflare-quickstart.md). Change the default Admin password and rotate `MASTER_KEY` before production.

For Docker self-hosting and Postgres / MySQL options, see the [deployment documentation index](./docs/operators/deployment/README.md).

## Documentation

| Task | Link |
|------|------|
| Feature map, Admin setup, client integration | [docs/users/](./docs/users/) |
| Local setup and example requests | [docs/users/quickstart.md](./docs/users/quickstart.md) |
| APIs, integration, local development, architecture | [docs/developers/](./docs/developers/) |
| Cloudflare / Docker / migrations | [docs/operators/](./docs/operators/) |
| Releases and maintenance | [docs/maintainers/](./docs/maintainers/) |
| HTTP examples | [examples/README.md](./examples/README.md) |

## Contributing and Security

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- [SECURITY.md](./SECURITY.md)
- [docs/CONVENTIONS.md](./docs/CONVENTIONS.md)

## License

This repository is licensed under the **GNU Affero General Public License v3.0 (AGPLv3)**. See [LICENSE](./LICENSE).
