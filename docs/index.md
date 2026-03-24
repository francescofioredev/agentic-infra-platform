---
hide:

  - navigation
  - toc
---

# AgentForge Documentation

This is the design documentation for AgentForge, a multi-tenant platform for building and operating LLM-based multi-agent systems. The project is in the design phase — no implementation yet, just architecture decisions and subsystem specs.

> **Design review score**: 62/62 ([see assessment](architecture/10-review-checklist-assessment.md))

---

## How to Read These Docs

The documentation is organized into 22 subsystem specs plus a master architecture decision record. If you're new here, this is a reasonable reading order:

1. **[System Overview](architecture/00-system-overview.md)** — start here. Covers the platform topology, data flows, subsystem dependency map, and technology choices.
2. **[ADR-001](ADR-001-agentic-orchestration-platform.md)** — the master decision record. Every architectural choice is documented here with justifications, trade-offs, and page references to the *Agentic Design Patterns* PDF (482 pages).
3. **[Architecture Diagrams](architecture/24-architecture-diagrams.md)** — 15 Mermaid diagrams covering every layer. Useful as a visual companion while reading the subsystem docs.
4. **[Design Review Assessment](architecture/10-review-checklist-assessment.md)** — a 62-item self-audit against the Agentic Design Patterns checklist.

After that, pick subsystems based on what you care about.

---

## Subsystem Index

### Core (01-09)

These define how agents are created, composed, governed, and monitored.

| # | Subsystem | What it covers |
|---|-----------|---------------|
| 01 | [Agent Builder](architecture/01-agent-builder.md) | Agent creation, versioning, AI-driven prompt optimization |
| 02 | [Team Orchestrator](architecture/02-team-orchestrator.md) | Team composition, orchestration topologies, delegation rules |
| 03 | [Tool & MCP Manager](architecture/03-tool-mcp-manager.md) | Tool registration, MCP server lifecycle, Least Privilege assignment |
| 04 | [Guardrail System](architecture/04-guardrail-system.md) | Six-layer behavioral monitoring and policy enforcement |
| 05 | [Observability Platform](architecture/05-observability-platform.md) | OpenTelemetry tracing, interaction logging, dashboards |
| 06 | [Code Generation Tools](architecture/06-code-generation-tools.md) | Sandboxed code gen/exec for agents |
| 07 | [Prompt Registry](architecture/07-prompt-registry.md) | Version-controlled prompt storage and lifecycle management |
| 08 | [Evaluation Framework](architecture/08-evaluation-framework.md) | Automated quality assessment and regression testing |
| 09 | [Cost & Resource Manager](architecture/09-cost-resource-manager.md) | Token budgets, model tier routing, cost controls |

### Infrastructure (11-16)

The services that agents depend on but don't interact with directly.

| # | Subsystem | What it covers |
|---|-----------|---------------|
| 11 | [Memory & Context Management](architecture/11-memory-context-management.md) | Session/user/app memory scoping, RAG retrieval, context windows |
| 12 | [External Integrations Hub](architecture/12-external-integrations-hub.md) | Connectors to Supabase, Slack, Google Drive, and other external APIs |
| 13 | [IAM & Access Control](architecture/13-iam-access-control.md) | Multi-tenancy, RBAC, API keys, audit logging |
| 14 | [Agent Deployment Pipeline](architecture/14-agent-deployment-pipeline.md) | CI/CD for agents — build, test, evaluate, canary deploy, rollback |
| 15 | [Event Bus](architecture/15-event-bus.md) | NATS JetStream pub/sub, CloudEvents, event replay |
| 16 | [Testing & Simulation](architecture/16-testing-simulation.md) | Simulated users, tool mocking, chaos and red-team testing |

### User-Facing (17-20)

The subsystems that end users and operators interact with.

| # | Subsystem | What it covers |
|---|-----------|---------------|
| 17 | [Conversation & Session Management](architecture/17-conversation-session-management.md) | Multi-channel conversations, agent-to-human handoff |
| 18 | [Replay & Debugging](architecture/18-replay-debugging.md) | Execution replay, time-travel debugging, what-if analysis |
| 19 | [Scheduling & Background Jobs](architecture/19-scheduling-background-jobs.md) | Cron-based and event-triggered agent execution |
| 20 | [Multi-Provider LLM Management](architecture/20-multi-provider-llm-management.md) | Unified LLM interface, failover, cost-based routing |

### Runtime (21-22)

| # | Subsystem | What it covers |
|---|-----------|---------------|
| 21 | [Runtime & Deployment Environment](architecture/21-runtime-deployment-environment.md) | Agent framework, K8s orchestration, process model |
| 22 | [Cost Analysis](architecture/22-cost-analysis.md) | Infrastructure cost estimates and scaling projections |

### Reference (23-24)

| # | Document | What it covers |
|---|----------|---------------|
| 23 | [Open Source Technology Map](architecture/23-open-source-technology-map.md) | All open-source components and their roles |
| 24 | [Architecture Diagrams](architecture/24-architecture-diagrams.md) | 15 Mermaid diagrams covering the full platform |

---

*All pattern references cite the "Agentic Design Patterns" PDF (482 pages). See the [ADR](ADR-001-agentic-orchestration-platform.md) for the complete decision record.*
