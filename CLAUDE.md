# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This is a **design documentation repository** for **AgentForge** — an Agentic Orchestration & Monitoring Platform (multi-tenant SaaS). The repo contains architecture decision records (ADRs) and detailed subsystem design documents. There is no code yet.

## Document Structure

```
docs/
├── ADR-001-agentic-orchestration-platform.md   # Master ADR with all pattern decisions
└── architecture/
    ├── 00-system-overview.md     # Platform vision, topology diagram, data flows
    ├── 01–09-*.md                # Core subsystems (Agent Builder, Team Orchestrator, etc.)
    ├── 10-review-checklist-assessment.md        # Design completeness audit
    ├── 11–20-*.md                # Infrastructure subsystems (IAM, Event Bus, LLM Mgmt, etc.)
    └── 21-runtime-deployment-environment.md    # Agent framework, K8s orchestration, process model
```

**Start with `00-system-overview.md`** for the full architecture picture before diving into subsystem docs.

## Architecture Overview

AgentForge is a **Hierarchical Supervisor** multi-agent platform (three levels):
- **Level 0 — Platform Orchestrator**: LLM-based routing (cheap/fast model) to teams
- **Level 1 — Team Supervisors**: Task decomposition, delegation, result aggregation
- **Level 2 — Worker Agents**: Single-responsibility agents with Least Privilege tool access
- **Cross-cutting — Guardrail Agents**: Monitor all levels via `before_tool_callback`

### 20 Subsystems

| Group | Subsystems |
|-------|-----------|
| Core | Agent Builder, Team Orchestrator, Tool & MCP Manager, Guardrail System, Observability Platform, Code Generation Tools, Prompt Registry, Evaluation Framework, Cost & Resource Manager |
| Infrastructure | Memory & Context Mgmt, External Integrations Hub, IAM & Access Control, Agent Deployment Pipeline, Event Bus, Testing & Simulation |
| User-Facing | Conversation & Session Mgmt, Replay & Debugging, Scheduling & Background Jobs, Multi-Provider LLM Management |
| Runtime | **Runtime & Deployment Environment** (agent framework, container orchestration, process model) |

**Foundational services** (no inter-dependencies, started first): Event Bus, Observability, IAM, Multi-Provider LLM.

### Key Architectural Decisions

- **Agent framework**: Google ADK (`LoopAgent`, `LlmAgent`, `AgentTool`, `MCPToolset`) wrapped by an `AgentRuntime` abstraction layer for portability
- **Runtime language**: Python 3.12 + asyncio for all agent services; Go acceptable only for infra sidecars (metrics, edge gateway)
- **Container orchestration**: Kubernetes (EKS/GKE/AKS) with Istio service mesh, Helm charts, Argo Rollouts for canary
- **Agent process model**: Intra-team workers run **in-process** within the Team Supervisor Pod (ADK `AgentTool`, p. 133); inter-team calls use **A2A HTTP** between separate Pods via Istio mTLS
- **MCP server deployment**: STDIO subprocess in dev; standalone stateless K8s Deployment (HTTP+SSE) in production, HPA-scaled
- **Guardrail deployment**: In-process `before_tool_callback` (standard tenants, ~10ms); dedicated Pod (regulated industries, ~100ms)
- **Multi-tenancy isolation**: K8s Namespace per tenant (standard) → dedicated Node Pool (professional) → dedicated cluster (enterprise)
- **Agent communication**: Intra-team via direct function calls / AgentTool; inter-team via A2A HTTP protocol with mTLS + OAuth2
- **Tool protocol**: MCP (STDIO for dev, HTTP+SSE for production); every agent gets only its required tools (Least Privilege)
- **Security model**: Six-layer defense-in-depth (input validation → behavioral constraints → tool restrictions → guardrail agents → external moderation → output filtering) + HITL escalation
- **Prompt lifecycle**: Draft → Review (HITL) → Staged (eval) → Production, with AI-driven Reflection-based optimization loop
- **LLM routing**: Three tiers — Flash/Haiku (simple), Pro/Sonnet (complex), Ultra/Opus (critical)
- **Event bus**: NATS JetStream for at-least-once delivery, consumer groups, replay (CloudEvents spec)
- **Observability**: OpenTelemetry traces with every span capturing routing decisions, tool calls, token usage, guardrail results
- **Deployment**: Six-stage CI/CD pipeline with canary (1%→5%→25%→50%→100%), auto-rollback on >10% metric degradation
- **Memory scoping**: `temp:` (session), `user:` (persistent user), `app:` (platform-wide)

### Agent Identity Contract

Every agent carries: `agent_id`, `version`, `system_prompt_ref` (from Prompt Registry), `input_schema`, `output_schema`, `tools` (MCP URIs), `guardrail_policies`, `model_tier`, `max_iterations`.

### HITL Escalation Triggers

Required human approval for: deploying prompts to production, granting new tool access, executing code outside sandbox, modifying guardrail policies, deleting agent versions, tenant/RBAC changes.

## Design Principles to Apply

When working on this repo:
- All pattern references cite the "Agentic Design Patterns" PDF (482 pages) by page number — preserve these citations
- Sub-agent outputs are always **untrusted** — validation at every boundary is non-negotiable
- Every new subsystem or agent must define: single responsibility, explicit I/O schemas, tool access justification, HITL triggers, and memory scope
- The `agentic-infra` skill is available and grounded in the same PDF — use it for linting ADRs or looking up patterns
