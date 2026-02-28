# Cost Analysis — AgentForge Infrastructure

**Date**: 2026-02-28
**Scope**: Infrastructure and LLM API cost estimates for three representative agentic system configurations.

---

## 1. Assumptions & Methodology

### 1.1 The Three Scenarios

| Scenario | Structure | Distinct Agents | K8s Pods (team level) |
|----------|-----------|----------------|-----------------------|
| **S1** | Platform Orchestrator + 1 Team Supervisor + 4 Worker Agents | 5 | 1 Team Pod |
| **S2** | Platform Orchestrator + 3 Team Supervisors + 12 Worker Agents | 13 | 3 Team Pods |
| **S3** | Platform Orchestrator + 5 Team Supervisors + 25 Worker Agents | 31 | 5 Team Pods |

**S3 topology detail**: 5 Level-1 Team Supervisors, each with 5 in-process Worker Agents — total 30 distinct agents + 1 Platform Orchestrator. Per task, the Orchestrator routes to 1–5 teams depending on complexity.

```
S1                    S2                         S3
                                                 Level 0
Orchestrator    Orchestrator               Orchestrator (L0)
     │               │                          │
  Team-α         ┌───┼───┐          ┌─────┬─────┼─────┬─────┐
  │ │ │ │       α   β   γ          α     β     γ     δ     ε
 W1 W2 W3 W4   ││  ││  ││        ││    ││    ││    ││    ││
               (4W)(4W)(4W)      (5W) (5W) (5W) (5W) (5W)
```

### 1.2 Agent Process Model (from subsystem 21)

- **Workers run in-process** inside their Team Supervisor Pod (ADK `AgentTool`, p. 133) — no per-worker Pod overhead
- **MCP servers** are separate stateless K8s Deployments shared across teams
- **Guardrail agents** run in-process via `before_tool_callback` (standard tier)

### 1.3 LLM Pricing Baseline

Prices approximate for February 2026 (Claude-family reference). Exact prices vary by provider and may be lower due to competition.

| Tier | Model example | Input ($/1M tokens) | Output ($/1M tokens) |
|------|--------------|--------------------|--------------------|
| **Haiku** | Claude Haiku | $0.80 | $4.00 |
| **Sonnet** | Claude Sonnet | $3.00 | $15.00 |
| **Opus** | Claude Opus | $15.00 | $75.00 |

**Average tokens per LLM call** (system prompt + context + output):
- Input: ~3,000 tokens (system prompt, task context, tool results)
- Output: ~800 tokens (reasoning + response or tool call)

**Cost per LLM call by tier**:
- Haiku: 3,000 × $0.80/1M + 800 × $4/1M = $0.0024 + $0.0032 = **$0.006**
- Sonnet: 3,000 × $3/1M + 800 × $15/1M = $0.009 + $0.012 = **$0.021**
- Opus: 3,000 × $15/1M + 800 × $75/1M = $0.045 + $0.060 = **$0.105**

**Model distribution per agent role** (from LLM routing tier decisions, p. 257–258):

| Agent role | Haiku | Sonnet | Opus | Blended cost/call |
|-----------|-------|--------|------|------------------|
| Orchestrator | 100% | — | — | $0.006 |
| Supervisor | 20% | 70% | 10% | $0.026 |
| Worker | 50% | 40% | 10% | $0.022 |

**Calls per task** (one user request end-to-end):

| Agent | Calls | Reason |
|-------|-------|--------|
| Orchestrator | 1 | Single routing decision (p. 258) |
| Supervisor | 3 | Plan + coordinate + aggregate |
| Worker | 2 avg | Reason/think + act/respond |

### 1.4 Infrastructure Pricing Baseline

AWS us-east-1, on-demand pricing (approximately Feb 2026):

| Instance | vCPU | RAM | $/hr | $/month |
|----------|------|-----|------|---------|
| m7i.xlarge | 4 | 16 GB | $0.21 | $151 |
| m7i.2xlarge | 8 | 32 GB | $0.42 | $302 |
| EKS control plane | — | — | — | $73 |

### 1.5 Representative Workload per Scenario

| Scenario | Tasks/day | Tasks/month | Rationale |
|----------|-----------|-------------|-----------|
| S1 | 200 | 6,000 | Pilot / internal tool |
| S2 | 1,000 | 30,000 | Mid-size business application |
| S3 | 3,000 | 90,000 | Enterprise / SaaS production |

---

## 2. LLM Cost Model — Per-Task Breakdown

### 2.1 S1: 1 Team, 4 Workers

```
One task path:
  Orchestrator (1 call)  →  Team-α Supervisor (3 calls)  →  4 Workers × 2 calls each
```

| Component | Calls | Cost/call | Subtotal |
|-----------|-------|-----------|---------|
| Orchestrator | 1 | $0.006 | $0.006 |
| Supervisor | 3 | $0.026 | $0.078 |
| Workers (×4) | 2 each = 8 total | $0.022 | $0.176 |
| **LLM total** | | | **$0.260** |

> Workers dominate: 68% of the per-task LLM spend. This ratio holds at every scale.

### 2.2 S2: 3 Teams, 4 Workers Each

Per task the Orchestrator routes to **one active team**. The other two teams are idle (no LLM cost for idle teams — they incur only the fixed K8s compute cost).

| Component | Calls | Cost/call | Subtotal |
|-----------|-------|-----------|---------|
| Orchestrator | 1 | $0.006 | $0.006 |
| 1 active Supervisor | 3 | $0.026 | $0.078 |
| 4 active Workers | 8 total | $0.022 | $0.176 |
| **LLM total** | | | **$0.260** |

Per-task LLM cost is **identical to S1**. The cost difference vs S1 is purely in fixed infrastructure (more K8s pods always running).

Concurrent tasks hitting different teams add costs independently:
- 3 simultaneous tasks (one per team): 3 × $0.260 = $0.780

### 2.3 S3: 5 Teams, 30 Agents

For S3, per-task cost varies significantly depending on **how many teams a request engages**.

**Case A — Simple task (routes to 1 team, 5 workers):**

| Component | Calls | Cost/call | Subtotal |
|-----------|-------|-----------|---------|
| Orchestrator | 1 | $0.006 | $0.006 |
| 1 Supervisor | 3 | $0.026 | $0.078 |
| 5 Workers | 10 total | $0.022 | $0.220 |
| **Total** | | | **$0.304** |

**Case B — Complex task (2 teams collaborate):**

| Component | Calls | Cost/call | Subtotal |
|-----------|-------|-----------|---------|
| Orchestrator | 1 | $0.006 | $0.006 |
| 2 Supervisors | 6 total | $0.026 | $0.156 |
| 10 Workers | 20 total | $0.022 | $0.440 |
| **Total** | | | **$0.602** |

**Case C — Full system task (all 5 teams):**

| Component | Calls | Cost/call | Subtotal |
|-----------|-------|-----------|---------|
| Orchestrator | 1 | $0.006 | $0.006 |
| 5 Supervisors | 15 total | $0.026 | $0.390 |
| 25 Workers | 50 total | $0.022 | $1.100 |
| **Total** | | | **$1.496** |

**Weighted average** (assumed task mix: 60% simple, 30% two-team, 10% full-system):

```
0.60 × $0.304 + 0.30 × $0.602 + 0.10 × $1.496
= $0.182 + $0.181 + $0.150
= $0.513/task (representative average)
```

---

## 3. Infrastructure Cost Model

### 3.1 S1 — 1 Team, 4 Agents

**K8s cluster** (4 nodes):

| Node | Contents | Instance | $/month |
|------|----------|----------|---------|
| Node 1 | Platform Orchestrator + API Gateway | m7i.xlarge | $151 |
| Node 2 | Team-α Pod (Supervisor + 4 Workers in-process) | m7i.xlarge | $151 |
| Node 3 | MCP servers (mcp-search + mcp-tools) | m7i.xlarge | $151 |
| Node 4 | NATS JetStream + Redis | m7i.xlarge | $151 |
| EKS control plane | — | — | $73 |
| **K8s subtotal** | | | **$677** |

**Managed services:**

| Service | Spec | $/month |
|---------|------|---------|
| RDS PostgreSQL | t3.medium + 100 GB storage | $51 |
| ElastiCache Redis | t3.medium | $35 |
| S3 (snapshots + logs) | ~200 GB | $15 |
| Observability (Grafana Cloud Starter) | — | $30 |
| **Managed subtotal** | | **$131** |

**S1 total infrastructure: $677 + $131 = $808/month**

### 3.2 S2 — 3 Teams, 4 Agents Each

**K8s cluster** (6 nodes):

| Node | Contents | Instance | $/month |
|------|----------|----------|---------|
| Node 1 | Platform Orchestrator + API Gateway | m7i.xlarge | $151 |
| Node 2 | Team-α Pod | m7i.xlarge | $151 |
| Node 3 | Team-β Pod | m7i.xlarge | $151 |
| Node 4 | Team-γ Pod | m7i.xlarge | $151 |
| Node 5 | MCP servers (shared, 3+ services) | m7i.xlarge | $151 |
| Node 6 | NATS cluster node 1 + Redis | m7i.xlarge | $151 |
| EKS control plane | — | — | $73 |
| **K8s subtotal** | | | **$979** |

**Managed services:**

| Service | Spec | $/month |
|---------|------|---------|
| RDS PostgreSQL | t3.large + 200 GB | $102 |
| ElastiCache Redis | t3.large | $65 |
| ClickHouse (managed) | interaction logging | $100 |
| S3 | ~500 GB | $30 |
| Observability (Grafana Cloud Pro) | — | $50 |
| **Managed subtotal** | | **$347** |

**S2 total infrastructure: $979 + $347 = $1,326/month** ≈ **$1,330/month**

### 3.3 S3 — 5 Teams, 30 Agents

Each Team Pod now runs **5 in-process workers** — heavier memory footprint → m7i.2xlarge for team nodes.

**K8s cluster** (12 nodes):

| Node | Contents | Instance | Qty | $/month |
|------|----------|----------|-----|---------|
| Nodes 1–2 | Platform Orchestrator + API Gateway (HA) | m7i.xlarge | 2 | $302 |
| Nodes 3–7 | Team Pods α–ε (5 workers each, in-process) | m7i.2xlarge | 5 | $1,510 |
| Nodes 8–9 | MCP servers (shared, HPA-scaled) | m7i.xlarge | 2 | $302 |
| Nodes 10–12 | NATS JetStream cluster (3-node HA) | m7i.xlarge | 3 | $453 |
| EKS control plane | — | — | — | $73 |
| **K8s subtotal** | | | | **$2,640** |

**Managed services:**

| Service | Spec | $/month |
|---------|------|---------|
| RDS PostgreSQL | r6g.large + 1 read replica + 500 GB | $250 |
| ElastiCache Redis | r6g.large cluster mode | $170 |
| ClickHouse (managed, high-volume) | agent traces + interaction logs | $300 |
| Qdrant (vector store for RAG) | dedicated instance | $100 |
| S3 (replay snapshots + model artifacts) | ~2 TB | $80 |
| Observability (Grafana Cloud Professional) | metrics + traces + logs | $200 |
| HashiCorp Vault Cloud | secret management | $50 |
| **Managed subtotal** | | **$1,150** |

**S3 total infrastructure: $2,640 + $1,150 = $3,790/month** ≈ **$3,800/month**

---

## 4. Total Monthly Cost Summary

### 4.1 At Representative Workloads

| | S1 (200 tasks/day) | S2 (1,000 tasks/day) | S3 (3,000 tasks/day) |
|---|---|---|---|
| LLM API | $1,560 | $7,800 | $46,170 |
| K8s compute | $677 | $979 | $2,640 |
| Managed services | $131 | $347 | $1,150 |
| **Total/month** | **$2,368** | **$9,126** | **$49,960** |
| **Cost/task** | **$0.39** | **$0.30** | **$0.56** |
| LLM % of total | 66% | 85% | 92% |

> **Key insight**: LLM API costs are the dominant cost driver at every scale. At S3 volumes, infrastructure is only 8% of total spend. Optimizing LLM usage has 10× the ROI of optimizing K8s sizing.

### 4.2 Cost at Multiple Workload Levels

Each scenario at Low / Medium / High throughput:

**S1 (1 team, 4 agents)** — $808/month fixed infra:

| Throughput | Tasks/month | LLM cost | Total | Cost/task |
|-----------|-------------|----------|-------|-----------|
| Low | 1,500 | $390 | **$1,198** | $0.80 |
| Medium *(baseline)* | 6,000 | $1,560 | **$2,368** | $0.39 |
| High | 30,000 | $7,800 | **$8,608** | $0.29 |

**S2 (3 teams, 4 agents each)** — $1,330/month fixed infra:

| Throughput | Tasks/month | LLM cost | Total | Cost/task |
|-----------|-------------|----------|-------|-----------|
| Low | 5,000 | $1,300 | **$2,630** | $0.53 |
| Medium *(baseline)* | 30,000 | $7,800 | **$9,130** | $0.30 |
| High | 100,000 | $26,000 | **$27,330** | $0.27 |

**S3 (5 teams, 30 agents)** — $3,800/month fixed infra:

| Throughput | Tasks/month | LLM cost | Total | Cost/task |
|-----------|-------------|----------|-------|-----------|
| Low | 10,000 | $5,130 | **$8,930** | $0.89 |
| Medium *(baseline)* | 90,000 | $46,170 | **$49,970** | $0.56 |
| High | 300,000 | $153,900 | **$157,700** | $0.53 |

---

## 5. Cost Optimization Levers

Ranked by impact on S3 at medium workload ($49,970/month baseline):

### Lever 1 — Semantic Caching (Redis, 30% hit rate)

30% of tasks served from the semantic cache (p. 264) without LLM calls.

```
Monthly savings = LLM base × cache hit rate
S3: $46,170 × 0.30 = $13,851/month saved
New S3 total: ~$36,120/month (−28%)
```

**Effort**: Medium. Requires embedding-based cache lookup in LLM Gateway subsystem (20-multi-provider-llm-management.md).

### Lever 2 — Prompt Caching (Anthropic-native, ~90% discount on cached tokens)

System prompts (~1,500 of the 3,000 input tokens per call) can be cached by the API. Cached tokens cost ~90% less.

```
Cached input savings = 1,500 tokens × $0.80/1M × 0.90 × total_calls
At S3 medium (90,000 tasks, avg 20 LLM calls/task = 1.8M calls):
1,500 × 0.90 × 1,800,000 / 1,000,000 × $0.80 = $1,944/month
Approximate: ~4% overall LLM reduction (~$1,900/month)
```

**Effort**: Low. Requires adding `cache_control` to system prompt blocks in ADK.

### Lever 3 — Worker Model Downgrade (Haiku-first strategy)

Default worker tier flipped to 80% Haiku / 18% Sonnet / 2% Opus (from 50/40/10).

```
Worker blended cost: 0.80×$0.006 + 0.18×$0.021 + 0.02×$0.105 = $0.011  (was $0.022)
50% reduction in worker LLM cost
Workers ≈ 80% of total LLM spend at S3
S3 savings: $46,170 × 0.80 × 0.50 = $18,468/month
New S3 total: ~$31,500/month (−37%)
```

**Risk**: Quality degradation on complex tasks. Requires Critique-then-escalate pattern (p. 259) to automatically upclass when output quality is insufficient. Maintain per-agent quality metrics in Evaluation Framework.

### Lever 4 — Reserved Instances (1-year commitment, ~30% K8s discount)

```
S3 K8s compute: $2,640/month on-demand
With 1-year RI: $2,640 × 0.70 = $1,848/month
Savings: $792/month (~1.6% of total — low impact)
```

**Effort**: Zero (billing change). Do after architecture is stable.

### Lever 5 — Spot Instances for Batch Workloads (~70% compute discount)

Batch jobs (evaluation runs, chaos tests, replay analysis) can run on Spot nodes.

```
~20% of S3 compute is batch-compatible
$2,640 × 0.20 × 0.70 = $369/month savings
```

**Effort**: Medium. Requires Spot-aware K8s node pool configuration + graceful pod interruption handling.

### Combined Optimization Potential (S3)

| Scenario | Monthly cost | vs. Baseline |
|----------|-------------|-------------|
| Baseline | $49,970 | — |
| + Semantic cache (30%) | $36,120 | −28% |
| + Prompt caching | $34,220 | −31% |
| + Model downgrade (workers) | $15,752 | −68% |
| + Reserved Instances | $14,960 | −70% |
| **Fully optimized** | **~$15,000** | **−70%** |

> Warning: the "fully optimized" scenario applies all levers simultaneously, which requires tuning (model downgrade + cache together). Realistic target is **−40 to −50%** without quality risk.

---

## 6. Break-Even Analysis for SaaS Monetization

If AgentForge is offered as a multi-tenant SaaS and tasks are billed to tenants:

**S3 at medium workload (90,000 tasks/month = $49,970 cost):**

| Price per task | Monthly revenue | Gross margin | Viable? |
|---------------|----------------|-------------|---------|
| $0.25 | $22,500 | −$27,470 | No |
| $0.50 | $45,000 | −$4,970 | No |
| $0.60 | $54,000 | +$4,030 (8%) | Barely |
| $1.00 | $90,000 | +$40,030 (44%) | Yes |
| $2.00 | $180,000 | +$130,030 (72%) | Strong |

**S3 optimized ($15,000/month at same volume):**

| Price per task | Monthly revenue | Gross margin |
|---------------|----------------|-------------|
| $0.25 | $22,500 | +$7,500 (33%) |
| $0.50 | $45,000 | +$30,000 (67%) |
| $1.00 | $90,000 | +$75,000 (83%) |

> Cost optimization is a prerequisite for SaaS viability at sub-$1/task pricing. At unoptimized costs, minimum viable price is ~$0.60/task.

---

## 7. Cost Cliff: When to Move Between Scenarios

Infrastructure does not scale linearly. There are two cost cliffs where adding capacity triggers a significant fixed-cost jump:

```
Monthly cost
│
$50K ┤                                              ╭──────── S3 grows
     │                                         ╭───╯
$10K ┤                             ╭───────────╯  ← S2→S3 cliff (+$2,500 infra)
     │                    ╭────────╯
$2K  ┤           ╭────────╯  ← S1→S2 cliff (+$500 infra)
     │  ╭────────╯
     └──┴───────────────────────────────────────────────────── Tasks/month
        1K    5K    15K    30K         90K        300K
```

**S1 → S2 upgrade trigger**: When a single team reaches sustained utilization >70% OR when you need task routing to different specializations. Fixed infra jump: +$522/month.

**S2 → S3 upgrade trigger**: When workloads require cross-team collaboration OR single-team parallel capacity is exhausted. Fixed infra jump: +$2,470/month.

At low volumes, the infra cost dominates and cost/task is high. The system becomes cost-efficient only when LLM volume absorbs the fixed overhead:
- S1 efficient above ~5,000 tasks/month
- S2 efficient above ~15,000 tasks/month
- S3 efficient above ~50,000 tasks/month

---

## 8. Summary

| | S1 | S2 | S3 |
|---|---|---|---|
| **Agents** | 5 (1 supervisor + 4 workers) | 13 (3 supervisors + 12 workers) | 31 (5 supervisors + 25 workers) |
| **Teams** | 1 | 3 | 5 |
| **Fixed infra/month** | $808 | $1,330 | $3,800 |
| **LLM cost/task** | $0.260 | $0.260 | $0.513 avg |
| **Total at baseline workload** | $2,368 | $9,130 | $49,970 |
| **Cost/task at baseline** | $0.39 | $0.30 | $0.56 |
| **LLM % of total** | 66% | 85% | 92% |
| **Optimization potential** | −45% | −50% | −70% |

**The fundamental cost equation for AgentForge**:

```
Monthly cost = (tasks/month × LLM_cost/task) + fixed_infra

Where:
  LLM_cost/task = Σ (calls_per_agent × model_distribution × token_cost)
  fixed_infra   = K8s_nodes + managed_services  (scales in steps, not linearly)
```

LLM spend is **linear with volume**; infrastructure is **step-function with capacity**. At production volumes (>50K tasks/month), LLM API spend accounts for >85% of total cost. Every optimization effort should prioritize LLM usage first.

---

*Related documents: 09-cost-resource-manager.md, 20-multi-provider-llm-management.md, 21-runtime-deployment-environment.md*
