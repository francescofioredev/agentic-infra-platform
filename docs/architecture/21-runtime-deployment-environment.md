# Subsystem 21: Runtime & Deployment Environment

## 1. Purpose

This document resolves the most foundational missing decision in the AgentForge design: **where and how the system actually runs**. It covers three orthogonal dimensions:

1. **Agent Framework** — which execution engine runs the agents
2. **Container Orchestration** — where the services are deployed and scaled
3. **Agent Process Model** — how agents are structured as operating system processes

This subsystem underpins every other subsystem. Without these decisions, no implementation can begin.

---

## 2. The Three Decisions

### 2.1 Decision A — Agent Framework: Google ADK + Thin Abstraction Layer

**Chosen**: Google ADK as execution engine, wrapped by an AgentForge abstraction layer.

**Rationale**:

The "Agentic Design Patterns" PDF uses ADK code examples throughout the relevant patterns:
- `LoopAgent`, `LlmAgent`, `AgentTool` for multi-agent collaboration (p. 133)
- `MCPToolset`, `StdioServerParameters` for MCP tool integration (p. 161)
- `SequentialAgent` with `primary_handler`/`fallback_handler` for exception handling (p. 208)
- `BaseAgent` subclassing for RouterAgent in resource-aware optimization (p. 258)

ADK provides native primitives for **every** pattern in this architecture:

| AgentForge Concept | ADK Primitive |
|-------------------|--------------|
| Level 0 Platform Orchestrator | `LlmAgent` with routing tools |
| Level 1 Team Supervisor | `LoopAgent` with `sub_agents` list |
| Level 2 Worker Agent | `LlmAgent` with `MCPToolset` |
| Intra-team agent calls | `AgentTool(agent=worker)` (p. 133) |
| MCP tool access | `MCPToolset(StdioServerParameters(...))` (p. 161) |
| Fallback on failure | `SequentialAgent([primary, fallback])` (p. 208) |
| Cost-aware routing | `RouterAgent(BaseAgent)` (p. 258) |

**Abstraction layer** (AgentForge's own `AgentRuntime` class) wraps ADK primitives to:
- Shield platform code from ADK API changes
- Allow future migration to LangGraph or custom engine
- Inject platform concerns (tenant context, guardrail callbacks, trace context)

```
┌─────────────────────────────────────────────┐
│           AgentForge Platform               │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │         AgentRuntime (abstraction)    │  │
│  │  - create_agent(spec) -> Agent        │  │
│  │  - execute(agent, input) -> Output    │  │
│  │  - inject_guardrails(callbacks)       │  │
│  │  - inject_trace_context(span)         │  │
│  └───────────────┬───────────────────────┘  │
│                  │ wraps                    │
│  ┌───────────────▼───────────────────────┐  │
│  │         Google ADK Engine             │  │
│  │  LlmAgent / LoopAgent / AgentTool /   │  │
│  │  MCPToolset / SequentialAgent         │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

**Alternatives rejected**:

| Framework | Rejection reason |
|-----------|-----------------|
| LangGraph | Graph-based state model adds complexity where orchestration is already explicit; MCP/A2A not native |
| CrewAI | Too opinionated for a multi-tenant platform; no MCP native support; does not scale to platform-level control |
| Pure Custom | Years of re-implementation; ADK already provides the right primitives |

---

### 2.2 Decision B — Runtime Language: Python 3.11+ (asyncio) for Agents, Go for Infra

**Agent runtime**: Python ≥3.13 with `asyncio`.

- ADK, FastAPI, FastMCP, LiteLLM, OpenTelemetry SDK, all LLM client libraries are Python-first
- All pattern book code examples are Python
- `asyncio` provides non-blocking I/O required for concurrent tool calls and LLM streaming
- Any other language means re-implementing the entire AI/ML client ecosystem

**Infrastructure components** (Go is appropriate):

| Component | Language | Reason |
|-----------|----------|--------|
| Agent Executor (runtime) | Python ≥3.13 | ADK, MCP, LLM clients |
| API Gateway / Control Plane | Python (FastAPI) | Consistency; auto-generated OpenAPI |
| Event Bus consumer workers | Python (asyncio) | NATS JetStream Python client |
| MCP Servers | Python (FastMCP) | Native FastMCP framework |
| Metrics sidecar | Go | High-throughput, low-latency scraping |
| API Gateway (edge) | Go or Nginx | Connection handling performance |

**Python version policy**:
- Minimum: Python 3.13 (released Oct 2024; ~16 months of ecosystem adoption; free-threaded mode experimental; improved `asyncio` error reporting)
- Target: Python 3.14 once ADK and core dependencies confirm compatibility (released Oct 2025; evaluate Q2 2026)
- Never pin to a patch version in `pyproject.toml` — use `python = ">=3.13"`
- Dependency management: `uv` (fast resolver) + `pyproject.toml`
- Type safety: `mypy` strict mode on all platform services

---

### 2.3 Decision C — Container Orchestration: Kubernetes

**Chosen**: Kubernetes (K8s) with Helm charts for all platform services.

**Rejection of alternatives**:

| Alternative | Why rejected |
|-------------|--------------|
| AWS ECS/Fargate | No Namespace-level isolation for multi-tenancy; limited NetworkPolicy for mTLS; less portable |
| Cloud Run | Cold starts incompatible with long-running agents; no persistent MCP STDIO connections; P95 <5s SLA not achievable |
| AWS Lambda | Same cold start problem; 15-min max execution for long-running agent loops |
| Bare VMs | No HPA; no rolling deployments; no service discovery; manual scaling |

**K8s features used by AgentForge**:

| K8s Feature | AgentForge Usage |
|-------------|-----------------|
| **Namespaces** | One namespace per tenant (logical isolation) |
| **ResourceQuota** | CPU/memory limits per tenant namespace |
| **NetworkPolicy** | Restrict pod-to-pod traffic; enforce A2A mTLS paths |
| **HPA** | Scale Team Supervisor pods on CPU + custom agent queue depth metric |
| **Deployments + RollingUpdate** | 6-stage CI/CD pipeline with zero-downtime deploys |
| **Jobs** | One-shot evaluation runs, batch replay, chaos test execution |
| **CronJobs** | Scheduled agent execution (Scheduling subsystem) |
| **ConfigMaps / Secrets** | Agent configurations, API keys (Vault-backed via External Secrets Operator) |
| **Service Mesh (Istio)** | mTLS between A2A services, traffic policies for canary splitting |
| **Ingress** | External-facing API and WebSocket endpoints |

**Multi-tenancy isolation tiers**:

```
Tier 1 (Standard):    Shared nodes, separate Namespaces, ResourceQuotas, NetworkPolicy
Tier 2 (Professional): Dedicated Node Pool per tenant, Namespace isolation
Tier 3 (Enterprise):  Dedicated K8s cluster per tenant (cluster-per-tenant)
```

---

## 3. Agent Process Model

This is the most architecturally critical decision — how agents map to OS processes and K8s Pods.

### 3.1 Process Topology

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Kubernetes Cluster                                  │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  Namespace: agentforge-platform (control plane)                         │ │
│  │                                                                         │ │
│  │  ┌──────────────────────┐   ┌──────────────────────────────────────┐   │ │
│  │  │ Platform Orchestrator │   │ API Gateway (FastAPI)                 │   │ │
│  │  │ Deployment (2 pods)  │   │ Deployment (3 pods, HPA)             │   │ │
│  │  │ Python / ADK LlmAgent│   │ Handles REST, WebSocket, SSE         │   │ │
│  │  └──────────────────────┘   └──────────────────────────────────────┘   │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  Namespace: tenant-{id} (one per tenant)                                │ │
│  │                                                                         │ │
│  │  ┌────────────────────────────────────────────────────────┐             │ │
│  │  │ Team-Alpha Pod (Team Supervisor + Workers in-process)   │             │ │
│  │  │                                                         │             │ │
│  │  │  ┌───────────────────────────────────────────────────┐  │             │ │
│  │  │  │  Team Supervisor (ADK LoopAgent)                  │  │             │ │
│  │  │  │  ├── Worker A1 (LlmAgent + MCPToolset) [in-proc] │  │             │ │
│  │  │  │  ├── Worker A2 (LlmAgent + MCPToolset) [in-proc] │  │             │ │
│  │  │  │  └── Worker A3 (LlmAgent + MCPToolset) [in-proc] │  │             │ │
│  │  │  └───────────────────────────────────────────────────┘  │             │ │
│  │  └────────────────────────────────────────────────────────┘             │ │
│  │                                                                         │ │
│  │  ┌─────────────────────────────────────────┐  ┌──────────────────────┐  │ │
│  │  │ Guardrail Agent Pod                     │  │ MCP Server Pods      │  │ │
│  │  │ (sidecar or dedicated Deployment)        │  │ (1 per tool category)│  │ │
│  │  │ Monitors via before_tool_callback        │  │ FastMCP, stateless   │  │ │
│  │  └─────────────────────────────────────────┘  └──────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Intra-team vs. Inter-team Communication

This is the key split defined by the pattern book (p. 133 vs. p. 240):

**Intra-team (Level 1 → Level 2)**: Direct function calls via ADK `AgentTool`

```python
# All in the SAME Python process / SAME K8s Pod
worker_a1 = LlmAgent(name="researcher", tools=[MCPToolset(...)])
worker_a2 = LlmAgent(name="writer", tools=[MCPToolset(...)])

supervisor = LoopAgent(
    name="team_alpha_supervisor",
    sub_agents=[
        worker_a1,
        LlmAgent(name="writer", tools=[AgentTool(agent=worker_a1)])
    ],
    max_iterations=10,
)
```

- No serialization, no network overhead
- Shared Python process memory for intermediate results
- Sub-agent outputs validated in-process before Supervisor acts on them (p. 126)

**Inter-team (Level 0 → Level 1)**: A2A HTTP between separate Pods

```
Platform Orchestrator Pod  →  A2A HTTP (mTLS + OAuth2)  →  Team-Alpha Pod
                               POST /a2a/tasks
                               GET  /a2a/tasks/{id}      (polling)
                               or WebSocket              (streaming)
```

- Each Team Pod exposes `/.well-known/agent.json` (Agent Card, p. 243)
- Istio service mesh handles mTLS certificate lifecycle
- Task IDs are UUID v4 for idempotent retry safety (p. 246)

### 3.3 MCP Server Deployment Model

MCP servers run as **separate stateless K8s Deployments**, not as STDIO subprocesses in production:

```
Development:   Team Pod spawns MCP server as STDIO subprocess (p. 160)
               Fast iteration, no network overhead

Production:    MCP server runs as standalone K8s Deployment (HTTP+SSE transport, p. 160)
               Team Pod connects via MCPToolset(SseServerParameters(url="http://mcp-search:8080"))
               Stateless → HPA enabled
               Shared across multiple Team Pods (one MCP server for search tools, etc.)
```

**MCP server categories and deployment**:

| MCP Server | Tools Exposed | K8s Deployment |
|------------|--------------|----------------|
| `mcp-search` | `web_search`, `scholar_search`, `news_search` | Shared, HPA 2-10 pods |
| `mcp-code` | `code_executor` (gVisor sandboxed), `linter`, `test_runner` | Sandboxed namespace, strict NetworkPolicy |
| `mcp-data` | `db_query`, `csv_parse`, `data_transform` | Per-tenant (data isolation) |
| `mcp-comms` | `send_email`, `post_slack`, `create_ticket` | Shared, rate-limited |
| `mcp-storage` | `read_file`, `write_file`, `list_bucket` | Per-tenant (storage isolation) |

### 3.4 Guardrail Agent Deployment Model

Guardrail Agents use `before_tool_callback` (p. 295), which executes **synchronously before every tool call**. Two deployment options:

**Option A — In-process sidecar** (recommended for P95 <500ms guardrail SLA):
```
Guardrail Agent runs in the SAME Pod as the Team Supervisor
before_tool_callback is a Python function call, not an HTTP call
Latency: ~10-50ms (local function + LLM call)
```

**Option B — Dedicated Pod** (for compliance isolation requirements):
```
Guardrail Agent runs as a separate K8s Deployment
before_tool_callback makes an HTTP call to guardrail service
Latency: ~50-150ms (network + LLM call)
```

For standard tenants: Option A. For regulated industries (finance, healthcare): Option B.

---

## 4. Full Deployment Architecture

```
                    ┌──────────────────────────────────────┐
                    │         Cloud Provider               │
                    │  (AWS EKS / GKE / Azure AKS)        │
                    └──────────────────┬───────────────────┘
                                       │
                    ┌──────────────────▼───────────────────┐
                    │           Ingress / API Gateway       │
                    │    (Nginx Ingress or Istio Gateway)  │
                    │    REST / WebSocket / SSE             │
                    └──────────────────┬───────────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          │                            │                            │
          ▼                            ▼                            ▼
┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
│ Platform Control│          │ NATS JetStream  │          │ Observability   │
│ Plane Namespace │          │ Cluster         │          │ Stack           │
│                 │          │ (Event Bus)     │          │                 │
│ - API Gateway   │          │                 │          │ - Prometheus    │
│ - Orchestrator  │          │                 │          │ - Jaeger/Tempo  │
│ - IAM service   │          │                 │          │ - Grafana       │
│ - LLM Gateway   │          │                 │          │ - Loki          │
│ - Prompt Reg.   │          │                 │          │                 │
└────────┬────────┘          └─────────────────┘          └─────────────────┘
         │
         │  A2A HTTP (mTLS via Istio)
         │
┌────────▼────────────────────────────────────────────────┐
│  Tenant Namespaces (one per tenant)                     │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Team-Alpha   │  │ Team-Beta    │  │ Team-Gamma   │  │
│  │ Deployment   │  │ Deployment   │  │ Deployment   │  │
│  │ (HPA 1-10)   │  │ (HPA 1-10)   │  │ (HPA 1-10)   │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ mcp-search   │  │ mcp-code     │  │ mcp-data     │  │
│  │ (HPA 2-10)   │  │ (sandboxed)  │  │ (per-tenant) │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
         │
┌────────▼────────────────────────────────────────────────┐
│  Shared Data Layer                                      │
│  PostgreSQL (RDS/CloudSQL)   Redis Cluster              │
│  pgvector (RAG)              ClickHouse (time-series)   │
│  HashiCorp Vault             Object Store (S3/GCS)      │
└─────────────────────────────────────────────────────────┘
```

---

## 5. Scaling Model

### 5.1 Horizontal Pod Autoscaler Rules

| Component | Scale Metric | Min | Max | Scale-up trigger |
|-----------|-------------|-----|-----|-----------------|
| API Gateway | CPU + RPS | 2 | 20 | >70% CPU or >500 RPS/pod |
| Platform Orchestrator | CPU + queue depth | 2 | 10 | >60% CPU or >100 pending requests |
| Team Supervisor | Agent execution queue depth | 1 | 10 | >5 queued tasks per pod |
| MCP Search | CPU + request latency | 2 | 20 | >80% CPU or P95 >500ms |
| MCP Code (sandboxed) | CPU (conservative) | 2 | 8 | >50% CPU (safety margin for sandbox) |
| LLM Gateway | Request queue depth | 2 | 15 | >50 queued LLM requests |

### 5.2 Concurrency Model

Within a Team Supervisor Pod, ADK uses Python `asyncio` for concurrency:

```python
# Parallel worker execution within a team (Parallelization pattern, p. 41)
import asyncio

async def execute_team_task(task: Task) -> TeamResult:
    # Decompose task into parallel subtasks
    subtasks = supervisor.decompose(task)

    # Execute workers concurrently (within same process, non-blocking)
    results = await asyncio.gather(
        *[worker.execute(subtask) for worker, subtask in zip(workers, subtasks)],
        return_exceptions=True  # Don't let one failure cancel others
    )

    return supervisor.aggregate(results)
```

This provides concurrent agent execution without thread overhead, aligned with the Parallelization pattern (p. 41).

### 5.3 Resource Limits

| Component | CPU Request | CPU Limit | Memory Request | Memory Limit |
|-----------|------------|-----------|---------------|-------------|
| Team Supervisor Pod | 0.5 CPU | 2 CPU | 512Mi | 2Gi |
| MCP Server Pod | 0.25 CPU | 1 CPU | 256Mi | 512Mi |
| Platform Orchestrator | 0.5 CPU | 2 CPU | 512Mi | 1Gi |
| Guardrail Agent | 0.25 CPU | 1 CPU | 256Mi | 512Mi |

*Note: LLM API calls are I/O bound; CPU limits are for computation (parsing, validation, embedding), not LLM inference.*

---

## 6. Development vs. Production Topology

| Concern | Development | Production |
|---------|------------|------------|
| Agent framework | ADK, same | ADK, same |
| MCP transport | STDIO (subprocess) | HTTP+SSE (separate K8s Deployment) |
| Orchestration | Docker Compose | Kubernetes (EKS/GKE/AKS) |
| Service mesh | None | Istio (mTLS, traffic management) |
| LLM calls | Real APIs with local .env | LLM Gateway with key pools + Vault |
| Observability | Local Jaeger + Prometheus | Full Grafana Cloud or self-hosted |
| NATS | Single docker container | NATS JetStream cluster (3 nodes) |
| PostgreSQL | Local docker | RDS/CloudSQL with replicas |

---

## 7. CI/CD for Platform Services

The Agent Deployment Pipeline (subsystem 14) handles agent CI/CD. Platform service CI/CD (the infrastructure itself) uses a separate pipeline:

```
Code commit
    │
    ▼
Unit tests (pytest, pytest-asyncio)
    │
    ▼
Build Docker image (multi-stage, python:3.12-slim)
    │
    ▼
Push to registry (ECR/GCR/GHCR)
    │
    ▼
Helm chart lint + dry-run
    │
    ▼
Deploy to staging namespace
    │
    ▼
Integration tests (real K8s, mock LLMs)
    │
    ▼
Canary deploy (1% → 25% → 100%) via Argo Rollouts
    │
    ▼
Production
```

---

## 8. Key Configuration Artifacts

### Dockerfile (Python agent service)

```dockerfile
FROM python:3.12-slim AS builder
WORKDIR /app
COPY pyproject.toml .
RUN pip install uv && uv sync --no-dev

FROM python:3.12-slim
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY src/ ./src/
ENV PATH="/app/.venv/bin:$PATH"
# Non-root user for security
RUN adduser --disabled-password --gecos '' appuser
USER appuser
ENTRYPOINT ["python", "-m", "agentforge.team_supervisor"]
```

### Helm chart structure

```
helm/agentforge/
├── Chart.yaml
├── values.yaml               # Default values
├── values-staging.yaml       # Staging overrides
├── values-production.yaml    # Production overrides
└── templates/
    ├── team-supervisor/
    │   ├── deployment.yaml   # HPA-enabled Deployment
    │   ├── hpa.yaml          # HorizontalPodAutoscaler
    │   ├── service.yaml      # ClusterIP service for A2A
    │   └── networkpolicy.yaml
    ├── mcp-server/
    │   └── ...
    └── platform-orchestrator/
        └── ...
```

---

## 9. Dependencies

| Subsystem | Dependency on Runtime Environment |
|-----------|----------------------------------|
| Team Orchestrator (02) | ADK LoopAgent / LlmAgent in Team Supervisor Pod |
| Tool & MCP Manager (03) | MCP Server Pods with HTTP+SSE transport |
| Guardrail System (04) | In-process before_tool_callback or dedicated Pod |
| Agent Deployment Pipeline (14) | Argo Rollouts for canary; Helm for manifest management |
| Event Bus (15) | NATS JetStream cluster on K8s |
| IAM (13) | Istio + OPA sidecar for request-level policy enforcement |
| Observability (05) | OpenTelemetry collector DaemonSet on every node |
| Memory (11) | Redis cluster + PostgreSQL + pgvector on K8s or managed |

---

## 10. Open Questions

1. **Managed K8s provider**: AWS EKS vs. GKE vs. Azure AKS — choice depends on existing cloud commitment. All are equivalent for this design.
2. **Istio vs. Linkerd**: Istio is heavier but has richer traffic management for canary splitting. Linkerd is lighter. Given the canary deployment requirements, Istio is preferred.
3. **ADK version lock**: ADK is evolving rapidly (Google). The abstraction layer (`AgentRuntime`) must be maintained as ADK APIs change.
4. **WASM for MCP sandboxing**: An alternative to gVisor for code execution sandboxes — investigate Wasmtime as a lighter isolation boundary than full container sandboxes.
5. **Multi-region**: This design covers single-region. Active-active multi-region deployment for global SaaS requires additional decisions (data replication strategy, cross-region A2A routing).

---

*Related documents: 02-team-orchestrator.md, 03-tool-mcp-manager.md, 04-guardrail-system.md, 14-agent-deployment-pipeline.md, 15-event-bus.md*
