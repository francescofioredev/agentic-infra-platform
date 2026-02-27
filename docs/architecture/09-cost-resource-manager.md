# 09 — Cost & Resource Manager

## 1. Overview & Responsibility

The Cost & Resource Manager is the platform subsystem responsible for ensuring that every token spent across AgentForge delivers maximum value. It governs **model selection**, **token budget allocation and enforcement**, **contextual pruning**, **semantic caching**, and **cost reporting** across all agents, teams, and tasks.

In agentic systems, costs compound rapidly: a single user request may fan out across a team supervisor, multiple worker agents, guardrail evaluations, and reflection loops. Without centralized cost governance, a runaway agent loop or a misconfigured team can consume orders of magnitude more tokens than intended. The Cost & Resource Manager exists to prevent this while preserving output quality through intelligent resource allocation.

**Core design philosophy**: Use the cheapest model that can handle the task correctly (p. 258). Default to upclassing on ambiguity rather than risking a failed generation that wastes tokens on retries (p. 259).

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Cost & Resource Manager                         │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  Complexity   │  │  Token       │  │  Contextual Pruning      │  │
│  │  Router       │  │  Budget      │  │  Engine                  │  │
│  │  (p. 258)     │  │  System      │  │  (p. 260)                │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬─────────────┘  │
│         │                 │                        │                │
│  ┌──────┴─────────────────┴────────────────────────┴─────────────┐  │
│  │                    Cost Tracking Bus                            │  │
│  │        (per-agent, per-team, per-task accounting)              │  │
│  └──────┬─────────────────┬────────────────────────┬─────────────┘  │
│         │                 │                        │                │
│  ┌──────┴───────┐  ┌─────┴────────┐  ┌────────────┴─────────────┐  │
│  │  Semantic     │  │  Graceful    │  │  Reporting &             │  │
│  │  Cache        │  │  Degradation │  │  Dashboards              │  │
│  │  (p. 264)     │  │  Controller  │  │  (p. 304)                │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**Seven optimization techniques** implemented by this subsystem (p. 260-272):

| # | Technique | Section |
|---|-----------|---------|
| 1 | Dynamic model switching | §2, §3 |
| 2 | Contextual pruning | §5 |
| 3 | Semantic caching | §6 |
| 4 | Batch processing | §9 (API) |
| 5 | Early stopping | §4 (Budget enforcement) |
| 6 | Graceful degradation | §8 |
| 7 | OpenRouter integration | §2 (Model Tier System) |

---

## 2. Model Tier System

The platform organizes available models into three tiers corresponding to increasing capability, latency, and cost (p. 257). The tier system abstracts away specific provider models so the routing logic remains stable even as the model landscape evolves.

### 2.1 Tier Definitions

```
Tier 1 (Fast/Cheap)          Tier 2 (Balanced)            Tier 3 (Max Capability)
─────────────────────        ─────────────────────        ─────────────────────
Gemini Flash                 Gemini Pro                   Gemini Ultra
Claude Haiku                 Claude Sonnet                Claude Opus
GPT-4o-mini                  GPT-4o                       GPT-o3

~$0.10–0.25/M input         ~$1–3/M input                ~$10–15/M input
~$0.40–1.00/M output        ~$5–15/M output              ~$40–60/M output
<500ms first token           <2s first token              <5s first token
```

### 2.2 Tier Selection Guidelines

| Tier | When to Use | Examples |
|------|-------------|---------|
| **Tier 1** | Routing decisions, classification, simple extraction, formatting, validation, boilerplate generation | Platform Orchestrator routing (p. 258), guardrail pre-screening, structured data extraction, cache key generation |
| **Tier 2** | Most worker agent tasks, summarization, analysis, code generation, multi-step reasoning with clear instructions | Standard research tasks, report generation, code review, plan synthesis |
| **Tier 3** | Complex reasoning, ambiguous tasks, creative generation, tasks that failed at Tier 2, final quality-critical outputs | Novel architecture design, nuanced legal/medical analysis, multi-constraint optimization, tasks escalated via critique-then-escalate (p. 259) |

### 2.3 Critique-Then-Escalate Pattern (p. 259)

When a Tier 1 or Tier 2 model produces a result, a lightweight critique step evaluates confidence. If confidence is below threshold, the task is re-executed at the next tier rather than retrying at the same level. This avoids wasting tokens on repeated failures at an insufficient capability level.

```
Task ──► Tier 1 ──► Critique ──┬── confidence ≥ 0.8 ──► Accept
                               │
                               └── confidence < 0.8 ──► Tier 2 ──► Critique ──┬── ≥ 0.8 ──► Accept
                                                                               │
                                                                               └── < 0.8 ──► Tier 3
```

### 2.4 OpenRouter Integration (p. 270-272)

For maximum flexibility and cost optimization, the platform supports OpenRouter as a unified gateway to multiple model providers. This enables:

- **Automatic failover**: If a primary provider is down, requests route to an alternative provider offering the same model class.
- **Cost arbitrage**: Select the cheapest available provider for a given tier at query time.
- **Rate limit distribution**: Spread requests across providers to avoid hitting per-provider rate limits.

The model tier configuration is stored in a provider-agnostic format:

```json
{
  "tiers": {
    "tier_1": {
      "models": [
        {"provider": "anthropic", "model": "claude-haiku", "priority": 1},
        {"provider": "google", "model": "gemini-flash", "priority": 2},
        {"provider": "openrouter", "model": "auto-cheap", "priority": 3}
      ],
      "max_cost_per_1k_input": 0.0005,
      "max_latency_p95_ms": 800
    },
    "tier_2": {
      "models": [
        {"provider": "anthropic", "model": "claude-sonnet", "priority": 1},
        {"provider": "google", "model": "gemini-pro", "priority": 2}
      ],
      "max_cost_per_1k_input": 0.005,
      "max_latency_p95_ms": 3000
    },
    "tier_3": {
      "models": [
        {"provider": "anthropic", "model": "claude-opus", "priority": 1},
        {"provider": "google", "model": "gemini-ultra", "priority": 2}
      ],
      "max_cost_per_1k_input": 0.020,
      "max_latency_p95_ms": 10000
    }
  }
}
```

---

## 3. Complexity Router

The Complexity Router is a specialized RouterAgent (p. 258) that classifies incoming tasks by complexity and selects the appropriate model tier. It is itself powered by a Tier 1 model to keep routing overhead negligible (p. 258).

### 3.1 Classification Dimensions

The router evaluates tasks across four dimensions:

| Dimension | Low (Tier 1) | Medium (Tier 2) | High (Tier 3) |
|-----------|-------------|-----------------|----------------|
| **Reasoning depth** | Single-step extraction/classification | Multi-step chain with clear logic | Ambiguous, multi-constraint, novel reasoning |
| **Domain specificity** | General knowledge, formatting | Specialized but well-documented domains | Expert-level domain requiring nuanced judgment |
| **Output complexity** | Short, structured (JSON, boolean, category) | Moderate-length prose or code | Long-form, creative, or architecturally complex |
| **Error tolerance** | Low-stakes, easily verified | Moderate stakes, reviewable | High stakes, difficult to verify post-hoc |

### 3.2 Router Implementation

The router applies the Routing pattern (p. 21-40) specifically to model selection. It uses a cheap model to analyze the task prompt and produce a structured classification. The router prompt uses Chain-of-Draft (p. 272) to minimize its own token consumption: it produces only the minimal reasoning needed to reach a classification rather than verbose chain-of-thought.

```python
# --- Complexity Router (p. 258) ---

from dataclasses import dataclass
from enum import Enum
from typing import Optional
import json


class ModelTier(Enum):
    TIER_1 = "tier_1"  # Flash / Haiku
    TIER_2 = "tier_2"  # Pro / Sonnet
    TIER_3 = "tier_3"  # Ultra / Opus


@dataclass
class RoutingDecision:
    tier: ModelTier
    confidence: float          # 0.0 – 1.0
    reasoning_hint: str        # brief Chain-of-Draft rationale (p. 272)
    estimated_tokens: int      # expected input+output tokens
    escalation_allowed: bool   # whether critique-then-escalate is permitted


ROUTER_SYSTEM_PROMPT = """You are a task complexity classifier for an agentic AI platform.
Given a task description, classify it into exactly one tier.

Tiers:
- tier_1: Simple extraction, formatting, classification, routing. Single-step reasoning.
- tier_2: Multi-step analysis, standard code generation, summarization with synthesis.
- tier_3: Ambiguous reasoning, novel creative work, expert-domain judgment, multi-constraint optimization.

Rules:
- When ambiguous, choose the HIGHER tier (p. 259).
- Use Chain-of-Draft: output only the minimum reasoning needed (p. 272).
- Estimate total tokens (input + output) for the task.

Respond in JSON:
{"tier": "tier_1|tier_2|tier_3", "confidence": 0.0-1.0, "hint": "<10 words>", "est_tokens": <int>}"""


class ComplexityRouter:
    """Routes tasks to the appropriate model tier using a cheap classifier (p. 258).

    The router itself always runs on a Tier 1 model to keep routing cost
    minimal. It applies the Router pattern (p. 21-40) to model selection
    rather than agent selection.
    """

    def __init__(self, tier1_client, config: dict):
        self.client = tier1_client          # always a cheap/fast model (p. 258)
        self.ambiguity_threshold = config.get("ambiguity_threshold", 0.6)
        self.override_rules = config.get("override_rules", [])

    async def classify(self, task_description: str, context: Optional[dict] = None) -> RoutingDecision:
        # Step 1: Check deterministic override rules first (no LLM call needed)
        override = self._check_overrides(task_description, context)
        if override is not None:
            return override

        # Step 2: Call Tier 1 model for classification (p. 258)
        response = await self.client.generate(
            system=ROUTER_SYSTEM_PROMPT,
            prompt=f"Task: {task_description}\nContext keys: {list((context or {}).keys())}",
            max_tokens=100,  # Chain-of-Draft keeps output small (p. 272)
            temperature=0.0,
        )

        classification = json.loads(response.text)

        tier = ModelTier(classification["tier"])
        confidence = classification["confidence"]

        # Step 3: Apply upclass-on-ambiguity rule (p. 259)
        if confidence < self.ambiguity_threshold:
            tier = self._upclass(tier)

        return RoutingDecision(
            tier=tier,
            confidence=confidence,
            reasoning_hint=classification.get("hint", ""),
            estimated_tokens=classification.get("est_tokens", 1000),
            escalation_allowed=(tier != ModelTier.TIER_3),  # can't escalate beyond Tier 3
        )

    def _upclass(self, current_tier: ModelTier) -> ModelTier:
        """Escalate to the next tier when confidence is below threshold (p. 259)."""
        if current_tier == ModelTier.TIER_1:
            return ModelTier.TIER_2
        elif current_tier == ModelTier.TIER_2:
            return ModelTier.TIER_3
        return ModelTier.TIER_3

    def _check_overrides(self, task: str, context: Optional[dict]) -> Optional[RoutingDecision]:
        """Apply deterministic rules that bypass the LLM classifier.

        Examples:
        - Tasks tagged with 'format_only' always go to Tier 1.
        - Tasks from the evaluation framework always go to Tier 2+.
        - Tasks marked 'quality_critical' always go to Tier 3.
        """
        if context:
            if context.get("force_tier"):
                forced = ModelTier(context["force_tier"])
                return RoutingDecision(
                    tier=forced, confidence=1.0,
                    reasoning_hint="forced_override",
                    estimated_tokens=0, escalation_allowed=False,
                )
            if context.get("quality_critical"):
                return RoutingDecision(
                    tier=ModelTier.TIER_3, confidence=1.0,
                    reasoning_hint="quality_critical_flag",
                    estimated_tokens=0, escalation_allowed=False,
                )
        return None
```

### 3.3 Routing Cost Overhead

The router call itself is bounded: a Tier 1 model with `max_tokens=100` and a short system prompt (~150 tokens). At Tier 1 pricing, each routing decision costs approximately **$0.00005** -- negligible compared to even the cheapest worker agent invocation. This aligns with the principle of using a cheap model for the routing decision itself (p. 258).

### 3.4 Routing for Prompt Chains

For prompt chains (p. 1-7), the router can assign different tiers to different steps within the chain. Early steps that perform extraction or classification may run at Tier 1, while the final synthesis step may require Tier 2. This per-step routing is coordinated with the Team Orchestrator:

```
Plan Step 1 (Extract entities)    → Tier 1   ~$0.0002
Plan Step 2 (Classify sentiment)  → Tier 1   ~$0.0002
Plan Step 3 (Synthesize report)   → Tier 2   ~$0.0040
Plan Step 4 (Quality review)      → Tier 1   ~$0.0003
                                    ─────────────────
                                    Total: ~$0.0047

vs. running all steps at Tier 2:   Total: ~$0.0160  (3.4x more expensive)
```

This implements the bounded step costs principle from the Prompt Chaining pattern (p. 7): each step in a chain has a predictable, bounded cost rather than the open-ended cost profile of a fully autonomous agent.

---

## 4. Token Budget System

The Token Budget System enforces spending limits at three hierarchical levels: **task**, **agent**, and **team**. This prevents runaway costs from agent loops, excessive retries, or misconfigured workflows.

### 4.1 Budget Hierarchy

```
┌─────────────────────────────────────────┐
│ Organization Budget (monthly)            │
│ ┌─────────────────────────────────────┐ │
│ │ Team Budget (per team, per period)   │ │
│ │ ┌─────────────────────────────────┐ │ │
│ │ │ Agent Budget (per agent, per    │ │ │
│ │ │ period or per invocation)       │ │ │
│ │ │ ┌─────────────────────────────┐ │ │ │
│ │ │ │ Task Budget (per request)   │ │ │ │
│ │ │ └─────────────────────────────┘ │ │ │
│ │ └─────────────────────────────────┘ │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### 4.2 Budget Allocation Rules

| Level | Default Budget | Override | Enforcement |
|-------|---------------|----------|-------------|
| **Task** | 50,000 tokens (input+output combined) | Per-task override via API | Hard stop: task fails with `BUDGET_EXHAUSTED` |
| **Agent** | 500,000 tokens per hour | Agent config `max_tokens_per_hour` | Soft limit at 80%, hard stop at 100% |
| **Team** | 5,000,000 tokens per hour | Team config `max_tokens_per_hour` | Soft limit at 80%, hard stop at 100%, alert at 60% |
| **Organization** | $500/day (converted to tokens at current rates) | Admin configuration | Alert at 70%, HITL approval required at 90%, hard stop at 100% |

### 4.3 Budget Enforcement

```python
# --- Token Budget Enforcement ---

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
import time
import asyncio


class BudgetLevel(Enum):
    TASK = "task"
    AGENT = "agent"
    TEAM = "team"
    ORGANIZATION = "organization"


class BudgetAction(Enum):
    ALLOW = "allow"               # proceed normally
    ALLOW_WITH_WARNING = "warn"   # proceed but emit alert
    DOWNGRADE_TIER = "downgrade"  # force a cheaper model tier
    REQUIRE_APPROVAL = "approval" # pause and request HITL approval (p. 207)
    DENY = "deny"                 # reject the request


@dataclass
class BudgetState:
    limit_tokens: int
    consumed_tokens: int = 0
    window_start: float = field(default_factory=time.time)
    window_duration_seconds: float = 3600.0  # 1 hour default

    @property
    def remaining(self) -> int:
        return max(0, self.limit_tokens - self.consumed_tokens)

    @property
    def utilization(self) -> float:
        if self.limit_tokens == 0:
            return 1.0
        return self.consumed_tokens / self.limit_tokens

    def is_window_expired(self) -> bool:
        return (time.time() - self.window_start) > self.window_duration_seconds

    def reset_if_expired(self):
        if self.is_window_expired():
            self.consumed_tokens = 0
            self.window_start = time.time()


class TokenBudgetManager:
    """Hierarchical token budget enforcement across task, agent, team,
    and organization levels.

    Budgets are checked BEFORE each LLM call. The manager returns an
    action that the caller must respect. This implements early stopping
    (p. 260) — halting execution before tokens are wasted on a call
    that would exceed the budget.
    """

    def __init__(self, config: dict, alert_emitter, hitl_gateway):
        self.budgets: dict[str, BudgetState] = {}  # keyed by "{level}:{id}"
        self.config = config
        self.alert_emitter = alert_emitter
        self.hitl_gateway = hitl_gateway
        self._lock = asyncio.Lock()

    async def check_budget(
        self,
        task_id: str,
        agent_id: str,
        team_id: str,
        org_id: str,
        estimated_tokens: int,
    ) -> BudgetAction:
        """Check all four budget levels before an LLM call.

        Returns the most restrictive action across all levels.
        Budget checks are ordered from most specific (task) to
        most general (organization).
        """
        async with self._lock:
            actions = []

            for level, entity_id in [
                (BudgetLevel.TASK, task_id),
                (BudgetLevel.AGENT, agent_id),
                (BudgetLevel.TEAM, team_id),
                (BudgetLevel.ORGANIZATION, org_id),
            ]:
                budget = self._get_budget(level, entity_id)
                budget.reset_if_expired()
                action = self._evaluate(level, budget, estimated_tokens)
                actions.append((level, action))

            # Return the most restrictive action
            return self._most_restrictive(actions)

    async def record_usage(
        self,
        task_id: str,
        agent_id: str,
        team_id: str,
        org_id: str,
        actual_tokens: int,
    ):
        """Record actual token consumption after an LLM call completes."""
        async with self._lock:
            for level, entity_id in [
                (BudgetLevel.TASK, task_id),
                (BudgetLevel.AGENT, agent_id),
                (BudgetLevel.TEAM, team_id),
                (BudgetLevel.ORGANIZATION, org_id),
            ]:
                key = f"{level.value}:{entity_id}"
                if key in self.budgets:
                    self.budgets[key].consumed_tokens += actual_tokens

    def _get_budget(self, level: BudgetLevel, entity_id: str) -> BudgetState:
        key = f"{level.value}:{entity_id}"
        if key not in self.budgets:
            default_limit = self.config["default_limits"][level.value]
            self.budgets[key] = BudgetState(limit_tokens=default_limit)
        return self.budgets[key]

    def _evaluate(self, level: BudgetLevel, budget: BudgetState, est_tokens: int) -> BudgetAction:
        projected_utilization = (budget.consumed_tokens + est_tokens) / budget.limit_tokens

        if projected_utilization > 1.0:
            if level == BudgetLevel.ORGANIZATION:
                return BudgetAction.DENY
            return BudgetAction.DENY

        if projected_utilization > 0.9 and level == BudgetLevel.ORGANIZATION:
            return BudgetAction.REQUIRE_APPROVAL  # HITL gate (p. 207)

        if projected_utilization > 0.9:
            return BudgetAction.DOWNGRADE_TIER

        if projected_utilization > 0.8:
            return BudgetAction.ALLOW_WITH_WARNING

        return BudgetAction.ALLOW

    def _most_restrictive(self, actions: list[tuple[BudgetLevel, BudgetAction]]) -> BudgetAction:
        priority = {
            BudgetAction.DENY: 0,
            BudgetAction.REQUIRE_APPROVAL: 1,
            BudgetAction.DOWNGRADE_TIER: 2,
            BudgetAction.ALLOW_WITH_WARNING: 3,
            BudgetAction.ALLOW: 4,
        }
        return min(actions, key=lambda x: priority[x[1]])[1]
```

### 4.4 Budget Alert Thresholds

| Utilization | Action |
|-------------|--------|
| 0-60% | Normal operation |
| 60-80% | Informational alert emitted to Observability Platform (p. 304) |
| 80-90% | Warning alert; contextual pruning becomes more aggressive (see §5) |
| 90-100% | Tier downgrade enforced; HITL approval required for org-level budgets (p. 207) |
| >100% | Hard stop; task/agent/team blocked until budget window resets or limit is raised |

### 4.5 Integration with Agent Execution Loop

The budget check is integrated as a mandatory step in the agent execution loop, immediately before every LLM call. This implements early stopping (p. 260): the system halts before wasting tokens on a call that would exceed the budget, rather than discovering the overrun after the fact.

```
Agent receives task
    │
    ▼
┌─────────────────────────┐
│ Budget Check             │ ◄── TokenBudgetManager.check_budget()
│ (est. tokens for call)   │
└─────────┬───────────────┘
          │
    ┌─────┴──────────────────────────────────────┐
    │              │              │               │
  ALLOW        WARN          DOWNGRADE         DENY
    │           │               │               │
    ▼           ▼               ▼               ▼
 Proceed    Proceed +      Switch to        Return
 normally   emit alert     cheaper tier     BUDGET_EXHAUSTED
                           then proceed
```

---

## 5. Contextual Pruning Engine

The Contextual Pruning Engine reduces token consumption by removing low-value content from conversation histories and context windows before LLM calls (p. 260). It operates as a pre-processing step that is transparent to the agent logic.

### 5.1 What Gets Pruned

| Content Type | Pruning Strategy | Trigger |
|-------------|-----------------|---------|
| **Conversation history** | Remove system-generated boilerplate, compress older turns into summaries | History exceeds 60% of context window |
| **Tool call results** | Truncate verbose JSON responses, retain only fields referenced in subsequent turns | Tool result exceeds 2,000 tokens |
| **Failed attempts** | Remove full failed output, retain only error classification and lesson learned | Any failed generation followed by a retry |
| **Redundant context** | De-duplicate overlapping information from multiple tool calls or agent responses | Semantic similarity > 0.9 between context segments |
| **Stale context** | Remove context from completed sub-tasks that do not feed into the current step | Sub-task marked as complete and not referenced |

### 5.2 Pruning Levels

The engine operates at three levels of aggressiveness, controlled by the current budget utilization:

```
Budget Utilization    Pruning Level    Effect
─────────────────     ─────────────    ──────────────────────────────────
0–60%                 MINIMAL          Only prune clearly redundant content
60–80%                MODERATE         Summarize older turns, truncate tool results
80–100%               AGGRESSIVE       Compress history to key facts only,
                                       apply Chain-of-Draft (p. 272) to
                                       all system prompts
```

### 5.3 Pruning Techniques

**Summarization compression**: Replace N older conversation turns with a single summary turn. The summary is generated by a Tier 1 model call (cheap overhead) and captures key facts, decisions, and open questions.

**Chain-of-Draft compression (p. 272)**: For system prompts and instructions, rewrite verbose sections into minimal, high-density instructions. This technique, borrowed from reasoning optimization, reduces prompt token count by 30-50% while preserving instruction fidelity.

**Sliding window with landmarks**: Retain the most recent K turns in full, plus any turn that is referenced by a later turn (a "landmark"). All other turns are summarized or dropped.

**Structural pruning for tool results**: Parse structured tool outputs (JSON, XML, tables) and retain only the fields that appear in the agent's output schema or are referenced in subsequent reasoning. For example, if a web search tool returns 10 results but the agent only uses 3, prune the other 7 from context on subsequent turns.

### 5.4 Pruning Safety Guarantees

- The **system prompt** is never pruned (it defines agent identity and behavior).
- The **current user message** is never pruned.
- The **most recent tool call and result** are never pruned.
- Any pruning that removes a turn referenced by a later turn is rejected (landmark protection).
- A `pruning_applied` flag is attached to the trace span so that any quality degradation can be correlated with pruning activity (p. 304).

---

## 6. Semantic Cache

The Semantic Cache stores responses to previously-seen queries and returns cached results when a sufficiently similar query arrives (p. 264). Unlike exact-match caches, the semantic cache uses embedding similarity to match queries that are paraphrased or slightly varied.

### 6.1 Architecture

```
Incoming Query
      │
      ▼
┌─────────────────┐
│ Embedding Model  │  Generate query embedding (Tier 1 model)
│ (cheap/fast)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐         ┌──────────────────┐
│ Similarity       │────────►│ Vector Store      │
│ Search           │◄────────│ (pgvector/Qdrant) │
│ (cosine sim.)    │         └──────────────────┘
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
  HIT       MISS
    │         │
    ▼         ▼
 Return     Execute LLM call
 cached     then store result
 response   in cache
```

### 6.2 Cache Key Generation

The cache key is a composite of:

1. **Query embedding**: Dense vector representation of the natural-language query.
2. **Model tier**: Responses are tier-specific (a Tier 1 response should not be served for a Tier 3 request).
3. **Agent identity**: Responses are agent-specific because different agents have different system prompts.
4. **Tool availability hash**: Responses may differ based on which tools were available during generation.

```python
# --- Semantic Cache (p. 264) ---

from dataclasses import dataclass
from typing import Optional
import hashlib
import time
import numpy as np


@dataclass
class CacheEntry:
    query_embedding: np.ndarray
    response: str
    model_tier: str
    agent_id: str
    tool_hash: str
    created_at: float
    ttl_seconds: float
    hit_count: int = 0
    token_cost_saved: int = 0  # cumulative tokens saved by cache hits

    @property
    def is_expired(self) -> bool:
        return (time.time() - self.created_at) > self.ttl_seconds


class SemanticCache:
    """Semantic similarity cache for LLM responses (p. 264).

    Uses embedding-based similarity search to find cached responses
    for queries that are semantically equivalent, even if not
    lexically identical. Applies TTL-based expiration to ensure
    freshness.
    """

    # TTL defaults by content volatility (p. 264)
    TTL_STATIC = 86400.0       # 24 hours — factual/reference content
    TTL_SEMI_DYNAMIC = 3600.0  # 1 hour — analysis, summaries
    TTL_DYNAMIC = 300.0        # 5 minutes — real-time data dependent

    def __init__(self, vector_store, embedding_client, config: dict):
        self.vector_store = vector_store
        self.embedding_client = embedding_client
        self.similarity_threshold = config.get("similarity_threshold", 0.92)
        self.max_entries = config.get("max_entries", 100_000)
        self.default_ttl = config.get("default_ttl", self.TTL_SEMI_DYNAMIC)

    async def get(
        self,
        query: str,
        model_tier: str,
        agent_id: str,
        available_tools: list[str],
    ) -> Optional[str]:
        """Look up a semantically similar cached response.

        Returns the cached response if a match is found above the
        similarity threshold and the entry has not expired.
        Returns None on cache miss.
        """
        # Step 1: Compute query embedding
        query_embedding = await self.embedding_client.embed(query)
        tool_hash = self._compute_tool_hash(available_tools)

        # Step 2: Search vector store with metadata filters
        candidates = await self.vector_store.search(
            vector=query_embedding,
            top_k=5,
            filters={
                "model_tier": model_tier,
                "agent_id": agent_id,
                "tool_hash": tool_hash,
            },
        )

        # Step 3: Find best match above threshold
        for candidate in candidates:
            similarity = self._cosine_similarity(query_embedding, candidate.embedding)
            if similarity >= self.similarity_threshold:
                entry = candidate.metadata
                if not self._is_expired(entry):
                    # Cache HIT
                    await self._record_hit(candidate.id, entry)
                    return entry["response"]

        # Cache MISS
        return None

    async def put(
        self,
        query: str,
        response: str,
        model_tier: str,
        agent_id: str,
        available_tools: list[str],
        ttl: Optional[float] = None,
        token_count: int = 0,
    ):
        """Store a response in the cache for future semantic lookups."""
        query_embedding = await self.embedding_client.embed(query)
        tool_hash = self._compute_tool_hash(available_tools)

        await self.vector_store.upsert(
            id=self._generate_entry_id(query, agent_id, model_tier),
            vector=query_embedding,
            metadata={
                "response": response,
                "model_tier": model_tier,
                "agent_id": agent_id,
                "tool_hash": tool_hash,
                "created_at": time.time(),
                "ttl_seconds": ttl or self.default_ttl,
                "hit_count": 0,
                "token_cost": token_count,
            },
        )

    async def invalidate(self, agent_id: str, reason: str = "manual"):
        """Invalidate all cache entries for a given agent.

        Called when an agent's system prompt is updated (via Prompt
        Registry), as cached responses may no longer be valid.
        """
        await self.vector_store.delete_by_filter({"agent_id": agent_id})

    async def invalidate_by_tool(self, tool_id: str):
        """Invalidate entries that depend on a specific tool.

        Called when a tool's behavior changes or a tool is removed
        from an agent's capabilities.
        """
        # Entries whose tool_hash includes the changed tool
        await self.vector_store.delete_by_filter({"tool_contains": tool_id})

    def _cosine_similarity(self, a: np.ndarray, b: np.ndarray) -> float:
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

    def _compute_tool_hash(self, tools: list[str]) -> str:
        sorted_tools = sorted(tools)
        return hashlib.sha256(",".join(sorted_tools).encode()).hexdigest()[:16]

    def _is_expired(self, entry: dict) -> bool:
        return (time.time() - entry["created_at"]) > entry["ttl_seconds"]

    def _generate_entry_id(self, query: str, agent_id: str, tier: str) -> str:
        raw = f"{agent_id}:{tier}:{query}"
        return hashlib.sha256(raw.encode()).hexdigest()

    async def _record_hit(self, entry_id: str, entry: dict):
        entry["hit_count"] = entry.get("hit_count", 0) + 1
        await self.vector_store.update_metadata(entry_id, {"hit_count": entry["hit_count"]})
```

### 6.3 Similarity Threshold

The default threshold is **0.92** (cosine similarity). This value balances hit rate against accuracy:

- **Below 0.85**: Unacceptable false-positive rate; semantically different queries return stale results.
- **0.85-0.90**: Acceptable for low-stakes tasks (Tier 1 classification, formatting).
- **0.90-0.95**: Default range; good balance for most agent tasks.
- **Above 0.95**: Very conservative; near-exact matches only; low hit rate.

Agents can override the threshold in their configuration. Quality-critical agents (Tier 3) should use a threshold of 0.95 or higher.

### 6.4 TTL Policy (p. 264)

Cache entries expire based on content volatility:

| Content Type | TTL | Rationale |
|-------------|-----|-----------|
| Factual/reference lookups | 24 hours | Stable knowledge rarely changes |
| Analytical summaries | 1 hour | Analysis may depend on changing data |
| Real-time data queries | 5 minutes | Data freshness is critical |
| Tool-dependent outputs | 30 minutes | Tool state may change |

### 6.5 Invalidation Triggers

Cache invalidation occurs automatically when:

1. **Agent prompt updated**: Prompt Registry emits a `prompt_version_changed` event; all entries for that agent are invalidated.
2. **Tool removed or changed**: MCP Manager emits a `tool_updated` event; entries with matching tool hash are invalidated.
3. **TTL expired**: Entries are lazily evicted on read or via periodic background sweep.
4. **Manual flush**: Operators can invalidate per-agent or global cache via the API.

---

## 7. Cost Tracking & Reporting

The Cost Tracking system records every token consumed and its associated cost, providing granular breakdowns by agent, team, task, and time period. This directly implements the token usage metrics (p. 304) and cost per task tracking requirements from the Evaluation & Monitoring pattern.

### 7.1 Cost Event Schema

Every LLM call produces a cost event:

```json
{
  "event_id": "uuid",
  "timestamp": "2026-02-27T14:30:00Z",
  "task_id": "task-abc-123",
  "agent_id": "research-agent-v2",
  "team_id": "team-alpha",
  "org_id": "org-main",
  "model_provider": "anthropic",
  "model_name": "claude-sonnet",
  "model_tier": "tier_2",
  "tokens_input": 1250,
  "tokens_output": 480,
  "cost_usd": 0.0034,
  "cache_hit": false,
  "pruning_applied": true,
  "pruning_tokens_saved": 320,
  "routing_decision": {
    "original_tier": "tier_2",
    "final_tier": "tier_2",
    "was_escalated": false,
    "router_confidence": 0.87
  },
  "budget_utilization": {
    "task": 0.35,
    "agent": 0.12,
    "team": 0.08,
    "org": 0.04
  },
  "trace_id": "trace-xyz-789",
  "span_id": "span-456"
}
```

### 7.2 Aggregation Dimensions

Cost data is aggregated along multiple dimensions and stored in the time-series database (ClickHouse/TimescaleDB) for efficient querying:

| Dimension | Granularity | Retention |
|-----------|-------------|-----------|
| Per-task | Individual request | 90 days |
| Per-agent | Hourly rollup | 1 year |
| Per-team | Hourly rollup | 1 year |
| Per-organization | Daily rollup | Indefinite |
| Per-model-tier | Hourly rollup | 1 year |
| Per-model-provider | Daily rollup | 1 year |

### 7.3 Cost Reports

The system generates the following standard reports:

**Task Cost Breakdown**: For a given task, shows cost per agent invocation, which model tier was used at each step, cache hit rate, and pruning savings. Enables post-hoc analysis of whether routing decisions were optimal.

```
Task: task-abc-123 — "Research competitive landscape for Q1 report"
Total Cost: $0.0187 | Total Tokens: 12,450 | Duration: 8.3s

Step  Agent              Tier    Tokens   Cost      Cache  Pruned
────  ─────              ────    ──────   ────      ─────  ──────
  1   RouterAgent        Tier 1     250   $0.0001   miss     —
  2   PlannerAgent       Tier 2   1,800   $0.0036   miss     —
  3   SearchAgent        Tier 1   2,100   $0.0005   miss     —
  4   SearchAgent        Tier 1   1,900   $0.0004   HIT      —
  5   AnalysisAgent      Tier 2   3,200   $0.0064   miss    320
  6   SynthesisAgent     Tier 2   2,800   $0.0056   miss    180
  7   GuardrailCheck     Tier 1     400   $0.0001   miss     —
                                  ──────  ────────
                                  12,450  $0.0187

Savings: Cache hit saved ~1,900 tokens ($0.0004)
         Pruning saved ~500 tokens ($0.0010)
         Tier optimization saved ~$0.0089 vs. all-Tier-2
```

**Agent Efficiency Report**: Per agent, shows average cost per invocation, cache hit rate, escalation rate (how often tasks were escalated to a higher tier), and cost trend over time.

**Team Budget Report**: Per team, shows budget utilization, burn rate, projected exhaustion time, and top cost-contributing agents.

**Optimization Opportunity Report**: Identifies agents or task patterns where cost could be reduced -- for example, agents with 0% cache hit rate on repetitive tasks, agents consistently escalated from Tier 1 to Tier 2 (suggesting the router threshold needs adjustment), or teams approaching budget limits.

### 7.4 Dashboard Integration

Cost metrics are exported to the Observability Platform (subsystem #5) and rendered in Grafana dashboards. Key visualizations include:

- **Real-time spend rate**: Tokens/second and $/hour across the platform.
- **Budget burn-down**: Per-team budget remaining vs. time in current window.
- **Tier distribution**: Pie chart showing what percentage of calls go to each tier.
- **Cache efficiency**: Hit rate over time, tokens saved, cost avoided.
- **Escalation funnel**: How many tasks start at each tier vs. where they finish.

---

## 8. Graceful Degradation Policy

When budgets are approaching exhaustion, the system degrades gracefully rather than failing abruptly. This preserves user experience while respecting cost constraints.

### 8.1 Degradation Ladder

The system progresses through degradation levels as budget pressure increases:

```
Level 0: NORMAL
  └── All features active, routing as classified

Level 1: ECONOMIZE  (budget utilization > 70%)
  └── Pruning set to MODERATE
  └── Cache similarity threshold lowered to 0.88 (more cache hits)
  └── Batch processing enabled for non-urgent tasks

Level 2: CONSTRAIN  (budget utilization > 85%)
  └── All Tier 3 requests downgraded to Tier 2
  └── Pruning set to AGGRESSIVE
  └── max_iterations reduced by 50% on all agents
  └── Non-essential guardrail checks deferred to async

Level 3: MINIMAL  (budget utilization > 95%)
  └── All requests forced to Tier 1
  └── Only critical guardrail checks executed
  └── Reflection loops disabled
  └── Users notified of reduced quality mode

Level 4: SUSPENDED  (budget exhausted)
  └── No new LLM calls permitted
  └── In-flight tasks allowed to complete current step only
  └── Cached responses still served
  └── HITL escalation for any override (p. 207)
```

### 8.2 Degradation Notifications

At each level transition, the system:

1. Emits a structured alert to the Observability Platform with the current level, trigger reason, and affected scope (team, org).
2. Adds a `degradation_level` field to all subsequent trace spans so quality metrics can be correlated.
3. Notifies team administrators via the configured alerting channel.
4. Logs the transition for audit purposes.

### 8.3 Recovery

When budget pressure decreases (e.g., a new budget window begins, or the limit is raised), the system automatically moves back up the degradation ladder. Recovery is immediate: the next LLM call checks current utilization and applies the appropriate level.

---

## 9. API Surface

### 9.1 Routing API

```
POST /api/v1/cost/route
  Body: { "task_description": str, "context": dict, "preferred_tier": str? }
  Response: { "tier": str, "confidence": float, "reasoning": str, "estimated_tokens": int }
  Notes: Returns the routing decision without executing the task.

POST /api/v1/cost/route/batch
  Body: { "tasks": [{ "task_description": str, "context": dict }] }
  Response: { "decisions": [RoutingDecision] }
  Notes: Batch routing for prompt chains (p. 1-7). Routes all steps
         at once to enable cross-step optimization.
```

### 9.2 Budget API

```
GET /api/v1/cost/budget/{level}/{entity_id}
  Response: { "limit_tokens": int, "consumed_tokens": int, "remaining": int,
              "utilization": float, "window_start": str, "window_end": str }

PUT /api/v1/cost/budget/{level}/{entity_id}
  Body: { "limit_tokens": int, "window_duration_seconds": int }
  Response: { "updated": true }
  Notes: Requires admin role. Changes take effect immediately.

GET /api/v1/cost/budget/{level}/{entity_id}/history
  Query: ?from=<iso8601>&to=<iso8601>&granularity=<hourly|daily>
  Response: { "periods": [{ "start": str, "end": str, "consumed": int, "limit": int }] }
```

### 9.3 Cache API

```
GET /api/v1/cost/cache/stats
  Response: { "total_entries": int, "hit_rate_1h": float, "hit_rate_24h": float,
              "tokens_saved_1h": int, "cost_saved_1h_usd": float }

DELETE /api/v1/cost/cache/agent/{agent_id}
  Response: { "entries_invalidated": int }
  Notes: Invalidate all cached responses for an agent.

DELETE /api/v1/cost/cache/all
  Response: { "entries_invalidated": int }
  Notes: Full cache flush. Requires admin role.

GET /api/v1/cost/cache/entries
  Query: ?agent_id=<str>&min_hits=<int>&sort_by=<hit_count|created_at>
  Response: { "entries": [{ "query_preview": str, "hit_count": int, "ttl_remaining": int }] }
```

### 9.4 Cost Reporting API

```
GET /api/v1/cost/report/task/{task_id}
  Response: { "steps": [...], "total_cost_usd": float, "total_tokens": int,
              "cache_savings": {...}, "pruning_savings": {...} }

GET /api/v1/cost/report/agent/{agent_id}
  Query: ?from=<iso8601>&to=<iso8601>
  Response: { "total_cost_usd": float, "avg_cost_per_invocation": float,
              "cache_hit_rate": float, "escalation_rate": float, "tier_breakdown": {...} }

GET /api/v1/cost/report/team/{team_id}
  Query: ?from=<iso8601>&to=<iso8601>
  Response: { "total_cost_usd": float, "budget_utilization": float,
              "agent_breakdown": [...], "top_cost_tasks": [...] }

GET /api/v1/cost/report/org/{org_id}/summary
  Query: ?period=<daily|weekly|monthly>
  Response: { "total_cost_usd": float, "trend": [...], "team_breakdown": [...],
              "optimization_opportunities": [...] }

GET /api/v1/cost/degradation/status
  Response: { "current_level": int, "level_name": str, "triggered_at": str?,
              "affected_scope": str, "budget_utilization": float }
```

### 9.5 Configuration API

```
GET /api/v1/cost/config/tiers
  Response: { "tiers": { "tier_1": {...}, "tier_2": {...}, "tier_3": {...} } }

PUT /api/v1/cost/config/tiers
  Body: { "tiers": { ... } }
  Notes: Update model tier configuration. Requires admin role.

GET /api/v1/cost/config/router
  Response: { "ambiguity_threshold": float, "override_rules": [...] }

PUT /api/v1/cost/config/router
  Body: { "ambiguity_threshold": float, "override_rules": [...] }
```

---

## 10. Failure Modes & Mitigations

| # | Failure Mode | Impact | Detection | Mitigation |
|---|-------------|--------|-----------|------------|
| 1 | **Router misclassifies task** (assigns too-low tier) | Poor quality output; wastes tokens on retry/escalation | Quality metrics drop for router-assigned tier; escalation rate rises | Critique-then-escalate pattern (p. 259) catches failures quickly. Router retraining on misclassification logs. Default to upclassing on ambiguity (p. 259). |
| 2 | **Router misclassifies task** (assigns too-high tier) | Unnecessary cost; correct but expensive | Cost-per-task significantly exceeds historical average for similar tasks | Periodic audit of routing decisions vs. actual complexity. Adjust `ambiguity_threshold` if upclassing rate exceeds 30%. |
| 3 | **Cache returns stale/incorrect response** | User receives outdated or wrong information | Quality evaluation flags cached response; user reports issue | TTL prevents long-term staleness (p. 264). Invalidation on prompt/tool changes. Conservative similarity threshold (0.92). Cache entries tagged with `cache_hit=true` in traces for post-hoc correlation. |
| 4 | **Cache poisoning** (bad response stored) | All similar future queries return bad response | Quality evaluator flags response; cache hit + low quality score correlation | All cached responses inherit the quality score of the original response. Entries with quality score below threshold are evicted. Invalidation API for manual override. |
| 5 | **Budget race condition** (concurrent calls exceed budget) | Temporary over-budget spend | Post-hoc budget check shows consumption > limit | Async lock on budget check (see pseudocode). Accept minor overruns from in-flight calls. Hard stop prevents further calls. |
| 6 | **Pruning removes critical context** | Agent produces wrong output due to missing information | Quality metrics drop when `pruning_applied=true`; agent requests information it previously had | Landmark protection prevents pruning referenced turns. Pruning level automatically reduced if quality correlation detected. System prompt and current message never pruned. |
| 7 | **Embedding model unavailable** (cache cannot compute keys) | All cache lookups fail; all requests go to LLM | Error rate spike on embedding calls | Graceful fallback: cache is bypassed entirely. LLM calls proceed normally. Alert emitted. No user-facing impact beyond higher cost. |
| 8 | **Cost tracking lag** (events delayed) | Budget enforcement uses stale data; potential over-spend | Lag between LLM call completion and cost event ingestion exceeds threshold | Budget enforcement uses in-memory counters (real-time). Cost reporting uses event store (may lag). Dual-write ensures consistency for enforcement. |
| 9 | **Model provider outage** | Calls to preferred provider fail | HTTP errors from provider; latency spike | Failover to next-priority provider in tier config. OpenRouter as fallback gateway (p. 270). Alert emitted. |
| 10 | **Degradation level thrashing** | System oscillates between degradation levels | Rapid level transitions in logs | Hysteresis: require utilization to drop 5% below threshold before recovering a level. Minimum dwell time of 60 seconds at each level. |

---

## 11. Instrumentation

All components of the Cost & Resource Manager emit structured telemetry to the Observability Platform (p. 301-314) via OpenTelemetry.

### 11.1 Metrics (Prometheus/OpenTelemetry format)

| Metric Name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `agentforge.cost.tokens_consumed_total` | Counter | `agent_id`, `team_id`, `model_tier`, `model_name`, `direction` (input/output) | Total tokens consumed |
| `agentforge.cost.cost_usd_total` | Counter | `agent_id`, `team_id`, `model_tier` | Total cost in USD |
| `agentforge.cost.budget_utilization` | Gauge | `level`, `entity_id` | Current budget utilization (0.0-1.0) |
| `agentforge.cost.routing_decisions_total` | Counter | `assigned_tier`, `confidence_bucket` | Count of routing decisions by tier and confidence |
| `agentforge.cost.escalations_total` | Counter | `from_tier`, `to_tier`, `reason` | Count of tier escalations |
| `agentforge.cost.cache_lookups_total` | Counter | `result` (hit/miss/expired) | Cache lookup outcomes |
| `agentforge.cost.cache_tokens_saved_total` | Counter | `agent_id`, `model_tier` | Tokens saved by cache hits |
| `agentforge.cost.cache_entries` | Gauge | `agent_id` | Current number of cache entries |
| `agentforge.cost.pruning_tokens_saved_total` | Counter | `agent_id`, `pruning_level` | Tokens saved by contextual pruning |
| `agentforge.cost.degradation_level` | Gauge | `scope` (team/org) | Current degradation level (0-4) |
| `agentforge.cost.degradation_transitions_total` | Counter | `from_level`, `to_level` | Degradation level transitions |
| `agentforge.cost.router_latency_seconds` | Histogram | `assigned_tier` | Time taken for routing decision |
| `agentforge.cost.budget_check_latency_seconds` | Histogram | `action` | Time taken for budget enforcement check |

### 11.2 Trace Attributes

Every LLM call span is decorated with the following Cost & Resource Manager attributes:

```
cost.model_tier           = "tier_2"
cost.model_name           = "claude-sonnet"
cost.tokens_input         = 1250
cost.tokens_output        = 480
cost.cost_usd             = 0.0034
cost.cache_hit            = false
cost.cache_similarity     = 0.0        # 0.0 if miss, similarity score if hit
cost.pruning_applied      = true
cost.pruning_level        = "moderate"
cost.pruning_tokens_saved = 320
cost.budget_action        = "allow"
cost.budget_utilization   = 0.35       # at task level
cost.degradation_level    = 0
cost.router_confidence    = 0.87
cost.router_original_tier = "tier_2"   # before any budget-forced downgrade
cost.router_final_tier    = "tier_2"   # after any budget-forced downgrade
```

### 11.3 Alerts

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| `CostBudgetWarning` | Any budget level > 80% utilization | Warning | Notify team admin |
| `CostBudgetCritical` | Any budget level > 95% utilization | Critical | Notify team admin + platform admin |
| `CostBudgetExhausted` | Any budget level reaches 100% | Critical | Auto-suspend + notify + HITL escalation |
| `CostEscalationRateHigh` | Escalation rate > 30% in past hour | Warning | Review router configuration |
| `CostCacheHitRateLow` | Cache hit rate < 5% over 24h (expected > 15%) | Info | Review cache config, similarity threshold |
| `CostDegradationActive` | Degradation level >= 2 for > 10 min | Warning | Review budget allocation |
| `CostRouterLatencyHigh` | Router P95 latency > 500ms | Warning | Check Tier 1 model health |
| `CostProviderFailover` | Primary model provider unreachable | Warning | Verify failover provider is active |
| `CostAnomalyDetected` | Cost per task > 3x rolling 7-day average | Warning | Investigate specific task/agent |

### 11.4 Audit Log

All budget modifications, cache invalidations, degradation transitions, and manual overrides are recorded in an append-only audit log:

```json
{
  "timestamp": "2026-02-27T14:30:00Z",
  "action": "budget_limit_changed",
  "actor": "admin@org.com",
  "target": "team:team-alpha",
  "details": {
    "field": "limit_tokens",
    "old_value": 5000000,
    "new_value": 8000000,
    "reason": "Increased for Q1 reporting sprint"
  }
}
```

---

*This subsystem depends on: Observability Platform (subsystem #5) for telemetry export, Prompt Registry (subsystem #7) for invalidation events, Tool & MCP Manager (subsystem #3) for tool change events. It is consumed by: Team Orchestrator (subsystem #2) for routing decisions, Agent Builder (subsystem #1) for budget configuration, Evaluation Framework (subsystem #8) for cost-quality correlation analysis.*
