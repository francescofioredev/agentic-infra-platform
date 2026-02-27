# Team Orchestrator — Subsystem Design Document

## Contents

| # | Section | Description |
|---|---------|-------------|
| 1 | [Overview & Responsibility](#1-overview--responsibility) | Core mandate, hierarchy position, and design-pattern grounding |
| 2 | [Team Definition Schema](#2-team-definition-schema) | JSON schema for declaring agents, topology, and routing policy |
| 3 | [Supported Topologies](#3-supported-topologies) | Sequential, parallel, router-based, and hierarchical topologies |
| 4 | [Communication Rules Engine](#4-communication-rules-engine) | Intra-team direct calls vs. A2A inter-team protocol selection |
| 5 | [Task Planning & Delegation](#5-task-planning--delegation) | LLM-driven task decomposition and sub-task dispatch to workers |
| 6 | [Parallel Execution Model](#6-parallel-execution-model) | Concurrent sub-task fan-out and synchronisation barriers |
| 7 | [Result Aggregation & Validation](#7-result-aggregation--validation) | Merging worker outputs and validating against the team output schema |
| 8 | [Inter-Team Communication (A2A Protocol)](#8-inter-team-communication-a2a-protocol) | Cross-team HTTP A2A with mTLS + OAuth2 and retry logic |
| 9 | [API Surface](#9-api-surface) | REST endpoints for team creation, dispatch, and status queries |
| 10 | [Failure Modes & Mitigations](#10-failure-modes--mitigations) | Failure taxonomy, retry strategies, and circuit-breaker patterns |
| 11 | [Instrumentation](#11-instrumentation) | OpenTelemetry spans, metrics, and audit events emitted by the orchestrator |

---

## 1. Overview & Responsibility

The **Team Orchestrator** is the core composition engine of the AgentForge platform. It is responsible for assembling individual agents into coordinated teams, defining how those agents communicate, decomposing complex tasks into executable plans, running independent subtasks in parallel, and aggregating results into validated final outputs.

The Team Orchestrator operates at **Level 1** of the platform hierarchy (see System Overview, Section 3.1). It receives dispatched requests from the Level 0 Platform Orchestrator and coordinates Level 2 Worker Agents to fulfill them.

```
                        ┌───────────────────────────┐
                        │  Platform Orchestrator    │  Level 0
                        │  (routes request to team) │
                        └────────────┬──────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
           ┌────────┴─────────┐ ┌────┴──────┐ ┌───────┴────────┐
           │ Team Orchestrator│ │  Team     │ │  Team          │  Level 1
           │  Alpha           │ │  Beta     │ │  Gamma         │
           │  (THIS DOC)      │ │           │ │                │
           └──┬───┬───┬───────┘ └───────────┘ └────────────────┘
              │   │   │
             ┌┘   │   └┐
             A1   A2   A3   Worker Agents                         Level 2
```

**Core responsibilities**:

| Responsibility | Pattern Reference |
|---|---|
| Define team topology and agent roster | Multi-Agent Collaboration (p. 122) |
| Establish communication rules between agents | Multi-Agent Collaboration (p. 124-127) |
| Decompose incoming tasks into structured plans | Planning (p. 107) |
| Route subtasks to the appropriate worker agent | Routing (p. 25) |
| Execute independent subtasks in parallel | Parallelization (p. 46-48) |
| Aggregate and validate results from workers | Parallelization (p. 47), Goal Setting (p. 188) |
| Coordinate with other teams via A2A protocol | A2A Communication (p. 243-248) |
| Handle failures, re-plan, and escalate | Exception Handling (p. 203-209) |

**Design constraint**: The Team Orchestrator handles routing and coordination only. It never executes business logic directly (p. 127). All domain-specific work is delegated to Worker Agents.

---

## 2. Team Definition Schema

Every team is defined by a declarative JSON configuration stored in the platform's persistent state store. This schema drives all orchestration behavior at runtime.

```json
{
  "$schema": "https://agentforge.io/schemas/team-definition/v1.json",
  "team_id": "team-alpha-research",
  "name": "Research & Analysis Team",
  "version": "1.4.0",
  "description": "Conducts multi-source research, synthesizes findings, and produces cited reports.",

  "topology": {
    "type": "supervisor",
    "supervisor_agent_id": "agent-supervisor-alpha",
    "max_hierarchy_depth": 2,
    "allow_agent_to_agent": false
  },

  "agents": [
    {
      "agent_id": "agent-supervisor-alpha",
      "role": "supervisor",
      "name": "ResearchSupervisor",
      "system_prompt_ref": "prompt-registry://research-supervisor@1.4.0",
      "capabilities": ["task_decomposition", "result_aggregation", "quality_review"],
      "input_schema": { "$ref": "#/schemas/research_request" },
      "output_schema": { "$ref": "#/schemas/research_report" },
      "model_tier": "mid",
      "max_iterations": 5
    },
    {
      "agent_id": "agent-web-researcher",
      "role": "worker",
      "name": "WebResearcher",
      "system_prompt_ref": "prompt-registry://web-researcher@2.1.0",
      "capabilities": ["web_search", "content_extraction", "summarization"],
      "tools": ["mcp://search-server/web_search", "mcp://search-server/scrape_url"],
      "input_schema": { "$ref": "#/schemas/search_query" },
      "output_schema": { "$ref": "#/schemas/search_results" },
      "model_tier": "mid",
      "max_iterations": 10
    },
    {
      "agent_id": "agent-data-analyst",
      "role": "worker",
      "name": "DataAnalyst",
      "system_prompt_ref": "prompt-registry://data-analyst@1.2.0",
      "capabilities": ["data_analysis", "chart_generation", "statistical_summary"],
      "tools": ["mcp://data-server/query_db", "mcp://data-server/run_pandas"],
      "input_schema": { "$ref": "#/schemas/analysis_request" },
      "output_schema": { "$ref": "#/schemas/analysis_results" },
      "model_tier": "high",
      "max_iterations": 8
    },
    {
      "agent_id": "agent-report-writer",
      "role": "worker",
      "name": "ReportWriter",
      "system_prompt_ref": "prompt-registry://report-writer@1.0.3",
      "capabilities": ["writing", "citation", "formatting"],
      "tools": ["mcp://doc-server/format_markdown", "mcp://doc-server/generate_pdf"],
      "input_schema": { "$ref": "#/schemas/writing_request" },
      "output_schema": { "$ref": "#/schemas/formatted_report" },
      "model_tier": "high",
      "max_iterations": 5
    }
  ],

  "communication_rules": {
    "default_mode": "sync",
    "timeout_ms": 30000,
    "max_message_size_bytes": 1048576,
    "rules": [
      {
        "from": "agent-supervisor-alpha",
        "to": "agent-web-researcher",
        "mode": "async",
        "priority": "normal",
        "retry_policy": { "max_retries": 2, "backoff_ms": 1000 }
      },
      {
        "from": "agent-supervisor-alpha",
        "to": "agent-data-analyst",
        "mode": "async",
        "priority": "normal",
        "retry_policy": { "max_retries": 2, "backoff_ms": 1000 }
      },
      {
        "from": "agent-supervisor-alpha",
        "to": "agent-report-writer",
        "mode": "sync",
        "priority": "high",
        "retry_policy": { "max_retries": 1, "backoff_ms": 500 }
      }
    ]
  },

  "planning": {
    "strategy": "llm_structured",
    "max_plan_steps": 15,
    "allow_dynamic_replan": true,
    "replan_trigger": "step_failure | goal_drift",
    "max_replans": 3,
    "feasibility_check": true
  },

  "goal": {
    "description": "Produce a comprehensive, cited research report answering the user query.",
    "success_criteria": [
      "report contains >= 3 cited sources",
      "all claims have supporting evidence",
      "report passes quality threshold >= 0.8"
    ],
    "max_iterations": 20,
    "timeout_s": 300
  },

  "guardrail_policies": ["no-pii-output", "citation-required", "no-fabrication"],

  "metadata": {
    "created_at": "2026-01-15T10:30:00Z",
    "updated_at": "2026-02-20T14:22:00Z",
    "owner": "platform-team",
    "tags": ["research", "analysis", "reporting"]
  }
}
```

**Schema validation rules**:
- `topology.max_hierarchy_depth` must not exceed 3 (p. 130).
- Every agent in `agents` must have a unique `agent_id`.
- Every agent must declare explicit `input_schema` and `output_schema` (p. 126).
- The `supervisor` role agent must match `topology.supervisor_agent_id`.
- All `tools` entries must reference registered MCP server endpoints.
- `communication_rules.rules[].from` must be a valid agent within the team.
- `max_iterations` must be set on every agent (p. 188).

---

## 3. Supported Topologies

The Team Orchestrator supports six topology types (p. 122). Each determines how control flow and information pass between agents within the team.

### 3.1 Supervisor Topology (Default)

A single supervisor agent receives all tasks, delegates to workers, and aggregates results. Workers never communicate with each other directly. The supervisor handles routing, not business logic (p. 127).

```
                 ┌─────────────────────┐
                 │     Supervisor      │
                 │  (routes & aggreg.) │
                 └──┬──────┬──────┬────┘
                    │      │      │
               ┌────┘      │      └────┐
               │           │           │
          ┌────┴────┐ ┌────┴────┐ ┌────┴────┐
          │Worker A │ │Worker B │ │Worker C │
          │(search) │ │(analyze)│ │(write)  │
          └─────────┘ └─────────┘ └─────────┘

    Control flow:  Supervisor ──► Worker ──► Supervisor
    Data flow:     Supervisor passes subtask context to worker;
                   worker returns result to supervisor only.
```

**When to use**: Default for most teams. Simple coordination, clear accountability, straightforward debugging.

**Configuration**:
```json
{
  "topology": {
    "type": "supervisor",
    "supervisor_agent_id": "agent-supervisor-alpha",
    "max_hierarchy_depth": 2,
    "allow_agent_to_agent": false
  }
}
```

### 3.2 Network (Decentralized) Topology

All agents can communicate with any other agent. No single coordinator. Agents negotiate task ownership based on capability matching.

```
          ┌─────────┐
          │Agent A  │
          └──┬───┬──┘
             │   │
     ┌───────┘   └───────┐
     │                   │
┌────┴────┐          ┌───┴─────┐
│Agent B  │◄────────►│Agent C  │
└────┬────┘          └───┬─────┘
     │                   │
     └───────┐   ┌───────┘
             │   │
          ┌──┴───┴──┐
          │Agent D  │
          └─────────┘

    Control flow:  Any agent ──► Any agent (peer-to-peer)
    Data flow:     Shared message bus; agents publish/subscribe.
```

**When to use**: Small teams (2-4 agents) where tasks require tight collaboration and agents have overlapping context. Higher complexity; avoid for teams > 5 agents.

**Configuration**:
```json
{
  "topology": {
    "type": "network",
    "max_hops": 3,
    "message_bus": "shared",
    "termination_strategy": "consensus"
  }
}
```

### 3.3 Hierarchical Topology

Multiple levels of supervisors forming a tree. A top-level supervisor delegates to mid-level supervisors, which in turn delegate to workers. Maximum depth: 3 levels (p. 130).

```
                    ┌───────────────────┐
                    │  Top Supervisor   │  Level 0
                    └───────┬───────────┘
                            │
               ┌────────────┼─────────────┐
               │                          │
      ┌────────┴─────────┐     ┌──────────┴──────────┐
      │ Sub-Supervisor A │     │ Sub-Supervisor B    │  Level 1
      └──┬─────────┬─────┘     └──┬─────────┬────────┘
         │         │              │         │
    ┌────┴──┐ ┌────┴──┐     ┌─────┴──┐ ┌────┴──┐
    │Wkr A1 │ │Wkr A2 │     │Wkr B1  │ │Wkr B2 │        Level 2
    └───────┘ └───────┘     └────────┘ └───────┘
```

**When to use**: Large, complex tasks requiring domain specialization at multiple levels. Each sub-supervisor owns a domain (e.g., "research" vs. "writing").

**Configuration**:
```json
{
  "topology": {
    "type": "hierarchical",
    "supervisor_agent_id": "agent-top-supervisor",
    "sub_supervisors": [
      {
        "agent_id": "agent-sub-supervisor-a",
        "workers": ["agent-worker-a1", "agent-worker-a2"]
      },
      {
        "agent_id": "agent-sub-supervisor-b",
        "workers": ["agent-worker-b1", "agent-worker-b2"]
      }
    ],
    "max_hierarchy_depth": 3
  }
}
```

### 3.4 Pipeline Topology

Agents are chained in a fixed sequence. The output of one agent becomes the input of the next. No branching or parallelism within the pipeline itself.

```
  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
  │ Agent A  │────►│ Agent B  │────►│ Agent C  │────►│ Agent D  │
  │ (ingest) │     │(process) │     │(validate)│     │ (output) │
  └──────────┘     └──────────┘     └──────────┘     └──────────┘

    Control flow:  Strictly sequential, left to right.
    Data flow:     Each agent's output_schema matches next agent's input_schema.
```

**When to use**: Deterministic workflows where ordering matters (e.g., extract -> transform -> validate -> format). Maps to Prompt Chaining (p. 1).

**Configuration**:
```json
{
  "topology": {
    "type": "pipeline",
    "stages": [
      { "agent_id": "agent-ingest", "order": 1 },
      { "agent_id": "agent-process", "order": 2 },
      { "agent_id": "agent-validate", "order": 3 },
      { "agent_id": "agent-output", "order": 4 }
    ],
    "gate_between_stages": true
  }
}
```

### 3.5 Voting Topology

Multiple agents process the same input independently, and an aggregator collects and reconciles their outputs via majority voting or weighted scoring (p. 48).

```
                    ┌──────────────┐
                    │  Dispatcher  │
                    └──┬───┬───┬───┘
                       │   │   │           (same input to all)
              ┌────────┘   │   └────────┐
              │            │            │
         ┌────┴────┐   ┌───┴─────┐  ┌───┴─────┐
         │Agent A  │   │Agent B  │  │Agent C  │
         │(model X)│   │(model Y)│  │(model Z)│
         └────┬────┘   └───┬─────┘  └───┬─────┘
              │            │            │
              └────────┐   │   ┌────────┘
                       │   │   │
                    ┌──┴───┴───┴──┐
                    │  Aggregator │     (majority vote / scoring)
                    └─────────────┘
```

**When to use**: High-stakes decisions where correctness matters more than latency. Safety-critical classifications, legal analysis, medical triage.

**Configuration**:
```json
{
  "topology": {
    "type": "voting",
    "voters": ["agent-a", "agent-b", "agent-c"],
    "aggregation_strategy": "majority_vote",
    "min_agreement": 0.66,
    "tiebreak": "highest_confidence"
  }
}
```

### 3.6 Custom Topology

A user-defined directed graph of agent connections. Supports arbitrary communication patterns including conditional edges, loops with termination conditions, and mixed sync/async channels.

```
         ┌──────────┐
         │ Agent A  │──────────────────┐
         └────┬─────┘                  │
              │                        │
         ┌────┴─────┐                  │
         │ Agent B  │─────┐            │
         └────┬─────┘     │            │
              │       ┌───┴─────┐      │
              │       │ Agent D │      │
              │       └───┬─────┘      │
         ┌────┴─────┐     │       ┌────┴─────┐
         │ Agent C  │─────┴──────►│ Agent E  │
         └──────────┘             └──────────┘

    Edges defined explicitly in configuration.
    Supports conditional routing and feedback loops.
```

**Configuration**:
```json
{
  "topology": {
    "type": "custom",
    "edges": [
      { "from": "agent-a", "to": "agent-b", "condition": "always" },
      { "from": "agent-a", "to": "agent-e", "condition": "input.priority == 'urgent'" },
      { "from": "agent-b", "to": "agent-c", "condition": "always" },
      { "from": "agent-b", "to": "agent-d", "condition": "always" },
      { "from": "agent-c", "to": "agent-e", "condition": "always" },
      { "from": "agent-d", "to": "agent-e", "condition": "always" }
    ],
    "entry_point": "agent-a",
    "exit_point": "agent-e",
    "max_loop_iterations": 5
  }
}
```

### Topology Comparison Matrix

| Topology | Complexity | Max Agents | Parallelism | Debuggability | Best For |
|---|---|---|---|---|---|
| Supervisor | Low | 10+ | Via planner | High | General purpose, most teams |
| Network | High | 2-5 | Implicit | Low | Tight collaboration, small teams |
| Hierarchical | Medium | 20+ | Per sub-team | Medium | Large multi-domain tasks |
| Pipeline | Low | 5-8 | None (sequential) | High | Deterministic workflows |
| Voting | Low | 3-7 | Full (all voters) | High | High-stakes decisions |
| Custom | Variable | Any | User-defined | Variable | Specialized workflows |

---

## 4. Communication Rules Engine

The Communication Rules Engine governs how messages flow between agents within a team. It enforces the configured mode (sync, async, streaming), applies retry policies, validates message schemas, and logs all routing decisions (p. 26).

### 4.1 Communication Modes

**Synchronous (sync)**: The calling agent blocks until the target agent returns a response. Used for critical-path dependencies where the caller cannot proceed without the result.

```
Supervisor                      Worker
    │                              │
    │──── delegateTask(payload) ──►│
    │           (blocks)           │
    │                              │──── execute ────►
    │                              │◄─── result ──────
    │◄─── TaskResult(output) ──────│
    │        (resumes)             │
```

**Asynchronous (async)**: The calling agent dispatches the task and continues execution. A callback or polling mechanism retrieves the result later. Used for independent subtasks that can run in parallel.

```
Supervisor                      Worker A           Worker B
    │                              │                   │
    │── dispatchAsync(payload) ───►│                   │
    │── dispatchAsync(payload) ────┼──────────────────►│
    │   (continues immediately)    │                   │
    │                              │── execute ──►     │
    │                              │                   │── execute ──►
    │                              │◄─ result ───      │
    │◄── callback(result_a) ───────│                   │
    │                              │                   │◄─ result ───
    │◄── callback(result_b) ───────┼───────────────────│
    │                              │                   │
```

**Streaming**: The target agent produces output incrementally. Used for long-running tasks where the caller or downstream consumers need partial progress (e.g., report generation, real-time analysis).

```
Supervisor                      Worker
    │                              │
    │── streamTask(payload) ──────►│
    │                              │── begin generation ──►
    │◄── chunk(partial_1) ─────────│
    │◄── chunk(partial_2) ─────────│
    │◄── chunk(partial_3) ─────────│
    │◄── streamEnd(final) ─────────│
    │                              │
```

### 4.2 Message Format

All inter-agent messages within a team use a standardized envelope:

```json
{
  "message_id": "msg-uuid-v4",
  "trace_id": "trace-uuid-v4",
  "span_id": "span-uuid-v4",
  "parent_span_id": "span-uuid-v4-parent",

  "from_agent_id": "agent-supervisor-alpha",
  "to_agent_id": "agent-web-researcher",

  "mode": "async",
  "priority": "normal",
  "timestamp": "2026-02-27T10:15:30.123Z",

  "payload": {
    "task_type": "web_search",
    "input": {
      "query": "renewable energy market trends 2026",
      "max_results": 10,
      "source_filter": ["academic", "news"]
    },
    "context": {
      "original_goal": "Research report on renewable energy investment outlook",
      "plan_step_id": "step-2",
      "depends_on_results": {}
    }
  },

  "metadata": {
    "retry_count": 0,
    "timeout_ms": 30000,
    "schema_version": "1.0"
  }
}
```

**Key design rules**:
- Every message carries `trace_id` and `span_id` for distributed tracing (Observability).
- `context.original_goal` is always included to prevent goal drift (p. 127).
- `payload.input` must conform to the target agent's declared `input_schema` (p. 126).
- Message payloads are validated against schema before dispatch; invalid messages are rejected.

### 4.3 Intra-Team Routing

Within a team, the supervisor routes subtasks to workers using LLM-based routing with confidence thresholds (p. 25). The routing decision considers agent capabilities, current load, and the nature of the subtask.

```python
class IntraTeamRouter:
    """Routes subtasks to the appropriate worker agent within a team.
    Uses LLM-based classification with confidence thresholds (p. 25).
    Always includes a fallback handler (p. 27)."""

    def __init__(self, team_config: TeamDefinition, router_model: str = "haiku"):
        self.team_config = team_config
        self.router_model = router_model  # cheap/fast model for routing (p. 258)
        self.agents = {a.agent_id: a for a in team_config.agents if a.role == "worker"}
        self.confidence_threshold = 0.7

    async def route(self, subtask: SubTask, trace_ctx: TraceContext) -> RoutingDecision:
        """Determine which worker agent should handle a subtask."""

        # Build routing prompt with agent capability descriptions
        agent_descriptions = [
            f"- {a.name} (id={a.agent_id}): capabilities={a.capabilities}"
            for a in self.agents.values()
        ]
        routing_prompt = f"""Given the following subtask, select the best agent to handle it.

Subtask: {subtask.description}
Required capabilities: {subtask.required_capabilities}

Available agents:
{chr(10).join(agent_descriptions)}

Respond with JSON: {{"agent_id": "...", "confidence": 0.0-1.0, "reasoning": "..."}}"""

        # LLM-based routing decision (p. 25)
        response = await llm_call(
            model=self.router_model,
            prompt=routing_prompt,
            response_format="json"
        )

        decision = RoutingDecision.parse(response)

        # Log routing decision for observability (p. 26)
        trace_ctx.log_routing_decision(
            subtask_id=subtask.id,
            selected_agent=decision.agent_id,
            confidence=decision.confidence,
            reasoning=decision.reasoning,
            all_candidates=list(self.agents.keys())
        )

        # Apply confidence threshold; fallback if below (p. 27)
        if decision.confidence < self.confidence_threshold:
            logger.warning(
                f"Low routing confidence ({decision.confidence}) for subtask "
                f"{subtask.id}. Falling back to supervisor self-handling or escalation."
            )
            return RoutingDecision(
                agent_id=self.team_config.topology.supervisor_agent_id,
                confidence=decision.confidence,
                reasoning="Below confidence threshold; escalating to supervisor.",
                is_fallback=True
            )

        return decision
```

---

## 5. Task Planning & Delegation

The Team Orchestrator uses the Planning pattern (p. 101) to decompose incoming tasks into structured, executable plans. Plans are expressed as JSON with explicit dependency declarations (`depends_on`), enabling the execution engine to determine parallelization opportunities and sequencing constraints.

### 5.1 Plan Generation

When the supervisor receives a task, it generates a structured plan using an LLM call. The plan is a DAG (Directed Acyclic Graph) of steps, each assigned to a specific worker agent.

```python
class PlanGenerator:
    """Generates structured execution plans from high-level tasks.
    Produces JSON plans with depends_on fields (p. 107).
    Validates plan feasibility before execution (p. 111)."""

    def __init__(self, team_config: TeamDefinition, planner_model: str = "sonnet"):
        self.team_config = team_config
        self.planner_model = planner_model
        self.router = IntraTeamRouter(team_config)
        self.max_plan_steps = team_config.planning.max_plan_steps

    async def generate_plan(
        self, task: Task, trace_ctx: TraceContext
    ) -> ExecutionPlan:
        """Generate a structured plan for a given task."""

        available_agents = [
            {
                "agent_id": a.agent_id,
                "name": a.name,
                "capabilities": a.capabilities,
                "input_schema": a.input_schema,
                "output_schema": a.output_schema,
            }
            for a in self.team_config.agents
            if a.role == "worker"
        ]

        planning_prompt = f"""Decompose the following task into a structured execution plan.

Task: {task.description}
Goal: {task.goal.description}
Success criteria: {task.goal.success_criteria}

Available worker agents:
{json.dumps(available_agents, indent=2)}

Rules:
- Each step must be assigned to exactly one agent.
- Use "depends_on" to declare step dependencies (list of step_ids).
- Steps with no dependencies can execute in parallel.
- Maximum {self.max_plan_steps} steps.
- Each step input must conform to the assigned agent's input_schema.
- Include a final aggregation step that combines all results.

Respond with a JSON plan:
{{
  "plan_id": "plan-uuid",
  "steps": [
    {{
      "step_id": "step-1",
      "description": "...",
      "agent_id": "...",
      "input": {{ ... }},
      "depends_on": [],
      "expected_output": "...",
      "timeout_ms": 30000
    }}
  ]
}}"""

        response = await llm_call(
            model=self.planner_model,
            prompt=planning_prompt,
            response_format="json"
        )

        plan = ExecutionPlan.parse(response)

        # Validate plan feasibility (p. 111)
        validation = await self._validate_plan(plan, task)
        if not validation.is_feasible:
            trace_ctx.log_event("plan_validation_failed", {
                "plan_id": plan.plan_id,
                "reasons": validation.failure_reasons
            })
            raise PlanInfeasibleError(
                f"Plan {plan.plan_id} failed feasibility check: "
                f"{validation.failure_reasons}"
            )

        trace_ctx.log_event("plan_generated", {
            "plan_id": plan.plan_id,
            "step_count": len(plan.steps),
            "parallel_groups": plan.get_parallel_groups()
        })

        return plan

    async def _validate_plan(
        self, plan: ExecutionPlan, task: Task
    ) -> PlanValidation:
        """Validate plan feasibility before execution (p. 111).
        Checks: agent availability, schema compatibility, dependency
        acyclicity, goal coverage, step count limits."""

        errors = []

        # 1. Check all referenced agents exist in the team
        team_agent_ids = {a.agent_id for a in self.team_config.agents}
        for step in plan.steps:
            if step.agent_id not in team_agent_ids:
                errors.append(f"Step {step.step_id} references unknown agent {step.agent_id}")

        # 2. Check dependency graph is acyclic
        if plan.has_cycle():
            errors.append("Plan dependency graph contains a cycle")

        # 3. Check step count within limits
        if len(plan.steps) > self.max_plan_steps:
            errors.append(
                f"Plan has {len(plan.steps)} steps, exceeding max of {self.max_plan_steps}"
            )

        # 4. Validate input schemas match agent expectations
        for step in plan.steps:
            agent = self._get_agent(step.agent_id)
            if agent and not schema_compatible(step.input, agent.input_schema):
                errors.append(
                    f"Step {step.step_id} input does not match "
                    f"{agent.name} input_schema"
                )

        # 5. Check goal coverage: plan steps should address all success criteria
        coverage = self._check_goal_coverage(plan, task.goal)
        if coverage < 0.8:
            errors.append(
                f"Plan covers only {coverage:.0%} of goal success criteria"
            )

        return PlanValidation(
            is_feasible=len(errors) == 0,
            failure_reasons=errors
        )
```

### 5.2 Plan Data Structure

A generated plan is a DAG where nodes are execution steps and edges are `depends_on` relationships:

```
Example plan for: "Research renewable energy and produce a report"

  step-1: WebSearch("solar energy trends")          depends_on: []
  step-2: WebSearch("wind energy market")           depends_on: []
  step-3: DataAnalysis("energy investment data")    depends_on: []
  step-4: Synthesize(step-1, step-2 results)        depends_on: [step-1, step-2]
  step-5: AnalyzeData(step-3 results)               depends_on: [step-3]
  step-6: WriteReport(step-4, step-5 results)       depends_on: [step-4, step-5]

DAG visualization:

  ┌────────┐   ┌────────┐   ┌────────┐
  │ step-1 │   │ step-2 │   │ step-3 │    Parallel: no dependencies
  └───┬────┘   └───┬────┘   └───┬────┘
      │            │            │
      └─────┬──────┘            │
            │                   │
       ┌────┴────┐          ┌───┴─────┐
       │ step-4  │          │ step-5  │    Parallel: independent groups
       └────┬────┘          └───┬─────┘
            │                   │
            └─────────┬─────────┘
                      │
                 ┌────┴────┐
                 │ step-6  │               Sequential: waits for 4 and 5
                 └─────────┘
```

```json
{
  "plan_id": "plan-a1b2c3",
  "task_id": "task-xyz",
  "steps": [
    {
      "step_id": "step-1",
      "description": "Search for solar energy market trends",
      "agent_id": "agent-web-researcher",
      "input": { "query": "solar energy market trends 2026", "max_results": 10 },
      "depends_on": [],
      "expected_output": "List of search results with summaries",
      "timeout_ms": 30000
    },
    {
      "step_id": "step-2",
      "description": "Search for wind energy market data",
      "agent_id": "agent-web-researcher",
      "input": { "query": "wind energy investment outlook 2026", "max_results": 10 },
      "depends_on": [],
      "expected_output": "List of search results with summaries",
      "timeout_ms": 30000
    },
    {
      "step_id": "step-3",
      "description": "Analyze historical energy investment data",
      "agent_id": "agent-data-analyst",
      "input": { "dataset": "energy_investments", "time_range": "2020-2026" },
      "depends_on": [],
      "expected_output": "Statistical analysis with trends and projections",
      "timeout_ms": 60000
    },
    {
      "step_id": "step-4",
      "description": "Synthesize web research findings",
      "agent_id": "agent-web-researcher",
      "input": { "task": "synthesize", "sources": "$ref:step-1.output,$ref:step-2.output" },
      "depends_on": ["step-1", "step-2"],
      "expected_output": "Synthesized research summary with key findings",
      "timeout_ms": 45000
    },
    {
      "step_id": "step-5",
      "description": "Produce data analysis summary",
      "agent_id": "agent-data-analyst",
      "input": { "task": "summarize", "data": "$ref:step-3.output" },
      "depends_on": ["step-3"],
      "expected_output": "Analysis summary with charts and key metrics",
      "timeout_ms": 45000
    },
    {
      "step_id": "step-6",
      "description": "Write final research report",
      "agent_id": "agent-report-writer",
      "input": {
        "research_findings": "$ref:step-4.output",
        "data_analysis": "$ref:step-5.output",
        "format": "markdown",
        "citation_style": "APA"
      },
      "depends_on": ["step-4", "step-5"],
      "expected_output": "Complete research report with citations",
      "timeout_ms": 60000
    }
  ]
}
```

### 5.3 Dynamic Re-Planning

When a step fails or produces output that invalidates downstream steps, the orchestrator triggers dynamic re-planning (p. 109). Re-planning generates a revised plan that accounts for what has already been completed and what has failed.

```python
class DynamicRePlanner:
    """Handles re-planning when plan execution encounters failures
    or when intermediate results invalidate the current plan (p. 109).
    Preserves completed step results; re-plans only the remaining DAG."""

    def __init__(self, plan_generator: PlanGenerator, max_replans: int = 3):
        self.plan_generator = plan_generator
        self.max_replans = max_replans
        self.replan_count = 0

    async def replan(
        self,
        original_plan: ExecutionPlan,
        execution_state: ExecutionState,
        failure_context: FailureContext,
        trace_ctx: TraceContext,
    ) -> ExecutionPlan:
        """Generate a revised plan incorporating completed results
        and working around the failure."""

        if self.replan_count >= self.max_replans:
            trace_ctx.log_event("replan_limit_reached", {
                "plan_id": original_plan.plan_id,
                "replan_count": self.replan_count
            })
            raise ReplanLimitExceeded(
                f"Reached maximum re-plan attempts ({self.max_replans}). "
                f"Escalating to human review."
            )

        self.replan_count += 1

        completed_steps = execution_state.get_completed_steps()
        failed_step = failure_context.failed_step
        pending_steps = execution_state.get_pending_steps()

        replan_prompt = f"""A plan step has failed. Generate a revised plan for the remaining work.

Original goal: {original_plan.goal}

Completed steps (results available):
{json.dumps([s.to_summary() for s in completed_steps], indent=2)}

Failed step:
  Step ID: {failed_step.step_id}
  Agent: {failed_step.agent_id}
  Error: {failure_context.error_message}
  Error type: {failure_context.error_type}

Pending steps (not yet started):
{json.dumps([s.to_summary() for s in pending_steps], indent=2)}

Generate a revised plan that:
1. Reuses all completed step results (do not re-execute them).
2. Works around the failure (use alternative agents/approaches).
3. Still achieves the original goal.
4. References completed results via $ref:step-N.output syntax."""

        response = await llm_call(
            model=self.plan_generator.planner_model,
            prompt=replan_prompt,
            response_format="json"
        )

        revised_plan = ExecutionPlan.parse(response)

        # Validate the revised plan
        validation = await self.plan_generator._validate_plan(
            revised_plan, execution_state.task
        )
        if not validation.is_feasible:
            raise ReplanFailed(
                f"Revised plan failed feasibility check: {validation.failure_reasons}"
            )

        trace_ctx.log_event("replan_generated", {
            "original_plan_id": original_plan.plan_id,
            "revised_plan_id": revised_plan.plan_id,
            "replan_number": self.replan_count,
            "steps_reused": len(completed_steps),
            "new_steps": len(revised_plan.steps)
        })

        return revised_plan
```

---

## 6. Parallel Execution Model

The Parallel Execution Engine analyzes plan step dependencies to identify groups of steps that can execute concurrently. It verifies task independence (p. 46), manages concurrent execution with bounded concurrency, and handles partial failures through the aggregator (p. 47).

### 6.1 Dependency Analysis and Grouping

The engine partitions plan steps into **execution waves** -- groups of steps whose dependencies have all been satisfied.

```
Plan DAG:
  step-1 (no deps)  step-2 (no deps)  step-3 (no deps)
  step-4 (deps: 1,2)                  step-5 (deps: 3)
  step-6 (deps: 4,5)

Execution waves:
  Wave 0: [step-1, step-2, step-3]   ← all independent, run in parallel
  Wave 1: [step-4, step-5]           ← step-4 waits for 1,2; step-5 waits for 3
  Wave 2: [step-6]                   ← waits for 4,5

Timeline:
  t=0   ┌─step-1─┐  ┌──step-2──┐  ┌─step-3────────────┐
  t=1   └────────┘  └──────────┘  │                   │
  t=2                             └───────────────────┘
  t=3            ┌──step-4──┐           ┌──step-5──┐
  t=4            └──────────┘           └──────────┘
  t=5                    ┌─────step-6─────┐
  t=6                    └────────────────┘
```

### 6.2 Execution Engine

```python
class ParallelExecutionEngine:
    """Executes plan steps in parallel waves, respecting dependency ordering.
    Verifies task independence before parallel dispatch (p. 46).
    Handles partial failures in aggregation (p. 47)."""

    def __init__(
        self,
        team_config: TeamDefinition,
        max_concurrency: int = 10,
        replanner: DynamicRePlanner = None,
    ):
        self.team_config = team_config
        self.max_concurrency = max_concurrency
        self.replanner = replanner
        self.semaphore = asyncio.Semaphore(max_concurrency)

    async def execute_plan(
        self, plan: ExecutionPlan, trace_ctx: TraceContext
    ) -> ExecutionResult:
        """Execute a plan, running independent steps in parallel."""

        state = ExecutionState(plan=plan)
        waves = self._compute_execution_waves(plan)

        trace_ctx.log_event("execution_started", {
            "plan_id": plan.plan_id,
            "total_waves": len(waves),
            "total_steps": len(plan.steps)
        })

        for wave_index, wave in enumerate(waves):
            trace_ctx.log_event("wave_started", {
                "wave_index": wave_index,
                "step_ids": [s.step_id for s in wave]
            })

            # Verify independence: steps in a wave share no mutable state (p. 46)
            self._verify_wave_independence(wave)

            # Execute all steps in the wave concurrently
            results = await asyncio.gather(
                *[self._execute_step(step, state, trace_ctx) for step in wave],
                return_exceptions=True
            )

            # Process results and handle partial failures (p. 47)
            wave_failed = False
            for step, result in zip(wave, results):
                if isinstance(result, Exception):
                    state.mark_failed(step.step_id, result)
                    trace_ctx.log_event("step_failed", {
                        "step_id": step.step_id,
                        "error": str(result),
                        "error_type": type(result).__name__
                    })
                    wave_failed = True
                else:
                    state.mark_completed(step.step_id, result)
                    trace_ctx.log_event("step_completed", {
                        "step_id": step.step_id,
                        "output_size": len(str(result))
                    })

            # If any step in the wave failed, attempt re-planning (p. 109)
            if wave_failed and self.replanner:
                try:
                    revised_plan = await self.replanner.replan(
                        original_plan=plan,
                        execution_state=state,
                        failure_context=state.get_failure_context(),
                        trace_ctx=trace_ctx,
                    )
                    # Restart execution with revised plan, reusing completed results
                    return await self.execute_plan(revised_plan, trace_ctx)
                except (ReplanLimitExceeded, ReplanFailed) as e:
                    trace_ctx.log_event("replan_abandoned", {"reason": str(e)})
                    # Fall through to partial result aggregation

        return ExecutionResult(
            plan_id=plan.plan_id,
            state=state,
            completed_steps=state.get_completed_steps(),
            failed_steps=state.get_failed_steps(),
            is_complete=state.all_steps_completed()
        )

    async def _execute_step(
        self,
        step: PlanStep,
        state: ExecutionState,
        trace_ctx: TraceContext,
    ) -> StepResult:
        """Execute a single plan step with concurrency control."""

        async with self.semaphore:
            # Resolve input references ($ref:step-N.output)
            resolved_input = state.resolve_references(step.input)

            # Validate resolved input against agent schema (p. 126)
            agent = self._get_agent(step.agent_id)
            validate_schema(resolved_input, agent.input_schema)

            # Build message envelope
            message = AgentMessage(
                from_agent_id=self.team_config.topology.supervisor_agent_id,
                to_agent_id=step.agent_id,
                mode=self._get_comm_mode(step.agent_id),
                payload=TaskPayload(
                    task_type=step.description,
                    input=resolved_input,
                    context={
                        "original_goal": state.plan.goal,
                        "plan_step_id": step.step_id,
                    }
                ),
                timeout_ms=step.timeout_ms,
                trace_ctx=trace_ctx.new_child_span(f"step:{step.step_id}")
            )

            # Dispatch to worker agent
            raw_result = await self._dispatch_to_agent(message)

            # Validate output against agent's output_schema (p. 126)
            # Treat sub-agent output as untrusted (p. 126)
            validated_result = self._validate_and_sanitize_output(
                raw_result, agent.output_schema
            )

            return StepResult(
                step_id=step.step_id,
                output=validated_result,
                tokens_used=raw_result.token_usage,
                latency_ms=raw_result.latency_ms,
            )

    def _compute_execution_waves(self, plan: ExecutionPlan) -> list[list[PlanStep]]:
        """Topological sort of plan steps into parallel execution waves."""
        waves = []
        completed = set()
        remaining = list(plan.steps)

        while remaining:
            # Find all steps whose dependencies are fully satisfied
            wave = [
                step for step in remaining
                if all(dep in completed for dep in step.depends_on)
            ]
            if not wave:
                raise CyclicDependencyError("Plan contains unsatisfiable dependencies")

            waves.append(wave)
            for step in wave:
                completed.add(step.step_id)
                remaining.remove(step)

        return waves

    def _verify_wave_independence(self, wave: list[PlanStep]) -> None:
        """Verify steps in a wave do not share mutable state (p. 46).
        Steps targeting the same agent are allowed (agent handles
        concurrency internally), but steps sharing output references
        within the same wave are not."""
        output_refs = set()
        for step in wave:
            refs = self._extract_refs(step.input)
            for ref in refs:
                if ref in output_refs:
                    raise IndependenceViolation(
                        f"Steps in wave share mutable reference: {ref}"
                    )
            output_refs.update(refs)
```

---

## 7. Result Aggregation & Validation

After all plan steps complete (or after partial completion with failures), the orchestrator aggregates results into a final output and validates it against the team's goal criteria (p. 188).

### 7.1 Aggregation Strategies

```python
class ResultAggregator:
    """Aggregates results from completed plan steps into a final output.
    Handles partial failures gracefully (p. 47).
    Validates final output against goal success criteria (p. 188)."""

    def __init__(self, team_config: TeamDefinition, aggregator_model: str = "sonnet"):
        self.team_config = team_config
        self.aggregator_model = aggregator_model

    async def aggregate(
        self,
        execution_result: ExecutionResult,
        task: Task,
        trace_ctx: TraceContext,
    ) -> AggregatedResult:
        """Aggregate step results into final output."""

        completed = execution_result.completed_steps
        failed = execution_result.failed_steps

        # Handle partial failure scenario (p. 47)
        if failed:
            trace_ctx.log_event("partial_failure_aggregation", {
                "completed_count": len(completed),
                "failed_count": len(failed),
                "failed_step_ids": [s.step_id for s in failed]
            })

        # Use LLM to synthesize results into coherent output
        aggregation_prompt = f"""Synthesize the following step results into a final output.

Original task: {task.description}
Goal: {task.goal.description}
Success criteria: {task.goal.success_criteria}

Completed step results:
{self._format_step_results(completed)}

{"Failed steps (incorporate workarounds if possible):" if failed else ""}
{self._format_failed_steps(failed) if failed else ""}

Produce a final output that:
1. Addresses all success criteria that can be met with available results.
2. Clearly indicates if any criteria could not be met due to failures.
3. Cites which step produced each piece of information.
4. Follows the team's output schema."""

        response = await llm_call(
            model=self.aggregator_model,
            prompt=aggregation_prompt
        )

        aggregated = AggregatedResult(
            task_id=task.task_id,
            plan_id=execution_result.plan_id,
            output=response,
            steps_completed=len(completed),
            steps_failed=len(failed),
            is_partial=len(failed) > 0,
        )

        return aggregated

    async def validate_against_goal(
        self,
        result: AggregatedResult,
        task: Task,
        trace_ctx: TraceContext,
    ) -> GoalValidation:
        """Check if the aggregated result meets the defined SMART goal (p. 185).
        Uses goals_met() checker pattern (p. 188)."""

        validation_prompt = f"""Evaluate whether the following output meets the specified goal criteria.

Goal: {task.goal.description}
Success criteria:
{json.dumps(task.goal.success_criteria, indent=2)}

Output to evaluate:
{result.output}

For each criterion, respond with:
{{
  "criteria_results": [
    {{
      "criterion": "...",
      "met": true/false,
      "confidence": 0.0-1.0,
      "evidence": "..."
    }}
  ],
  "overall_met": true/false,
  "quality_score": 0.0-1.0,
  "improvement_suggestions": ["..."]
}}"""

        response = await llm_call(
            model=self.aggregator_model,
            prompt=validation_prompt,
            response_format="json"
        )

        validation = GoalValidation.parse(response)

        trace_ctx.log_event("goal_validation", {
            "task_id": task.task_id,
            "overall_met": validation.overall_met,
            "quality_score": validation.quality_score,
            "criteria_met": sum(1 for c in validation.criteria_results if c.met),
            "criteria_total": len(validation.criteria_results),
        })

        return validation
```

### 7.2 Voting Aggregation (for Voting Topology)

When using the Voting topology (p. 48), multiple agents produce independent outputs for the same input. The aggregator reconciles them:

```python
class VotingAggregator:
    """Aggregates outputs from voting topology agents.
    Supports majority vote, weighted scoring, and unanimous modes (p. 48)."""

    async def aggregate_votes(
        self,
        votes: list[AgentVote],
        strategy: str,
        min_agreement: float,
        trace_ctx: TraceContext,
    ) -> VotingResult:

        if strategy == "majority_vote":
            return self._majority_vote(votes, min_agreement, trace_ctx)
        elif strategy == "weighted_score":
            return self._weighted_score(votes, trace_ctx)
        elif strategy == "unanimous":
            return self._unanimous(votes, trace_ctx)
        else:
            raise ValueError(f"Unknown voting strategy: {strategy}")

    def _majority_vote(
        self,
        votes: list[AgentVote],
        min_agreement: float,
        trace_ctx: TraceContext,
    ) -> VotingResult:
        """Select the output chosen by the majority of voters."""

        # Group votes by normalized answer
        vote_groups = defaultdict(list)
        for vote in votes:
            normalized = self._normalize_answer(vote.output)
            vote_groups[normalized].append(vote)

        # Find majority
        total = len(votes)
        for answer, group in sorted(
            vote_groups.items(), key=lambda x: len(x[1]), reverse=True
        ):
            agreement = len(group) / total
            if agreement >= min_agreement:
                trace_ctx.log_event("voting_result", {
                    "strategy": "majority_vote",
                    "agreement": agreement,
                    "winner_agents": [v.agent_id for v in group],
                    "dissenting_agents": [
                        v.agent_id for v in votes if v not in group
                    ],
                })
                return VotingResult(
                    output=group[0].output,  # representative answer
                    agreement=agreement,
                    is_unanimous=agreement == 1.0,
                    voter_details=votes,
                )

        # No majority reached -- fall back to highest confidence
        best = max(votes, key=lambda v: v.confidence)
        trace_ctx.log_event("voting_no_majority", {
            "fallback": "highest_confidence",
            "selected_agent": best.agent_id,
            "confidence": best.confidence,
        })
        return VotingResult(
            output=best.output,
            agreement=1 / total,
            is_unanimous=False,
            voter_details=votes,
            is_fallback=True,
        )
```

---

## 8. Inter-Team Communication (A2A Protocol)

When a team needs capabilities beyond its own agent roster, it communicates with other teams via the A2A (Agent-to-Agent) protocol (p. 240). Each team exposes an Agent Card that advertises its capabilities, and tasks are exchanged over HTTP with well-defined lifecycle states.

### 8.1 Agent Card (per team)

Every team publishes an Agent Card at `/.well-known/agent.json` (p. 243):

```json
{
  "name": "Research & Analysis Team",
  "description": "Conducts multi-source research and produces cited reports.",
  "url": "https://agentforge.internal/teams/team-alpha-research",
  "version": "1.4.0",
  "capabilities": {
    "inputs": ["research_query", "analysis_request"],
    "outputs": ["research_report", "data_analysis"],
    "streaming": true
  },
  "authentication": {
    "schemes": ["oauth2", "mtls"]
  },
  "interaction_modes": ["sync", "async", "streaming", "webhook"],
  "endpoints": {
    "task_submit": "/a2a/tasks",
    "task_status": "/a2a/tasks/{task_id}",
    "task_cancel": "/a2a/tasks/{task_id}/cancel",
    "stream": "/a2a/tasks/{task_id}/stream"
  }
}
```

### 8.2 A2A Task Lifecycle

Tasks exchanged between teams follow the A2A state machine (p. 245):

```
  ┌───────────┐      ┌───────────┐      ┌───────────────┐
  │ submitted │─────►│  working  │─────►│   completed   │
  └───────────┘      └─────┬─────┘      └───────────────┘
                           │
                           │ (on error)
                           ▼
                     ┌───────────┐
                     │  failed   │
                     └───────────┘

  State transitions:
    submitted  → working     : Team accepts and begins processing
    working    → completed   : Task finishes successfully
    working    → failed      : Unrecoverable error during processing
    Any state  → cancelled   : Requester cancels the task
```

### 8.3 Inter-Team Communication Flow

```python
class InterTeamClient:
    """Communicates with other teams via A2A protocol (p. 240).
    Discovers teams via Agent Cards (p. 243).
    Uses mTLS + OAuth2 authentication (p. 248)."""

    def __init__(self, auth_provider: AuthProvider, team_registry: TeamRegistry):
        self.auth_provider = auth_provider
        self.team_registry = team_registry

    async def discover_team(self, required_capability: str) -> AgentCard:
        """Discover a team that can handle the required capability."""
        cards = await self.team_registry.list_agent_cards()
        for card in cards:
            if required_capability in card.capabilities.inputs:
                return card
        raise TeamNotFound(f"No team found with capability: {required_capability}")

    async def submit_task(
        self,
        target_card: AgentCard,
        task_input: dict,
        interaction_mode: str,
        trace_ctx: TraceContext,
    ) -> A2ATask:
        """Submit a task to another team via A2A protocol (p. 245)."""

        # Obtain OAuth2 token for target team (p. 248)
        token = await self.auth_provider.get_token(
            audience=target_card.url,
            scopes=["task:submit"]
        )

        task_payload = {
            "task_id": str(uuid4()),
            "input": task_input,
            "interaction_mode": interaction_mode,  # one of four modes (p. 246)
            "callback_url": f"{self.self_url}/a2a/callbacks",
            "trace_context": trace_ctx.to_propagation_headers(),
        }

        response = await http_post(
            url=f"{target_card.url}{target_card.endpoints['task_submit']}",
            json=task_payload,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            mtls_cert=self.auth_provider.get_mtls_cert(),  # mTLS (p. 248)
        )

        a2a_task = A2ATask.parse(response)

        trace_ctx.log_event("a2a_task_submitted", {
            "task_id": a2a_task.task_id,
            "target_team": target_card.name,
            "interaction_mode": interaction_mode,
            "state": a2a_task.state,  # should be "submitted"
        })

        return a2a_task

    async def poll_task(
        self,
        target_card: AgentCard,
        task_id: str,
        trace_ctx: TraceContext,
    ) -> A2ATask:
        """Poll task status for async interaction mode (p. 246)."""

        token = await self.auth_provider.get_token(
            audience=target_card.url, scopes=["task:read"]
        )

        response = await http_get(
            url=f"{target_card.url}/a2a/tasks/{task_id}",
            headers={"Authorization": f"Bearer {token}"},
            mtls_cert=self.auth_provider.get_mtls_cert(),
        )

        return A2ATask.parse(response)
```

### 8.4 Four Interaction Modes (p. 246)

| Mode | Description | Use Case |
|---|---|---|
| **Sync** | Submit task, block until response | Quick lookups, simple queries (< 5s) |
| **Async (poll)** | Submit task, poll for status/result | Long-running tasks, batch processing |
| **Async (webhook)** | Submit task, receive result at callback URL | Event-driven architectures, fire-and-forget |
| **Streaming** | Submit task, receive SSE stream of partial results | Report generation, real-time analysis |

---

## 9. API Surface

The Team Orchestrator exposes the following REST API endpoints for platform consumers and the UI.

### 9.1 Team Management

```
POST   /api/v1/teams                      Create a new team
GET    /api/v1/teams                      List all teams (paginated)
GET    /api/v1/teams/{team_id}            Get team definition
PUT    /api/v1/teams/{team_id}            Update team definition
DELETE /api/v1/teams/{team_id}            Delete team (HITL required)
GET    /api/v1/teams/{team_id}/agents     List agents in a team
POST   /api/v1/teams/{team_id}/agents     Add agent to team
DELETE /api/v1/teams/{team_id}/agents/{agent_id}  Remove agent from team
```

### 9.2 Task Execution

```
POST   /api/v1/teams/{team_id}/tasks              Submit a task to a team
GET    /api/v1/teams/{team_id}/tasks/{task_id}     Get task status and result
POST   /api/v1/teams/{team_id}/tasks/{task_id}/cancel  Cancel a running task
GET    /api/v1/teams/{team_id}/tasks/{task_id}/plan    Get the execution plan
GET    /api/v1/teams/{team_id}/tasks/{task_id}/steps   List step statuses
GET    /api/v1/teams/{team_id}/tasks/{task_id}/stream  SSE stream of progress
```

### 9.3 Plan Inspection

```
GET    /api/v1/plans/{plan_id}                 Get plan details
GET    /api/v1/plans/{plan_id}/dag             Get plan DAG (for visualization)
GET    /api/v1/plans/{plan_id}/steps/{step_id} Get individual step details
```

### 9.4 Inter-Team (A2A)

```
GET    /.well-known/agent.json                 Agent Card for team discovery (p. 243)
POST   /a2a/tasks                              Receive task from another team
GET    /a2a/tasks/{task_id}                    Task status query
POST   /a2a/tasks/{task_id}/cancel             Cancel task from external team
GET    /a2a/tasks/{task_id}/stream             SSE stream for external consumers
POST   /a2a/callbacks                          Receive webhook callbacks
```

### 9.5 Key Request/Response Examples

**Submit a task**:

```
POST /api/v1/teams/team-alpha-research/tasks
Content-Type: application/json

{
  "description": "Research the current state of renewable energy investment",
  "input": {
    "query": "Renewable energy investment trends and outlook for 2026-2030",
    "depth": "comprehensive",
    "required_sources": 5
  },
  "goal": {
    "success_criteria": [
      "report contains >= 5 cited sources",
      "includes data analysis with projections",
      "quality_score >= 0.85"
    ]
  },
  "priority": "normal",
  "timeout_s": 300
}
```

**Response**:

```json
{
  "task_id": "task-abc123",
  "team_id": "team-alpha-research",
  "state": "submitted",
  "plan_id": null,
  "created_at": "2026-02-27T10:15:30Z",
  "estimated_completion_s": 120,
  "links": {
    "self": "/api/v1/teams/team-alpha-research/tasks/task-abc123",
    "plan": "/api/v1/teams/team-alpha-research/tasks/task-abc123/plan",
    "stream": "/api/v1/teams/team-alpha-research/tasks/task-abc123/stream"
  }
}
```

---

## 10. Failure Modes & Mitigations

The Team Orchestrator implements the Error Triad (p. 203): **Detect** errors at every boundary, **Classify** them by type, and apply the appropriate **Recovery** strategy (p. 205). Checkpoints preserve progress for safe recovery (p. 209).

### 10.1 Error Classification & Recovery Matrix

| Error Type | Classification | Recovery Strategy | Reference |
|---|---|---|---|
| Worker agent timeout | Transient | Retry with exponential backoff (up to 3 retries) | p. 205 |
| Worker agent returns invalid schema | Logic | Re-prompt the agent with explicit schema correction | p. 205 |
| Worker agent returns low-quality output | Logic | Re-execute step or re-plan with alternative agent | p. 205 |
| LLM API rate limit | Transient | Exponential backoff + model tier fallback | p. 205 |
| LLM API 500 error | Transient | Retry up to 3 times, then fail step | p. 205 |
| Plan step dependency failure | Cascading | Dynamic re-planning (p. 109) to route around failure | p. 209 |
| All retries exhausted | Unrecoverable | Mark step failed; aggregate partial results; escalate | p. 205 |
| Goal not met after max iterations | Unrecoverable | Return partial result with explanation; notify human | p. 188 |
| Cyclic dependency in plan | Logic | Reject plan at validation; request re-generation | p. 111 |
| Inter-team A2A timeout | Transient | Retry; fallback to local agent if available | p. 205 |
| Guardrail violation by worker | Policy | Block output; re-prompt with guardrail feedback | p. 203 |
| Token budget exceeded | Resource | Summarize context and retry with smaller model | p. 262 |

### 10.2 Checkpoint Pattern

The orchestrator checkpoints execution state after each completed wave (p. 209). If a failure occurs mid-execution, the system resumes from the last checkpoint rather than restarting from scratch.

```python
class CheckpointManager:
    """Persists execution state at wave boundaries for crash recovery (p. 209).
    Enables resume-from-checkpoint after transient failures."""

    def __init__(self, state_store: StateStore):
        self.state_store = state_store

    async def save_checkpoint(
        self,
        plan_id: str,
        wave_index: int,
        execution_state: ExecutionState,
    ) -> str:
        """Save checkpoint after a wave completes successfully."""
        checkpoint = Checkpoint(
            checkpoint_id=f"ckpt-{plan_id}-wave-{wave_index}",
            plan_id=plan_id,
            wave_index=wave_index,
            completed_steps={
                s.step_id: s.output for s in execution_state.get_completed_steps()
            },
            failed_steps={
                s.step_id: s.error for s in execution_state.get_failed_steps()
            },
            timestamp=datetime.utcnow(),
        )
        await self.state_store.put(
            key=f"checkpoint:{plan_id}:latest",
            value=checkpoint.to_json(),
            ttl_s=3600  # checkpoints expire after 1 hour
        )
        return checkpoint.checkpoint_id

    async def load_checkpoint(self, plan_id: str) -> Checkpoint | None:
        """Load the latest checkpoint for a plan, if one exists."""
        data = await self.state_store.get(f"checkpoint:{plan_id}:latest")
        if data is None:
            return None
        return Checkpoint.from_json(data)

    async def resume_from_checkpoint(
        self,
        plan: ExecutionPlan,
        checkpoint: Checkpoint,
        engine: ParallelExecutionEngine,
        trace_ctx: TraceContext,
    ) -> ExecutionResult:
        """Resume plan execution from a checkpoint."""
        trace_ctx.log_event("resuming_from_checkpoint", {
            "checkpoint_id": checkpoint.checkpoint_id,
            "wave_index": checkpoint.wave_index,
            "completed_steps": list(checkpoint.completed_steps.keys()),
        })

        # Reconstruct execution state from checkpoint
        state = ExecutionState(plan=plan)
        for step_id, output in checkpoint.completed_steps.items():
            state.mark_completed(step_id, output)
        for step_id, error in checkpoint.failed_steps.items():
            state.mark_failed(step_id, error)

        # Continue execution from next wave
        remaining_waves = engine._compute_execution_waves(plan)
        # Filter to waves that have not been completed
        remaining_waves = [
            wave for wave in remaining_waves
            if any(s.step_id not in checkpoint.completed_steps for s in wave)
        ]

        for wave in remaining_waves:
            # Filter out already-completed steps in partially completed waves
            pending_steps = [
                s for s in wave if s.step_id not in checkpoint.completed_steps
            ]
            if not pending_steps:
                continue

            results = await asyncio.gather(
                *[engine._execute_step(s, state, trace_ctx) for s in pending_steps],
                return_exceptions=True
            )

            for step, result in zip(pending_steps, results):
                if isinstance(result, Exception):
                    state.mark_failed(step.step_id, result)
                else:
                    state.mark_completed(step.step_id, result)

            # Checkpoint after each wave
            await self.save_checkpoint(plan.plan_id, wave.index, state)

        return ExecutionResult(plan_id=plan.plan_id, state=state)
```

### 10.3 Escalation Hierarchy

When the orchestrator cannot recover from a failure automatically, it escalates through a defined hierarchy:

```
  Level 1: Automatic retry (transient errors)
      │
      │ (retries exhausted)
      ▼
  Level 2: Dynamic re-planning (p. 109)
      │
      │ (re-plan limit reached)
      ▼
  Level 3: Partial result aggregation + quality assessment
      │
      │ (quality below threshold)
      ▼
  Level 4: Human escalation (HITL, p. 207)
      │
      │ (human provides guidance)
      ▼
  Level 5: Task marked as failed with full audit trail
```

---

## 11. Instrumentation

The Team Orchestrator emits comprehensive telemetry via OpenTelemetry for tracing, metrics, and structured logging. Every operation produces spans, counters, and log entries that feed into the Observability Platform (Subsystem 5).

### 11.1 Distributed Tracing

Every task execution produces a trace tree that captures the full orchestration flow:

```
Trace: task-abc123
│
├── Span: TeamOrchestrator.handle_task
│   ├── team_id: "team-alpha-research"
│   ├── task_id: "task-abc123"
│   ├── topology: "supervisor"
│   │
│   ├── Span: PlanGenerator.generate_plan
│   │   ├── plan_id: "plan-a1b2c3"
│   │   ├── step_count: 6
│   │   ├── model: "sonnet"
│   │   ├── tokens: {input: 820, output: 450}
│   │   └── latency_ms: 1100
│   │
│   ├── Span: PlanValidator.validate
│   │   ├── is_feasible: true
│   │   └── latency_ms: 50
│   │
│   ├── Span: ExecutionEngine.wave_0
│   │   ├── steps: ["step-1", "step-2", "step-3"]
│   │   ├── parallelism: 3
│   │   │
│   │   ├── Span: Worker.step-1 (WebResearcher)
│   │   │   ├── agent_id: "agent-web-researcher"
│   │   │   ├── tool_calls: ["web_search"]
│   │   │   ├── tokens: {input: 300, output: 600}
│   │   │   ├── status: "completed"
│   │   │   └── latency_ms: 2400
│   │   │
│   │   ├── Span: Worker.step-2 (WebResearcher)
│   │   │   └── ...
│   │   │
│   │   └── Span: Worker.step-3 (DataAnalyst)
│   │       └── ...
│   │
│   ├── Span: ExecutionEngine.wave_1
│   │   └── ...
│   │
│   ├── Span: ExecutionEngine.wave_2
│   │   └── ...
│   │
│   ├── Span: ResultAggregator.aggregate
│   │   ├── completed_steps: 6
│   │   ├── failed_steps: 0
│   │   └── latency_ms: 1800
│   │
│   └── Span: GoalValidator.validate
│       ├── overall_met: true
│       ├── quality_score: 0.91
│       └── criteria_met: "3/3"
│
└── Metadata
    ├── total_tokens: 4200
    ├── total_cost_usd: 0.0062
    ├── total_latency_ms: 8500
    ├── waves_executed: 3
    ├── replans: 0
    └── guardrail_interventions: 0
```

### 11.2 Metrics

The following metrics are emitted as OpenTelemetry instruments:

| Metric | Type | Labels | Description |
|---|---|---|---|
| `team.tasks.submitted` | Counter | `team_id`, `topology` | Tasks submitted to a team |
| `team.tasks.completed` | Counter | `team_id`, `status` | Tasks completed (success/partial/failed) |
| `team.tasks.duration_ms` | Histogram | `team_id`, `topology` | End-to-end task duration |
| `team.plan.steps_total` | Histogram | `team_id` | Number of steps per plan |
| `team.plan.replans` | Counter | `team_id` | Number of dynamic re-plans triggered |
| `team.plan.validation_failures` | Counter | `team_id` | Plans that failed feasibility check |
| `team.execution.wave_count` | Histogram | `team_id` | Waves per plan execution |
| `team.execution.parallelism` | Histogram | `team_id` | Steps per wave (actual parallelism) |
| `team.step.duration_ms` | Histogram | `team_id`, `agent_id`, `step_type` | Individual step duration |
| `team.step.retries` | Counter | `team_id`, `agent_id` | Step-level retries |
| `team.step.failures` | Counter | `team_id`, `agent_id`, `error_type` | Step failures by type |
| `team.routing.decisions` | Counter | `team_id`, `target_agent`, `is_fallback` | Routing decisions made |
| `team.routing.confidence` | Histogram | `team_id` | Routing confidence scores |
| `team.goal.met` | Counter | `team_id`, `met` | Goal validation outcomes |
| `team.goal.quality_score` | Histogram | `team_id` | Quality scores from goal validation |
| `team.a2a.tasks_sent` | Counter | `team_id`, `target_team` | A2A tasks sent to other teams |
| `team.a2a.tasks_received` | Counter | `team_id`, `source_team` | A2A tasks received from other teams |
| `team.a2a.latency_ms` | Histogram | `team_id`, `target_team` | A2A round-trip latency |
| `team.tokens.used` | Counter | `team_id`, `agent_id`, `model` | Tokens consumed per agent |
| `team.checkpoint.saved` | Counter | `team_id` | Checkpoints saved |
| `team.checkpoint.resumed` | Counter | `team_id` | Executions resumed from checkpoint |

### 11.3 Structured Logging

All log entries follow a structured JSON format with consistent fields:

```json
{
  "timestamp": "2026-02-27T10:15:30.123Z",
  "level": "INFO",
  "service": "team-orchestrator",
  "team_id": "team-alpha-research",
  "task_id": "task-abc123",
  "trace_id": "trace-xyz",
  "span_id": "span-abc",
  "event": "plan_generated",
  "attributes": {
    "plan_id": "plan-a1b2c3",
    "step_count": 6,
    "parallel_groups": 3,
    "estimated_duration_ms": 8000
  }
}
```

**Required log events** (minimum set for auditability):

| Event | Level | When |
|---|---|---|
| `task_received` | INFO | Task submitted to team |
| `plan_generated` | INFO | Plan created from task |
| `plan_validation_failed` | WARN | Plan failed feasibility check |
| `wave_started` | DEBUG | Execution wave begins |
| `step_dispatched` | DEBUG | Step sent to worker agent |
| `step_completed` | INFO | Step finished successfully |
| `step_failed` | ERROR | Step failed after all retries |
| `routing_decision` | INFO | Router selected target agent (p. 26) |
| `routing_fallback` | WARN | Router fell back due to low confidence |
| `replan_triggered` | WARN | Dynamic re-planning initiated |
| `replan_generated` | INFO | Revised plan generated |
| `replan_limit_reached` | ERROR | Max re-plans exhausted |
| `aggregation_completed` | INFO | Result aggregation finished |
| `goal_validated` | INFO | Goal validation result |
| `goal_not_met` | WARN | Aggregated result did not meet goal |
| `checkpoint_saved` | DEBUG | Execution state checkpointed |
| `checkpoint_resumed` | INFO | Execution resumed from checkpoint |
| `a2a_task_submitted` | INFO | Task sent to external team |
| `a2a_task_completed` | INFO | External task completed |
| `escalation_triggered` | WARN | Task escalated to human |
| `task_completed` | INFO | Task fully completed |
| `task_failed` | ERROR | Task failed (unrecoverable) |

### 11.4 Alerting Rules

| Alert | Condition | Severity |
|---|---|---|
| High task failure rate | `team.tasks.completed{status=failed}` > 10% over 5m window | Critical |
| Plan generation failing | `team.plan.validation_failures` > 3 in 10m | High |
| Excessive re-planning | `team.plan.replans` > 5 per task (average over 15m) | Medium |
| Routing confidence degradation | P50 `team.routing.confidence` < 0.7 over 30m | Medium |
| Step latency spike | P95 `team.step.duration_ms` > 2x baseline over 10m | High |
| A2A communication failures | `team.a2a.tasks_sent{status=failed}` > 5% over 5m | High |
| Goal satisfaction drop | `team.goal.met{met=false}` > 20% over 1h | Critical |
| Checkpoint resume spike | `team.checkpoint.resumed` > 10 in 30m | Medium |
| Token budget approaching limit | `team.tokens.used` > 80% of team budget | Medium |

---

*This document defines the architecture for Subsystem #2 (Team Orchestrator) of the AgentForge platform. For the full system context, see [00-system-overview.md](./00-system-overview.md). For the architectural decision record, see [ADR-001](../ADR-001-agentic-orchestration-platform.md).*
