# Subsystem 11: Memory & Context Management

## 1. Overview & Responsibility

The Memory & Context Management subsystem is the **cognitive persistence layer** of AgentForge. It governs how individual agents and teams remember, retrieve, forget, and optimize information across turns, sessions, and the entire platform lifecycle.

Without this subsystem, every agent interaction starts from zero — no history, no learned preferences, no shared team knowledge, no context continuity. With it, agents maintain coherent long-running conversations, teams build collective intelligence, and the platform intelligently manages the finite context window to maximize quality within token budgets.

### Core Responsibilities

| # | Responsibility | Pattern Reference |
|---|---------------|-------------------|
| 1 | **Agent Memory**: Per-agent short-term, working, and long-term memory | Memory Management (p. 148-155) |
| 2 | **Team Shared Memory**: Collective knowledge accessible to all team members | Memory Management (p. 151), Multi-Agent (p. 121) |
| 3 | **Context Window Optimization**: Pruning, summarization, and compression of context | Resource-Aware Optimization (p. 262), Reasoning Techniques (p. 272) |
| 4 | **Knowledge Retrieval (RAG)**: External knowledge grounding for agents and teams | RAG (p. 217-228) |
| 5 | **Memory Lifecycle**: TTL policies, invalidation, privacy compliance, garbage collection | Memory Management (p. 154) |
| 6 | **State Synchronization**: Consistent state across agents within a team | Memory Management (p. 148), A2A (p. 240) |

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   Memory & Context Management Subsystem                 │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    Memory Manager (Core)                        │    │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌────────────┐  │    │
│  │  │  Session   │  │  Working   │  │  Long-Term │  │  Team      │  │    │
│  │  │  Memory    │  │  Memory    │  │  Memory    │  │  Memory    │  │    │
│  │  │ (per-turn) │  │ (state)    │  │ (persist)  │  │  (shared)  │  │    │
│  │  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬──────┘  │    │
│  │        │               │               │              │         │    │
│  │  ┌─────┴───────────────┴───────────────┴──────────────┴─────┐   │    │
│  │  │                  State Store Layer                        │   │    │
│  │  │  prefix: temp:  │  prefix: agent:  │  prefix: user:      │   │    │
│  │  │                 │  prefix: team:   │  prefix: app:       │   │    │
│  │  └──────────────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │ Context Optimizer │  │  RAG Engine       │  │  Memory Lifecycle    │  │
│  │                   │  │                   │  │  Manager             │  │
│  │ - Pruning         │  │ - Ingestion       │  │                      │  │
│  │ - Summarization   │  │ - Retrieval       │  │ - TTL enforcement    │  │
│  │ - Compression     │  │ - Hybrid Search   │  │ - Invalidation       │  │
│  │ - Windowing       │  │ - GraphRAG        │  │ - GC / Compaction    │  │
│  │ - Prioritization  │  │ - Agentic RAG     │  │ - Privacy compliance │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
         │                        │                        │
    ┌────┴────┐             ┌─────┴─────┐           ┌─────┴──────┐
    │  Redis  │             │  Vector   │           │ PostgreSQL │
    │ (hot)   │             │  Store    │           │ (durable)  │
    └─────────┘             └───────────┘           └────────────┘
```

### Relationship to Other Subsystems

| Subsystem | Integration Point |
|-----------|------------------|
| Agent Builder (01) | Agents define their memory requirements in the Agent Definition Schema |
| Team Orchestrator (02) | Teams define shared memory policies; orchestrator reads/writes team state |
| Tool & MCP Manager (03) | Tool results cached in working memory; tool outputs sanitized before storage (p. 289) |
| Guardrail System (04) | Guardrails inspect memory writes for policy compliance; PII never persisted |
| Observability Platform (05) | Memory operations logged as spans; hit rates tracked as metrics |
| Code Generation Tools (06) | Code execution results stored in working memory for reflection loops |
| Prompt Registry (07) | Prompt templates reference memory variables; prompts stored via `app:` prefix |
| Evaluation Framework (08) | Eval results stored in `app:` memory; RAG quality measured as metric |
| Cost & Resource Manager (09) | Context optimization directly reduces token consumption; budget signals trigger pruning |

---

## 2. Memory Architecture: The Four-Layer Model

Building on the ADK Session/State/Memory trichotomy (p. 148), AgentForge extends this to a **four-layer memory model** that adds a dedicated Team Memory layer.

### 2.1 Memory Layer Overview

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  Layer 4: KNOWLEDGE MEMORY (cross-system, RAG-backed)        │
│  ─────────────────────────────────────────────────────        │
│  Scope: Platform-wide or per-domain                          │
│  Storage: Vector store + document store                      │
│  TTL: Source-dependent (hours to indefinite)                  │
│  Examples: Product catalog, company policies, API docs        │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Layer 3: LONG-TERM MEMORY (cross-session, persistent)       │
│  ─────────────────────────────────────────────────────        │
│  Scope: Per-user (user:) or per-app (app:)                   │
│  Storage: PostgreSQL + optional vector embeddings             │
│  TTL: 30-365 days (configurable per data type)                │
│  Examples: User preferences, conversation summaries,          │
│            learned behaviors, agent performance history        │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Layer 2: WORKING MEMORY (cross-turn, session-scoped)        │
│  ─────────────────────────────────────────────────────        │
│  Scope: Per-agent (agent:) or per-team (team:)               │
│  Storage: Redis                                               │
│  TTL: Session end                                             │
│  Examples: Task state, intermediate results, plan progress,   │
│            tool call results, scratchpad for reasoning         │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Layer 1: SESSION MEMORY (per-turn, ephemeral)               │
│  ─────────────────────────────────────────────────────        │
│  Scope: Per-interaction (temp:)                               │
│  Storage: In-process memory                                   │
│  TTL: Current turn only                                       │
│  Examples: Current message, current tool call, reasoning       │
│            trace, routing decision context                     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Extended State Prefix System

Building on the ADK prefix system (p. 151), AgentForge extends it with additional scopes:

```python
# Standard ADK prefixes (p. 151)
"temp:current_reasoning"          # Ephemeral, discarded after turn
"user:preferred_language"         # Per-user, persists across sessions
"app:global_model_config"         # Per-app, persists across all users

# AgentForge extensions
"agent:research_agent:scratchpad" # Per-agent working memory (Layer 2)
"agent:research_agent:history"    # Per-agent conversation summary (Layer 3)
"team:alpha:shared_context"       # Team-wide shared state (Layer 2)
"team:alpha:collective_knowledge" # Team-wide persistent knowledge (Layer 3)
"knowledge:product_catalog"       # RAG-backed knowledge (Layer 4)
"knowledge:company_policies"      # RAG-backed knowledge (Layer 4)
```

### 2.3 Memory Entry Schema

```json
{
  "key": "team:alpha:shared_context:current_plan",
  "value": { "steps": [...], "progress": 3, "total": 7 },
  "metadata": {
    "created_at": "2026-02-27T10:30:00Z",
    "updated_at": "2026-02-27T10:35:00Z",
    "created_by": "agent:supervisor_alpha",
    "ttl_seconds": null,
    "ttl_policy": "session_end",
    "version": 5,
    "content_hash": "sha256:abc123...",
    "access_count": 12,
    "last_accessed_at": "2026-02-27T10:35:00Z",
    "data_classification": "internal",
    "pii_flag": false
  }
}
```

---

## 3. Agent Memory Management

### 3.1 Per-Agent Memory Architecture

Each agent maintains its own memory across all four layers:

```
┌─────────────────────────────────────────┐
│           Agent: ResearchAgent          │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  Session Memory (temp:)         │    │
│  │  - Current user message         │    │
│  │  - Current reasoning trace      │    │
│  │  - Current tool call context    │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  Working Memory (agent:)        │    │
│  │  - Scratchpad / notes           │    │
│  │  - Intermediate results         │    │
│  │  - Conversation buffer (last N) │    │
│  │  - Active plan + progress       │    │
│  │  - Tool result cache            │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  Long-Term Memory (user:)       │    │
│  │  - User preference profile      │    │
│  │  - Past interaction summaries   │    │
│  │  - Learned patterns             │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  Knowledge Access (knowledge:)  │    │
│  │  - RAG retrieval interface      │    │
│  │  - Domain knowledge queries     │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

### 3.2 Agent Memory Manager Implementation

```python
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any
from enum import Enum


class MemoryLayer(str, Enum):
    SESSION = "session"     # temp: prefix, in-process
    WORKING = "working"     # agent: prefix, Redis
    LONG_TERM = "long_term" # user:/app: prefix, PostgreSQL
    KNOWLEDGE = "knowledge" # knowledge: prefix, Vector store


@dataclass
class MemoryEntry:
    key: str
    value: Any
    layer: MemoryLayer
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)
    created_by: str = ""
    ttl: timedelta | None = None
    version: int = 1
    pii_flag: bool = False
    access_count: int = 0


class AgentMemoryManager:
    """
    Manages the four-layer memory model for a single agent.
    Enforces prefix discipline (p. 151), TTL policies (p. 154),
    and PII safeguards.
    """

    def __init__(self, agent_id: str, session_store, redis_client,
                 pg_client, vector_store, guardrail_checker):
        self.agent_id = agent_id
        self.session = session_store       # Layer 1: in-process dict
        self.redis = redis_client          # Layer 2: Redis
        self.pg = pg_client               # Layer 3: PostgreSQL
        self.vectors = vector_store        # Layer 4: Vector DB
        self.guardrail = guardrail_checker # PII/policy check before write

    # ── Layer 1: Session Memory ───────────────────────────────────

    def set_session(self, key: str, value: Any) -> None:
        """Ephemeral per-turn storage. Discarded at turn end."""
        prefixed_key = f"temp:{self.agent_id}:{key}"
        self.session[prefixed_key] = MemoryEntry(
            key=prefixed_key, value=value, layer=MemoryLayer.SESSION
        )

    def get_session(self, key: str) -> Any | None:
        prefixed_key = f"temp:{self.agent_id}:{key}"
        entry = self.session.get(prefixed_key)
        return entry.value if entry else None

    def clear_session(self) -> None:
        """Called at end of each turn. Clears all temp: entries."""
        temp_keys = [k for k in self.session if k.startswith(f"temp:{self.agent_id}:")]
        for k in temp_keys:
            del self.session[k]

    # ── Layer 2: Working Memory ───────────────────────────────────

    async def set_working(self, key: str, value: Any,
                          ttl: timedelta | None = None) -> None:
        """Cross-turn state within a session. Stored in Redis."""
        prefixed_key = f"agent:{self.agent_id}:{key}"

        # Guardrail check: no PII in working memory (p. 289)
        if self.guardrail.contains_pii(value):
            raise MemoryPolicyViolation(
                f"PII detected in working memory write: {key}"
            )

        await self.redis.set(
            prefixed_key,
            serialize(MemoryEntry(
                key=prefixed_key, value=value,
                layer=MemoryLayer.WORKING, ttl=ttl,
                created_by=self.agent_id
            )),
            ex=int(ttl.total_seconds()) if ttl else None
        )

    async def get_working(self, key: str) -> Any | None:
        prefixed_key = f"agent:{self.agent_id}:{key}"
        raw = await self.redis.get(prefixed_key)
        if raw is None:
            return None
        entry = deserialize(raw)
        entry.access_count += 1
        entry.last_accessed_at = datetime.utcnow()
        return entry.value

    # ── Layer 3: Long-Term Memory ─────────────────────────────────

    async def store_long_term(self, key: str, value: Any,
                               scope: str = "user",
                               ttl_days: int = 90) -> None:
        """
        Cross-session persistent memory.
        scope: 'user' (per-user, user: prefix) or 'app' (global, app: prefix)
        TTL enforced for privacy compliance (p. 154).
        """
        if scope not in ("user", "app"):
            raise ValueError(f"Invalid scope: {scope}. Must be 'user' or 'app'.")

        prefixed_key = f"{scope}:{self.agent_id}:{key}"

        # Guardrail: PII only in user: scope, never in app: (p. 148)
        if scope == "app" and self.guardrail.contains_pii(value):
            raise MemoryPolicyViolation("PII cannot be stored in app: scope")

        await self.pg.upsert("long_term_memory", {
            "key": prefixed_key,
            "value": serialize(value),
            "scope": scope,
            "ttl_expires_at": datetime.utcnow() + timedelta(days=ttl_days),
            "created_by": self.agent_id,
            "version": await self._next_version(prefixed_key),
        })

    async def recall_long_term(self, key: str, scope: str = "user") -> Any | None:
        """Retrieve persistent memory, respecting TTL."""
        prefixed_key = f"{scope}:{self.agent_id}:{key}"
        row = await self.pg.get("long_term_memory", key=prefixed_key)
        if row is None:
            return None
        if row["ttl_expires_at"] < datetime.utcnow():
            await self.pg.delete("long_term_memory", key=prefixed_key)
            return None  # Expired — treat as forgotten
        return deserialize(row["value"])

    # ── Layer 4: Knowledge Retrieval (RAG) ────────────────────────

    async def query_knowledge(self, query: str, top_k: int = 5,
                               relevance_threshold: float = 0.7,
                               sources: list[str] | None = None) -> list[dict]:
        """
        Retrieve relevant knowledge using hybrid search (p. 222).
        Returns chunks above relevance_threshold; acknowledges
        knowledge gaps below threshold (p. 225).
        """
        # Hybrid search: BM25 + vector (p. 222)
        bm25_results = await self.vectors.bm25_search(query, top_k=top_k * 2)
        vector_results = await self.vectors.vector_search(
            query, top_k=top_k * 2, sources=sources
        )

        # Re-rank combined results (p. 223)
        combined = merge_and_deduplicate(bm25_results, vector_results)
        reranked = await self.reranker.rerank(query, combined, top_k=top_k)

        # Filter by relevance threshold (p. 225)
        relevant = [r for r in reranked if r["score"] >= relevance_threshold]

        if not relevant:
            return [{
                "type": "knowledge_gap",
                "message": "No relevant knowledge found for this query. "
                           "The agent should acknowledge this gap rather "
                           "than hallucinating (p. 225)."
            }]

        return relevant

    # ── Conversation History Management ───────────────────────────

    async def append_to_history(self, role: str, content: str) -> None:
        """
        Append a message to the agent's conversation buffer.
        Buffer is maintained in working memory with a sliding window.
        """
        history_key = f"agent:{self.agent_id}:conversation_history"
        history = await self.get_working("conversation_history") or []
        history.append({
            "role": role,
            "content": content,
            "timestamp": datetime.utcnow().isoformat()
        })
        await self.set_working("conversation_history", history)

    async def get_conversation_context(self, max_tokens: int) -> list[dict]:
        """
        Retrieve conversation history optimized for the context window.
        Delegates to the Context Optimizer (§5) for pruning/summarization.
        """
        full_history = await self.get_working("conversation_history") or []
        return await self.context_optimizer.optimize(
            full_history, max_tokens=max_tokens, agent_id=self.agent_id
        )
```

### 3.3 Agent Memory Configuration (in Agent Definition Schema)

Each agent declares its memory requirements in its definition:

```json
{
  "agent_id": "research-agent-001",
  "memory_config": {
    "session_memory": {
      "enabled": true
    },
    "working_memory": {
      "enabled": true,
      "max_entries": 100,
      "conversation_buffer": {
        "strategy": "sliding_window",
        "window_size": 20,
        "summarize_evicted": true
      },
      "scratchpad": {
        "enabled": true,
        "max_size_bytes": 65536
      }
    },
    "long_term_memory": {
      "enabled": true,
      "scopes": ["user"],
      "ttl_days": 90,
      "auto_summarize_sessions": true,
      "max_summaries_per_user": 50
    },
    "knowledge_access": {
      "enabled": true,
      "sources": ["knowledge:product_catalog", "knowledge:company_policies"],
      "retrieval_strategy": "hybrid",
      "top_k": 5,
      "relevance_threshold": 0.7
    },
    "context_optimization": {
      "strategy": "adaptive",
      "max_context_tokens": 8000,
      "pruning_aggressiveness": "medium",
      "summarization_model": "haiku"
    }
  }
}
```

---

## 4. Team Shared Memory

### 4.1 Why Team Memory Matters

In a multi-agent team, agents must coordinate without passing full histories to every member (p. 127 — context explosion risk). Team Memory provides a **shared cognitive space** where:

- The supervisor's plan and progress are visible to all workers
- One agent's discoveries are immediately available to others
- Cross-agent dependencies are tracked without direct communication overhead
- Collective decisions persist even as individual agents are recycled

### 4.2 Team Memory Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                    Team Alpha Shared Memory                     │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Team Working Memory (team:alpha:*)                      │   │
│  │                                                           │   │
│  │  team:alpha:active_plan      → Current plan + progress   │   │
│  │  team:alpha:shared_context   → Shared facts/findings     │   │
│  │  team:alpha:coordination     → Who is doing what         │   │
│  │  team:alpha:decisions        → Key decisions + rationale  │   │
│  │  team:alpha:blockers         → Current blocking issues    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Team Knowledge Base (team:alpha:kb:*)                   │   │
│  │                                                           │   │
│  │  team:alpha:kb:domain_facts  → Accumulated domain knowledge│  │
│  │  team:alpha:kb:past_tasks    → Summaries of completed tasks│  │
│  │  team:alpha:kb:lessons       → Learned patterns/mistakes  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Access Control                                          │   │
│  │                                                           │   │
│  │  Supervisor  → read/write all team:alpha:* keys          │   │
│  │  Workers     → read all, write only own namespace        │   │
│  │  Guardrails  → read-only (for monitoring)                │   │
│  │  Other teams → no access (isolation)                      │   │
│  └─────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

### 4.3 Team Memory Manager Implementation

```python
class TeamMemoryManager:
    """
    Manages shared memory for an agent team.
    Prevents context explosion (p. 127) by providing a structured
    shared state rather than broadcasting full agent histories.
    """

    def __init__(self, team_id: str, redis_client, pg_client,
                 vector_store, access_control):
        self.team_id = team_id
        self.redis = redis_client
        self.pg = pg_client
        self.vectors = vector_store
        self.acl = access_control

    # ── Shared Working State ──────────────────────────────────────

    async def publish_finding(self, agent_id: str, key: str,
                               finding: dict) -> None:
        """
        An agent publishes a finding to team shared memory.
        Other agents can read it without direct communication,
        preventing context explosion (p. 127).
        """
        self.acl.check_write(agent_id, self.team_id, key)

        entry = {
            "key": f"team:{self.team_id}:shared_context:{key}",
            "value": finding,
            "published_by": agent_id,
            "timestamp": datetime.utcnow().isoformat(),
            "version": await self._increment_version(key)
        }
        await self.redis.set(entry["key"], serialize(entry))

        # Notify team members via pub/sub (lightweight notification)
        await self.redis.publish(
            f"team:{self.team_id}:updates",
            serialize({"event": "finding_published", "key": key,
                        "by": agent_id})
        )

    async def read_shared_context(self, agent_id: str,
                                    keys: list[str] | None = None) -> dict:
        """
        An agent reads the current team shared context.
        Returns only the latest version of each key.
        """
        self.acl.check_read(agent_id, self.team_id)

        prefix = f"team:{self.team_id}:shared_context:"
        if keys:
            entries = {}
            for key in keys:
                raw = await self.redis.get(f"{prefix}{key}")
                if raw:
                    entries[key] = deserialize(raw)
            return entries
        else:
            # Scan all shared context keys
            all_keys = await self.redis.keys(f"{prefix}*")
            entries = {}
            for k in all_keys:
                raw = await self.redis.get(k)
                if raw:
                    short_key = k.removeprefix(prefix)
                    entries[short_key] = deserialize(raw)
            return entries

    # ── Plan & Coordination State ─────────────────────────────────

    async def update_plan_progress(self, step_id: str,
                                     status: str, result: Any = None) -> None:
        """
        Supervisor updates plan progress visible to all team members.
        Enables goal tracking (p. 188) at the team level.
        """
        plan_key = f"team:{self.team_id}:active_plan"
        plan = deserialize(await self.redis.get(plan_key))
        for step in plan["steps"]:
            if step["id"] == step_id:
                step["status"] = status
                step["result"] = result
                step["completed_at"] = datetime.utcnow().isoformat()
                break
        await self.redis.set(plan_key, serialize(plan))

    async def get_coordination_state(self) -> dict:
        """
        Returns who is doing what — prevents duplicate work
        and enables dependency tracking.
        """
        coord_key = f"team:{self.team_id}:coordination"
        raw = await self.redis.get(coord_key)
        return deserialize(raw) if raw else {}

    async def claim_task(self, agent_id: str, task_id: str) -> bool:
        """
        Agent claims a task atomically. Returns False if already claimed.
        Uses Redis SETNX for atomic claim.
        """
        claim_key = f"team:{self.team_id}:claims:{task_id}"
        claimed = await self.redis.setnx(claim_key, agent_id)
        if claimed:
            await self.redis.expire(claim_key, 3600)  # 1h timeout
        return claimed

    # ── Team Decision Log ─────────────────────────────────────────

    async def record_decision(self, agent_id: str, decision: dict) -> None:
        """
        Record a key decision with rationale. Enables auditing
        and prevents goal drift (p. 127) by making the reasoning
        visible to all team members.
        """
        decision_entry = {
            "decision_id": generate_uuid(),
            "agent_id": agent_id,
            "team_id": self.team_id,
            "description": decision["description"],
            "rationale": decision["rationale"],
            "alternatives_considered": decision.get("alternatives", []),
            "timestamp": datetime.utcnow().isoformat()
        }
        await self.redis.rpush(
            f"team:{self.team_id}:decisions",
            serialize(decision_entry)
        )

    # ── Team Knowledge Base (Persistent) ──────────────────────────

    async def add_to_knowledge_base(self, content: str,
                                      metadata: dict,
                                      category: str = "domain_facts") -> str:
        """
        Add learned knowledge to the team's persistent knowledge base.
        Stored as vector embeddings for semantic retrieval.
        """
        chunk_id = generate_uuid()
        embedding = await self.vectors.embed(content)

        await self.vectors.upsert({
            "id": chunk_id,
            "embedding": embedding,
            "content": content,
            "metadata": {
                **metadata,
                "team_id": self.team_id,
                "category": category,
                "indexed_at": datetime.utcnow().isoformat()
            }
        }, namespace=f"team:{self.team_id}:kb")

        return chunk_id

    async def query_team_knowledge(self, query: str,
                                     top_k: int = 5,
                                     category: str | None = None) -> list[dict]:
        """
        Semantic search over the team's accumulated knowledge.
        Uses hybrid search (p. 222) for best recall.
        """
        filters = {"team_id": self.team_id}
        if category:
            filters["category"] = category

        return await self.vectors.hybrid_search(
            query=query, top_k=top_k, filters=filters,
            namespace=f"team:{self.team_id}:kb"
        )

    # ── Session Summarization ─────────────────────────────────────

    async def summarize_completed_task(self, task_id: str,
                                        task_result: dict) -> None:
        """
        After a team task completes, summarize it and store
        in the team knowledge base. Enables learning across
        tasks (p. 163) and prevents context explosion in
        future sessions (p. 127).
        """
        summary_prompt = f"""
        Summarize the following completed task for future reference.
        Include: what was done, key findings, decisions made, and lessons learned.
        Keep it concise (3-5 sentences).

        Task ID: {task_id}
        Result: {json.dumps(task_result)}
        """
        summary = await self.summarization_llm.invoke(summary_prompt)

        await self.add_to_knowledge_base(
            content=summary,
            metadata={"task_id": task_id, "type": "task_summary"},
            category="past_tasks"
        )
```

### 4.4 Team Memory Configuration (in Team Definition Schema)

```json
{
  "team_id": "team-alpha",
  "memory_config": {
    "shared_working_memory": {
      "enabled": true,
      "max_entries": 500,
      "auto_expire_seconds": 3600,
      "notification_channel": true
    },
    "team_knowledge_base": {
      "enabled": true,
      "auto_summarize_tasks": true,
      "knowledge_categories": ["domain_facts", "past_tasks", "lessons"],
      "max_kb_entries": 10000,
      "vector_store_namespace": "team:alpha:kb"
    },
    "coordination": {
      "atomic_task_claiming": true,
      "decision_log": true,
      "plan_visibility": "all_members"
    },
    "access_control": {
      "supervisor_access": "read_write_all",
      "worker_access": "read_all_write_own",
      "guardrail_access": "read_only",
      "cross_team_access": "none"
    },
    "context_sharing_strategy": "structured_state",
    "anti_context_explosion": {
      "max_shared_context_tokens": 4000,
      "summarize_on_overflow": true,
      "never_broadcast_full_history": true
    }
  }
}
```

---

## 5. Context Window Optimization

The context window is the fundamental bottleneck of LLM-based agents. Every token in context has a cost, and irrelevant tokens degrade response quality. The Context Optimizer ensures agents always operate with the **most relevant** context within their **token budget**.

### 5.1 Optimization Strategy Overview

```
   Full Agent Context (potentially unlimited)
   ┌──────────────────────────────────────────┐
   │  System Prompt                     [KEEP] │
   │  Current User Message              [KEEP] │
   │  Active Plan + Current Step        [KEEP] │
   │  Recent Conversation (last 5)      [KEEP] │
   │  ─────────── relevance cutoff ──────────  │
   │  Older Conversation (turns 6-20)   [SUMMARIZE] │
   │  Previous Tool Results             [PRUNE if unused] │
   │  Failed Reasoning Attempts         [PRUNE] │
   │  Stale Shared Context              [PRUNE] │
   │  Redundant Information             [DEDUPLICATE] │
   │  Very Old History (turns 20+)      [DROP or ARCHIVE] │
   └──────────────────────────────────────────┘
           │
           ▼  Context Optimizer
   ┌──────────────────────────────────────────┐
   │  System Prompt                     800 tk │
   │  Current User Message              200 tk │
   │  Active Plan + Current Step        300 tk │
   │  Recent Conversation (5 turns)    1500 tk │
   │  Summary of turns 6-20            400 tk │
   │  Relevant RAG chunks              800 tk │
   │  Relevant Tool Results            500 tk │
   │  Team Shared Context (filtered)   500 tk │
   │  ──────────────────────────────────────── │
   │  Total: ~5000 / 8000 budget        [OK]  │
   └──────────────────────────────────────────┘
```

### 5.2 Context Optimizer Implementation

```python
class ContextOptimizer:
    """
    Optimizes agent context to fit within token budgets while
    maximizing information relevance.

    Implements contextual pruning (p. 262), summarization (p. 153),
    and Chain-of-Draft compression (p. 272).
    """

    # Items that are NEVER pruned (safety guarantee)
    PROTECTED_ITEMS = frozenset([
        "system_prompt",
        "current_message",
        "active_goal",
        "safety_constraints",
        "escalation_triggers",
    ])

    def __init__(self, token_counter, summarization_llm, embedding_model):
        self.count_tokens = token_counter
        self.summarizer = summarization_llm   # Cheap model (p. 258)
        self.embedder = embedding_model

    async def optimize(self, context_items: list[ContextItem],
                        max_tokens: int,
                        current_query: str,
                        aggressiveness: str = "medium") -> list[ContextItem]:
        """
        Main optimization pipeline.
        Returns an optimized context that fits within max_tokens.
        """
        # Step 1: Protect non-removable items
        protected = [i for i in context_items if i.type in self.PROTECTED_ITEMS]
        candidates = [i for i in context_items if i.type not in self.PROTECTED_ITEMS]

        protected_tokens = sum(self.count_tokens(i.content) for i in protected)
        remaining_budget = max_tokens - protected_tokens

        if remaining_budget <= 0:
            # Even protected items exceed budget — must summarize system prompt
            return await self._emergency_compress(protected, max_tokens)

        # Step 2: Score candidates by relevance to current query
        scored = await self._score_relevance(candidates, current_query)

        # Step 3: Apply pruning strategies based on aggressiveness
        optimized = await self._apply_strategies(
            scored, remaining_budget, aggressiveness
        )

        return protected + optimized

    async def _score_relevance(self, items: list[ContextItem],
                                 query: str) -> list[ScoredItem]:
        """
        Score each context item by relevance to the current query.
        Uses embedding similarity for semantic relevance.
        """
        query_embedding = await self.embedder.embed(query)
        scored = []
        for item in items:
            item_embedding = await self.embedder.embed(item.content[:500])
            similarity = cosine_similarity(query_embedding, item_embedding)

            # Boost score for recency
            recency_boost = self._recency_weight(item.timestamp)

            # Boost score for items from current plan step
            plan_boost = 1.3 if item.metadata.get("plan_step") == "current" else 1.0

            final_score = similarity * recency_boost * plan_boost
            scored.append(ScoredItem(item=item, score=final_score))

        return sorted(scored, key=lambda s: s.score, reverse=True)

    async def _apply_strategies(self, scored_items: list[ScoredItem],
                                  budget: int,
                                  aggressiveness: str) -> list[ContextItem]:
        """
        Apply optimization strategies in order of increasing aggressiveness.
        """
        result = []
        used_tokens = 0

        # Aggressiveness thresholds (p. 262)
        thresholds = {
            "low":    {"min_relevance": 0.3, "summarize_after": 10, "compress": False},
            "medium": {"min_relevance": 0.5, "summarize_after": 5,  "compress": False},
            "high":   {"min_relevance": 0.7, "summarize_after": 3,  "compress": True},
        }
        config = thresholds[aggressiveness]

        for scored in scored_items:
            item = scored.item
            item_tokens = self.count_tokens(item.content)

            # Strategy 1: PRUNE — drop low-relevance items
            if scored.score < config["min_relevance"]:
                continue  # Drop entirely

            # Strategy 2: DEDUPLICATE — skip if content already covered
            if self._is_duplicate(item, result):
                continue

            # Strategy 3: SUMMARIZE — compress old conversation turns
            if (item.type == "conversation_turn" and
                item.turn_index > config["summarize_after"]):
                item = await self._summarize_item(item)
                item_tokens = self.count_tokens(item.content)

            # Strategy 4: COMPRESS — Chain-of-Draft (p. 272)
            if config["compress"] and item_tokens > 200:
                item = await self._chain_of_draft_compress(item)
                item_tokens = self.count_tokens(item.content)

            # Strategy 5: TRUNCATE — hard cut if still over budget
            if used_tokens + item_tokens > budget:
                remaining = budget - used_tokens
                if remaining > 100:  # Only include if meaningful
                    item = self._truncate(item, remaining)
                    result.append(item)
                break

            result.append(item)
            used_tokens += item_tokens

        return result

    async def _summarize_item(self, item: ContextItem) -> ContextItem:
        """
        Summarize a context item to reduce token count.
        Uses cheap model for summarization (p. 258).
        """
        summary = await self.summarizer.invoke(
            f"Summarize this in 2-3 sentences, preserving key facts:\n"
            f"{item.content}"
        )
        return ContextItem(
            type=f"{item.type}_summary",
            content=summary,
            timestamp=item.timestamp,
            metadata={**item.metadata, "summarized": True,
                      "original_tokens": self.count_tokens(item.content)}
        )

    async def _chain_of_draft_compress(self, item: ContextItem) -> ContextItem:
        """
        Apply Chain-of-Draft compression (p. 272).
        Reduces verbose content to minimal key points (5-7 words per point).
        Up to 80% token reduction.
        """
        compressed = await self.summarizer.invoke(
            f"Compress this to minimal bullet points "
            f"(5-7 words each, no full sentences):\n{item.content}"
        )
        return ContextItem(
            type=f"{item.type}_compressed",
            content=compressed,
            timestamp=item.timestamp,
            metadata={**item.metadata, "compressed": True,
                      "compression_ratio": (
                          self.count_tokens(compressed) /
                          self.count_tokens(item.content)
                      )}
        )

    def _recency_weight(self, timestamp: datetime) -> float:
        """Exponential decay: recent items get higher weight."""
        age_minutes = (datetime.utcnow() - timestamp).total_seconds() / 60
        return max(0.1, math.exp(-age_minutes / 60))  # Half-life: ~1 hour

    def _is_duplicate(self, item: ContextItem,
                       existing: list[ContextItem]) -> bool:
        """Check if item's content is already substantially covered."""
        for ex in existing:
            if self._content_overlap(item.content, ex.content) > 0.8:
                return True
        return False
```

### 5.3 Conversation History Strategies

Different strategies for managing conversation history, configurable per agent:

```python
class ConversationHistoryStrategy(str, Enum):
    SLIDING_WINDOW = "sliding_window"       # Keep last N turns
    SUMMARIZE_AND_SLIDE = "summarize_slide"  # Summarize old, keep recent
    SEMANTIC_RETRIEVAL = "semantic"          # Retrieve relevant past turns
    HIERARCHICAL = "hierarchical"           # Multi-level summary hierarchy


class SlidingWindowStrategy:
    """
    Keep the last N turns in full. Drop older turns.
    Simplest and cheapest. Good for short-context tasks.
    """
    def __init__(self, window_size: int = 10):
        self.window_size = window_size

    def apply(self, history: list[dict]) -> list[dict]:
        return history[-self.window_size:]


class SummarizeAndSlideStrategy:
    """
    Keep last N turns in full. Summarize turns N+1 through M
    into a rolling summary. Drop turns older than M.

    Balances context preservation with token efficiency.
    Recommended for most production agents (p. 153).
    """
    def __init__(self, recent_window: int = 5,
                 summary_window: int = 20,
                 summarizer_llm=None):
        self.recent_window = recent_window
        self.summary_window = summary_window
        self.summarizer = summarizer_llm

    async def apply(self, history: list[dict],
                     existing_summary: str | None = None) -> dict:
        recent = history[-self.recent_window:]
        to_summarize = history[-(self.summary_window):-self.recent_window]

        if to_summarize:
            new_summary = await self.summarizer.invoke(
                f"Previous summary: {existing_summary or 'None'}\n"
                f"New turns to incorporate:\n"
                f"{format_turns(to_summarize)}\n\n"
                f"Produce an updated summary preserving all key facts, "
                f"decisions, and action items."
            )
        else:
            new_summary = existing_summary

        return {
            "summary": new_summary,
            "recent_turns": recent
        }


class SemanticRetrievalStrategy:
    """
    Store all conversation turns as embeddings.
    Retrieve the most relevant past turns for the current query.

    Best for long-running agents where old context may suddenly
    become relevant again (p. 155).
    """
    def __init__(self, vector_store, top_k: int = 10,
                 always_include_last: int = 3):
        self.vectors = vector_store
        self.top_k = top_k
        self.always_include = always_include_last

    async def apply(self, history: list[dict],
                     current_query: str) -> list[dict]:
        # Always include the most recent turns
        recent = history[-self.always_include:]

        # Semantically retrieve relevant older turns
        older = history[:-self.always_include]
        if older:
            relevant = await self.vectors.search(
                query=current_query,
                documents=[t["content"] for t in older],
                top_k=self.top_k - self.always_include
            )
            retrieved = [older[r["index"]] for r in relevant]
        else:
            retrieved = []

        # Merge: retrieved (sorted by time) + recent
        retrieved_sorted = sorted(retrieved, key=lambda t: t["timestamp"])
        return retrieved_sorted + recent


class HierarchicalSummaryStrategy:
    """
    Multi-level summary hierarchy for very long conversations.

    Level 0: Raw turns (last 5)
    Level 1: Per-10-turn summaries (last 5 summaries = 50 turns)
    Level 2: Per-50-turn summaries (last 5 summaries = 250 turns)
    Level 3: Global session summary (everything)

    Enables agents to maintain coherence over hundreds of turns
    while keeping context under budget.
    """
    def __init__(self, summarizer_llm, levels: int = 3,
                 turns_per_level: int = 10):
        self.summarizer = summarizer_llm
        self.levels = levels
        self.turns_per_level = turns_per_level

    async def apply(self, history: list[dict]) -> dict:
        result = {"raw_recent": history[-5:]}

        remaining = history[:-5]
        for level in range(1, self.levels + 1):
            chunk_size = self.turns_per_level ** level
            chunks = self._chunk(remaining, chunk_size)
            summaries = []
            for chunk in chunks[-5:]:  # Keep last 5 summaries per level
                summary = await self.summarizer.invoke(
                    f"Summarize these {len(chunk)} conversation turns "
                    f"into a concise paragraph:\n{format_turns(chunk)}"
                )
                summaries.append(summary)
            result[f"level_{level}_summaries"] = summaries
            remaining = remaining[:-(chunk_size * 5)]

        if remaining:
            result["global_summary"] = await self.summarizer.invoke(
                f"Create a comprehensive summary of these "
                f"{len(remaining)} conversation turns:\n"
                f"{format_turns(remaining)}"
            )

        return result
```

### 5.4 Context Optimization for Teams

When a Team Supervisor assembles context for a worker agent, it must avoid context explosion (p. 127):

```python
class TeamContextAssembler:
    """
    Assembles the context for a worker agent within a team,
    combining agent-specific and team-shared context
    while preventing context explosion (p. 127).
    """

    async def assemble_worker_context(
        self,
        worker_agent_id: str,
        task: dict,
        team_memory: TeamMemoryManager,
        agent_memory: AgentMemoryManager,
        max_tokens: int
    ) -> dict:
        """
        Build an optimized context for a worker agent.
        Rule: NEVER pass full team history to workers (p. 127).
        """

        # Budget allocation (% of max_tokens)
        budgets = {
            "system_prompt": 0.15,      # 15% — agent's system prompt
            "task_description": 0.10,   # 10% — current task + constraints
            "plan_context": 0.10,       # 10% — relevant plan steps only
            "team_shared": 0.15,        # 15% — filtered shared context
            "agent_history": 0.20,      # 20% — agent's own recent history
            "knowledge": 0.20,          # 20% — RAG-retrieved knowledge
            "tool_results": 0.10,       # 10% — relevant prior tool results
        }

        context = {}

        # 1. System prompt (always full — protected)
        context["system_prompt"] = agent_memory.get_system_prompt()

        # 2. Task description (current assignment only)
        context["task"] = {
            "description": task["description"],
            "input": task["input"],
            "expected_output_schema": task["output_schema"],
            "constraints": task.get("constraints", [])
        }

        # 3. Plan context — ONLY the steps relevant to this worker
        #    NOT the full plan (prevents context explosion)
        plan = await team_memory.read_shared_context(
            worker_agent_id, keys=["active_plan"]
        )
        if plan and "active_plan" in plan:
            full_plan = plan["active_plan"]["value"]
            context["plan_context"] = self._extract_relevant_steps(
                full_plan, task["step_id"]
            )

        # 4. Team shared context — filtered by relevance to task
        shared = await team_memory.read_shared_context(worker_agent_id)
        if shared:
            relevant_shared = await self._filter_by_relevance(
                shared, task["description"],
                max_tokens=int(max_tokens * budgets["team_shared"])
            )
            context["team_context"] = relevant_shared

        # 5. Agent's own conversation history (optimized)
        context["history"] = await agent_memory.get_conversation_context(
            max_tokens=int(max_tokens * budgets["agent_history"])
        )

        # 6. RAG knowledge retrieval
        knowledge = await agent_memory.query_knowledge(
            query=task["description"],
            top_k=3
        )
        context["knowledge"] = knowledge

        # 7. Relevant prior tool results (from working memory)
        tool_results = await agent_memory.get_working("recent_tool_results")
        if tool_results:
            context["prior_tool_results"] = self._filter_relevant_tools(
                tool_results, task["description"]
            )

        return context

    def _extract_relevant_steps(self, plan: dict,
                                  current_step_id: str) -> dict:
        """
        Extract only: current step, its dependencies, and
        immediate downstream steps. NOT the full plan.
        """
        steps = plan["steps"]
        current = next(s for s in steps if s["id"] == current_step_id)
        dependencies = [s for s in steps if s["id"] in current.get("depends_on", [])]
        downstream = [s for s in steps if current_step_id in s.get("depends_on", [])]

        return {
            "current_step": current,
            "completed_dependencies": [
                {"id": d["id"], "result_summary": d.get("result_summary")}
                for d in dependencies if d["status"] == "completed"
            ],
            "downstream_steps": [
                {"id": d["id"], "description": d["description"]}
                for d in downstream
            ],
            "overall_progress": f"{plan.get('completed_count', 0)}/{len(steps)}"
        }
```

---

## 6. RAG Integration for Agents and Teams

### 6.1 RAG Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      RAG Engine                               │
│                                                               │
│  ┌──────────────┐                                             │
│  │  Ingestion    │  Documents → Chunk → Embed → Store         │
│  │  Pipeline     │  (p. 217)                                  │
│  └──────┬───────┘                                             │
│         │                                                     │
│  ┌──────┴──────────────────────────────────────────────────┐  │
│  │  Knowledge Stores                                        │  │
│  │                                                           │  │
│  │  ┌────────────────┐  ┌────────────────┐  ┌────────────┐  │  │
│  │  │  Platform-wide  │  │  Team-scoped   │  │  Agent-     │  │  │
│  │  │  Knowledge      │  │  Knowledge     │  │  specific   │  │  │
│  │  │                 │  │                 │  │  Knowledge  │  │  │
│  │  │  knowledge:*    │  │  team:X:kb:*   │  │  agent:X:kb │  │  │
│  │  │                 │  │                 │  │             │  │  │
│  │  │  - Product docs │  │  - Task history │  │  - Personal │  │  │
│  │  │  - Policies     │  │  - Domain facts │  │    notes    │  │  │
│  │  │  - API refs     │  │  - Lessons      │  │  - Learned  │  │  │
│  │  │  - FAQ          │  │  - Decisions    │  │    prefs    │  │  │
│  │  └────────────────┘  └────────────────┘  └────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
│         │                                                     │
│  ┌──────┴───────┐                                             │
│  │  Retrieval    │  Query → Embed → Hybrid Search → Re-rank   │
│  │  Pipeline     │  (p. 222-223)                              │
│  └──────┬───────┘                                             │
│         │                                                     │
│  ┌──────┴───────┐                                             │
│  │  Agentic RAG  │  Agent decides WHAT, WHEN, WHERE to        │
│  │  Controller   │  retrieve (p. 227)                         │
│  └──────────────┘                                             │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 Ingestion Pipeline

```python
class RAGIngestionPipeline:
    """
    Ingests documents into the knowledge store.
    Follows RAG best practices (p. 217-225).
    """

    async def ingest(self, document: Document,
                       namespace: str,
                       chunk_config: ChunkConfig | None = None) -> list[str]:
        """
        Split document → embed → store with metadata.
        """
        config = chunk_config or ChunkConfig(
            strategy="paragraph",        # Natural boundaries (p. 218)
            max_chunk_tokens=512,
            overlap_tokens=50,           # Overlap to prevent boundary truncation (p. 218)
        )

        # Step 1: Chunk at natural boundaries (p. 218)
        chunks = self.chunker.chunk(document.content, config)

        # Step 2: Enrich each chunk with source metadata (p. 219)
        enriched = []
        for i, chunk in enumerate(chunks):
            enriched.append({
                "content": chunk.text,
                "metadata": {
                    "source_document": document.title,
                    "source_url": document.url,
                    "source_page": chunk.page_number,
                    "chunk_index": i,
                    "total_chunks": len(chunks),
                    "last_updated": document.updated_at,
                    "namespace": namespace,
                    "content_hash": hash_content(chunk.text)
                }
            })

        # Step 3: Embed and store
        chunk_ids = []
        for chunk_data in enriched:
            embedding = await self.embedding_model.embed(chunk_data["content"])
            chunk_id = await self.vector_store.upsert({
                "id": generate_uuid(),
                "embedding": embedding,
                **chunk_data
            }, namespace=namespace)
            chunk_ids.append(chunk_id)

        # Step 4: Also index for BM25 (hybrid search, p. 222)
        await self.bm25_index.index_batch(enriched, namespace=namespace)

        return chunk_ids


class RAGRetrievalPipeline:
    """
    Retrieves relevant knowledge using hybrid search (p. 222).
    """

    async def retrieve(self, query: str,
                         namespaces: list[str],
                         top_k: int = 5,
                         relevance_threshold: float = 0.7) -> list[RetrievedChunk]:
        """
        Hybrid retrieval: BM25 (keyword) + Vector (semantic) → Re-rank.
        """
        all_results = []

        for namespace in namespaces:
            # BM25 keyword search
            bm25_results = await self.bm25_index.search(
                query, namespace=namespace, top_k=top_k * 2
            )
            # Vector semantic search
            query_embedding = await self.embedding_model.embed(query)
            vector_results = await self.vector_store.search(
                embedding=query_embedding, namespace=namespace, top_k=top_k * 2
            )

            # Merge and deduplicate
            merged = self._reciprocal_rank_fusion(bm25_results, vector_results)
            all_results.extend(merged)

        # Re-rank with cross-encoder (p. 223)
        reranked = await self.reranker.rerank(query, all_results, top_k=top_k)

        # Apply relevance threshold (p. 225)
        relevant = [r for r in reranked if r.score >= relevance_threshold]

        return relevant

    def _reciprocal_rank_fusion(self, *result_lists, k: int = 60) -> list:
        """
        Combine ranked lists using Reciprocal Rank Fusion.
        Standard technique for merging BM25 + vector results.
        """
        scores = {}
        for result_list in result_lists:
            for rank, result in enumerate(result_list):
                doc_id = result["id"]
                scores[doc_id] = scores.get(doc_id, 0) + 1.0 / (k + rank)
        return sorted(scores.items(), key=lambda x: x[1], reverse=True)
```

### 6.3 Agentic RAG

Instead of always retrieving, the agent decides when and what to retrieve (p. 227):

```python
class AgenticRAGController:
    """
    Agent controls its own retrieval strategy.
    Decides: WHAT to retrieve, WHEN to retrieve, WHERE to search (p. 227).
    """

    def __init__(self, retrieval_pipeline: RAGRetrievalPipeline,
                 agent_id: str):
        self.retriever = retrieval_pipeline
        self.agent_id = agent_id

        # Retrieval is exposed as a tool the agent can invoke
        self.retrieval_tool = {
            "name": "search_knowledge",
            "description": (
                "Search the knowledge base for relevant information. "
                "Use when you need factual information, domain knowledge, "
                "or historical context. Do NOT use for simple reasoning "
                "or when you already have sufficient context."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query — be specific"
                    },
                    "sources": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Which knowledge sources to search"
                    },
                    "top_k": {
                        "type": "integer",
                        "default": 5
                    }
                },
                "required": ["query"]
            }
        }

    async def handle_retrieval_call(self, params: dict) -> list[dict]:
        """Called when the agent invokes the search_knowledge tool."""
        # Determine namespaces to search
        namespaces = params.get("sources", self._default_namespaces())

        results = await self.retriever.retrieve(
            query=params["query"],
            namespaces=namespaces,
            top_k=params.get("top_k", 5)
        )

        # Format results with source citations (p. 219)
        return [
            {
                "content": r.content,
                "source": r.metadata["source_document"],
                "page": r.metadata.get("source_page"),
                "relevance_score": r.score,
                "last_updated": r.metadata["last_updated"]
            }
            for r in results
        ]

    def _default_namespaces(self) -> list[str]:
        """Agent's default knowledge sources from its memory config."""
        return [
            f"agent:{self.agent_id}:kb",
            f"team:{self.team_id}:kb",
            "knowledge:platform"
        ]
```

---

## 7. Memory Lifecycle Management

### 7.1 TTL Policies

```python
# Default TTL policies by memory layer and data classification
TTL_POLICIES = {
    MemoryLayer.SESSION: {
        "default": timedelta(minutes=30),   # Auto-expire inactive sessions
        "active": None,                      # No TTL while session active
    },
    MemoryLayer.WORKING: {
        "scratchpad": timedelta(hours=1),
        "tool_results": timedelta(hours=2),
        "conversation_buffer": None,         # Managed by history strategy
        "plan_state": None,                  # Lives until task completes
        "team_coordination": timedelta(hours=4),
    },
    MemoryLayer.LONG_TERM: {
        "user_preferences": timedelta(days=90),
        "conversation_summaries": timedelta(days=30),
        "learned_patterns": timedelta(days=365),
        "task_results": timedelta(days=90),
    },
    MemoryLayer.KNOWLEDGE: {
        "product_catalog": timedelta(hours=24),  # Refresh daily
        "company_policies": timedelta(days=7),   # Refresh weekly
        "api_documentation": timedelta(days=30),
        "team_lessons": timedelta(days=180),
    }
}
```

### 7.2 Memory Garbage Collector

```python
class MemoryGarbageCollector:
    """
    Periodically cleans up expired, orphaned, and oversized memory.
    Enforces TTL policies (p. 154) and privacy compliance.
    """

    async def run_gc_cycle(self) -> GCReport:
        report = GCReport()

        # 1. TTL enforcement — delete expired entries
        expired = await self.find_expired_entries()
        for entry in expired:
            await self.delete_entry(entry)
            report.expired_deleted += 1

        # 2. Orphan cleanup — entries for deleted agents/teams
        orphans = await self.find_orphaned_entries()
        for entry in orphans:
            await self.delete_entry(entry)
            report.orphans_deleted += 1

        # 3. Size enforcement — compact oversized stores
        oversized = await self.find_oversized_stores()
        for store in oversized:
            await self.compact_store(store)
            report.stores_compacted += 1

        # 4. PII sweep — detect and flag/remove PII in non-user scopes
        pii_violations = await self.scan_for_pii_violations()
        for violation in pii_violations:
            await self.handle_pii_violation(violation)
            report.pii_violations += 1

        # 5. Stale knowledge — flag knowledge entries not refreshed
        stale = await self.find_stale_knowledge()
        for entry in stale:
            await self.flag_stale(entry)
            report.stale_flagged += 1

        return report

    async def handle_user_deletion_request(self, user_id: str) -> None:
        """
        GDPR/privacy compliance: delete all user-scoped data.
        Must cascade across all stores.
        """
        # Delete from all layers
        await self.redis.delete_pattern(f"*:user:{user_id}:*")
        await self.pg.delete_where("scope = 'user' AND user_id = %s", user_id)
        await self.vectors.delete_where({"user_id": user_id})

        # Audit log (not deletable — legal requirement)
        await self.audit_log.record({
            "event": "user_data_deletion",
            "user_id": user_id,
            "timestamp": datetime.utcnow().isoformat(),
            "stores_cleaned": ["redis", "postgresql", "vector_store"]
        })
```

### 7.3 Memory Invalidation

```python
class MemoryInvalidator:
    """
    Handles cache and memory invalidation when source data changes.
    """

    async def on_prompt_updated(self, agent_id: str, new_version: str) -> None:
        """Prompt Registry notifies us of a prompt change."""
        # Invalidate any cached context that included the old prompt
        await self.redis.delete(f"agent:{agent_id}:cached_context")
        # Agent's conversation history may reference old prompt behavior
        await self.redis.delete(f"agent:{agent_id}:conversation_history")

    async def on_tool_updated(self, tool_id: str) -> None:
        """MCP Manager notifies us of a tool change."""
        # Invalidate cached tool results (tool behavior may have changed)
        affected_agents = await self.find_agents_using_tool(tool_id)
        for agent_id in affected_agents:
            await self.redis.delete(f"agent:{agent_id}:tool_results:{tool_id}")

    async def on_knowledge_updated(self, namespace: str) -> None:
        """RAG ingestion pipeline notifies us of new knowledge."""
        # Invalidate semantic cache entries that used old knowledge
        await self.cost_manager.invalidate_cache_by_source(namespace)

    async def on_team_reconfigured(self, team_id: str) -> None:
        """Team Orchestrator notifies us of a team config change."""
        # Clear team coordination state (new agents may join/leave)
        await self.redis.delete_pattern(f"team:{team_id}:coordination:*")
        await self.redis.delete_pattern(f"team:{team_id}:claims:*")
```

---

## 8. API Surface

### Memory Management APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/memory/agents/{agent_id}` | Get agent memory summary (all layers) |
| `GET` | `/api/v1/memory/agents/{agent_id}/working` | Get working memory entries |
| `PUT` | `/api/v1/memory/agents/{agent_id}/working/{key}` | Set working memory entry |
| `DELETE` | `/api/v1/memory/agents/{agent_id}/working/{key}` | Delete working memory entry |
| `GET` | `/api/v1/memory/agents/{agent_id}/long-term` | Get long-term memory entries |
| `GET` | `/api/v1/memory/agents/{agent_id}/history` | Get conversation history |
| `POST` | `/api/v1/memory/agents/{agent_id}/history/summarize` | Trigger history summarization |
| `GET` | `/api/v1/memory/teams/{team_id}` | Get team memory summary |
| `GET` | `/api/v1/memory/teams/{team_id}/shared` | Get team shared context |
| `PUT` | `/api/v1/memory/teams/{team_id}/shared/{key}` | Publish to team shared memory |
| `GET` | `/api/v1/memory/teams/{team_id}/decisions` | Get team decision log |
| `GET` | `/api/v1/memory/teams/{team_id}/knowledge` | Query team knowledge base |
| `POST` | `/api/v1/memory/teams/{team_id}/knowledge` | Add to team knowledge base |

### Context Optimization APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/context/optimize` | Optimize context for a given budget |
| `POST` | `/api/v1/context/summarize` | Summarize conversation history |
| `POST` | `/api/v1/context/compress` | Apply Chain-of-Draft compression |
| `GET` | `/api/v1/context/agents/{agent_id}/stats` | Context usage statistics |

### RAG APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/rag/ingest` | Ingest documents into knowledge store |
| `POST` | `/api/v1/rag/search` | Hybrid search across knowledge stores |
| `GET` | `/api/v1/rag/namespaces` | List available knowledge namespaces |
| `GET` | `/api/v1/rag/namespaces/{ns}/stats` | Knowledge store statistics |
| `DELETE` | `/api/v1/rag/namespaces/{ns}/documents/{doc_id}` | Remove document from store |

### Lifecycle APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/memory/gc/run` | Trigger garbage collection cycle |
| `GET` | `/api/v1/memory/gc/report` | Get latest GC report |
| `POST` | `/api/v1/memory/users/{user_id}/delete` | GDPR deletion request |
| `GET` | `/api/v1/memory/health` | Memory subsystem health check |

---

## 9. Failure Modes & Mitigations

| # | Failure Mode | Severity | Detection | Mitigation |
|---|-------------|----------|-----------|------------|
| F1 | **User state bleed** — `user:` data accessed by wrong user | Critical | ACL audit, integration tests | Strict prefix enforcement, per-user isolation (p. 148) |
| F2 | **Context explosion** — full histories passed to workers | High | Token count monitoring per agent call | TeamContextAssembler with budget allocation; never broadcast full history (p. 127) |
| F3 | **Memory staleness** — agent acts on outdated facts | High | Staleness flags, TTL monitoring | TTL enforcement, invalidation on source change (p. 154) |
| F4 | **RAG retrieval failure** — irrelevant chunks returned | High | Relevance score monitoring | Hybrid search + re-ranking + relevance threshold (p. 222-225) |
| F5 | **PII leakage** — PII stored in non-user scope | Critical | PII scanner in GC, guardrail pre-write check | Block writes with PII to non-user scopes (p. 289) |
| F6 | **Redis failure** — working memory unavailable | High | Health checks, connection monitoring | Fallback to in-process memory with reduced capacity |
| F7 | **Vector store failure** — RAG unavailable | Medium | Health checks | Graceful degradation — agent acknowledges knowledge gap (p. 225) |
| F8 | **Summary quality degradation** — bad summaries corrupt context | Medium | Eval of summarization quality | Use LLM-as-Judge on summary quality; rollback on low scores |
| F9 | **Coordination deadlock** — agents waiting on each other's state | High | Timeout monitoring | Atomic claims with TTL, timeout + escalation (p. 127) |
| F10 | **Knowledge chunk boundary truncation** — answer spans two chunks | Medium | Retrieval quality metrics | Overlapping chunks (50-token overlap, p. 218) |

---

## 10. Instrumentation

### Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `memory.read.latency_ms` | Histogram | Memory read latency by layer |
| `memory.write.latency_ms` | Histogram | Memory write latency by layer |
| `memory.hit_rate` | Gauge | Cache hit rate (working memory) |
| `memory.entries.count` | Gauge | Total entries by layer/scope |
| `memory.size_bytes` | Gauge | Storage size by layer |
| `context.tokens.before_optimization` | Histogram | Token count before optimization |
| `context.tokens.after_optimization` | Histogram | Token count after optimization |
| `context.compression_ratio` | Gauge | Optimization effectiveness |
| `context.items_pruned` | Counter | Items dropped by pruning |
| `context.items_summarized` | Counter | Items summarized |
| `rag.retrieval.latency_ms` | Histogram | RAG retrieval latency |
| `rag.retrieval.relevance_score` | Histogram | Mean relevance of retrieved chunks |
| `rag.knowledge_gap_rate` | Gauge | % of queries with no relevant results |
| `team_memory.publish_rate` | Counter | Team shared memory writes/sec |
| `team_memory.read_rate` | Counter | Team shared memory reads/sec |
| `gc.entries_deleted` | Counter | Entries removed by GC |
| `gc.pii_violations` | Counter | PII violations detected |

### Alerts

| Alert | Condition | Severity |
|-------|-----------|----------|
| `MemoryLatencyHigh` | P95 read latency > 50ms | Warning |
| `ContextExplosion` | Any agent call > 2x token budget | Critical |
| `RAGRelevanceDrop` | Mean relevance score < 0.5 for 1h | Warning |
| `PIIViolation` | Any PII detected in non-user scope | Critical |
| `StateBleedDetected` | Cross-user data access attempt | Critical |
| `GCBacklog` | Expired entries > 10,000 | Warning |
| `KnowledgeStale` | Knowledge source not refreshed past TTL | Warning |

---

## 11. Integration with Existing Subsystems

This subsystem fills the gap identified in the original architecture. Here is how it integrates:

| Subsystem | Integration |
|-----------|-------------|
| **ADR-001** | Extends Memory Design table with four layers and extended prefix system |
| **00-System Overview** | Memory & Context Management is now the 10th subsystem in the map |
| **01-Agent Builder** | Agent Definition Schema gains `memory_config` section (§3.3) |
| **02-Team Orchestrator** | Team Definition Schema gains `memory_config` section (§4.4); TeamContextAssembler prevents context explosion |
| **04-Guardrail System** | Guardrails check memory writes for PII and policy violations |
| **05-Observability** | Memory operations emitted as spans; metrics tracked |
| **09-Cost Manager** | Context Optimizer directly reduces token consumption; budget signals trigger pruning aggressiveness |
| **10-Review Checklist** | Memory & State section (§3) now fully addressed with four-layer model |

---

*Pattern References: Memory Management (p. 141-162), RAG (p. 215-228), Resource-Aware Optimization (p. 255-272), Reasoning Techniques (p. 272 — Chain of Draft), Multi-Agent Collaboration (p. 127 — context explosion), Prioritization (p. 321-329 — context item prioritization).*
