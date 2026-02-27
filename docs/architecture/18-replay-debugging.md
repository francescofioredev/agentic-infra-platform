# 18 — Replay & Debugging Subsystem

## 1. Overview & Responsibility

The Replay & Debugging subsystem is the **post-mortem investigation and live debugging layer** of the AgentForge platform. It transforms the raw trace data collected by the Observability Platform (subsystem #5) into an interactive, time-travel-capable debugging environment that allows engineers to understand, reproduce, and diagnose any agent behavior -- past or present.

Without this subsystem, debugging agentic systems is reduced to reading log files and guessing at causality. Multi-step agent executions involving planning, tool calls, guardrail checks, and inter-agent delegation produce execution graphs that are too complex to reason about from logs alone. The Replay & Debugging subsystem provides the structured tools to answer: *What exactly happened? Where did it go wrong? What would have happened if we changed X?*

### Core Responsibilities

| # | Responsibility | Pattern Reference |
|---|---------------|-------------------|
| 1 | **Execution Replay**: Re-run any past agent execution step-by-step from stored traces | Trajectory evaluation (p. 308), LLMInteractionMonitor (p. 310) |
| 2 | **Time-Travel Debugging**: Rewind to any point in an execution and inspect full state | Checkpoint & rollback (p. 209), Memory state snapshots (p. 148) |
| 3 | **What-If Analysis**: Change inputs at any step and observe how outputs diverge | Reflection (p. 61), Prompt Chaining variation (p. 1) |
| 4 | **Diff Mode**: Compare two executions side-by-side | Evaluation & Monitoring (p. 301), A/B testing (p. 306) |
| 5 | **Breakpoints**: Set conditional breakpoints on agent actions for live debugging | Guardrails before_tool_callback (p. 295), Exception handling (p. 201) |
| 6 | **Step-Through Mode**: Advance execution one step at a time with human control | HITL intervention mode (p. 210), Planning step control (p. 107) |
| 7 | **Root Cause Analysis**: Automatically identify why an agent produced a bad output | Reflection critic agent (p. 65), Error classification (p. 205), goals_met() (p. 188) |

### Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                      Replay & Debugging Subsystem                            │
│                                                                              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────────────────┐  │
│  │  Replay Engine   │  │  Time-Travel     │  │  What-If Analyzer         │  │
│  │                  │  │  Debugger        │  │                           │  │
│  │ - Trace loading  │  │                  │  │ - Input mutation          │  │
│  │ - Step playback  │  │ - State snapshot │  │ - Fork-from-step         │  │
│  │ - Mock injection │  │ - Rewind/forward │  │ - Re-execute divergent   │  │
│  │ - Speed control  │  │ - State inspect  │  │ - Outcome comparison     │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────────┬──────────────┘  │
│           │                     │                          │                 │
│  ┌────────┴─────────────────────┴──────────────────────────┴──────────────┐  │
│  │                     Execution Record Store                             │  │
│  │  (Traces + State Snapshots + LLM Interactions + Tool I/O + Decisions) │  │
│  └───────────────────────────────┬────────────────────────────────────────┘  │
│                                  │                                           │
│  ┌──────────────────┐  ┌────────┴─────────┐  ┌───────────────────────────┐  │
│  │  Diff Engine     │  │  Breakpoint      │  │  Root Cause Analyzer      │  │
│  │                  │  │  System          │  │                           │  │
│  │ - Trace align   │  │                  │  │ - Failure trace analysis  │  │
│  │ - Step diff     │  │ - Conditional    │  │ - Critic agent (p. 65)   │  │
│  │ - Output diff   │  │ - Live intercept │  │ - Goal regression detect  │  │
│  │ - Visual render │  │ - Step-through   │  │ - Cascading failure map   │  │
│  └──────────────────┘  └──────────────────┘  └───────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
         │                       │                         │
    ┌────┴────┐            ┌─────┴─────┐            ┌──────┴──────┐
    │ Observ. │            │  Agent    │            │  Evaluation │
    │Platform │            │  Runtime  │            │  Framework  │
    │ (05)    │            │  (01/02)  │            │  (08)       │
    └─────────┘            └───────────┘            └─────────────┘
```

### Relationship to Other Subsystems

| Subsystem | Integration Point |
|-----------|------------------|
| Observability Platform (05) | Primary data source -- all trace data, spans, LLM interactions, decision audit logs consumed by this subsystem |
| Agent Builder (01) | Replay engine re-instantiates agents from versioned definitions; what-if analysis modifies agent configs |
| Team Orchestrator (02) | Full execution graph reconstruction requires team topology and delegation history |
| Guardrail System (04) | Breakpoints hook into guardrail interception points; replay validates guardrail behavior |
| Evaluation Framework (08) | Root cause analysis feeds findings back as regression test cases; diff mode uses eval metrics |
| Memory & Context Management (11) | Time-travel requires state snapshots from the memory layer; replay restores memory state |
| Prompt Registry (07) | What-if analysis swaps prompt versions to test alternative behaviors |
| Cost & Resource Manager (09) | Replay cost tracking to prevent expensive re-executions from exceeding budgets |

---

## 2. Execution Record Schema

The Execution Record is the complete, self-contained artifact that captures everything needed to replay an agent execution. It extends the trace data from the Observability Platform (subsystem #5, section 2) with state snapshots and full LLM interaction payloads required for debugging.

### 2.1 Execution Record Structure

```json
{
  "$schema": "https://agentforge.io/schemas/execution-record/v1",
  "execution_id": "exec-a1b2c3d4",
  "trace_id": "tr-8f3a2b",
  "created_at": "2026-02-27T14:30:00Z",
  "environment": "production",
  "trigger": {
    "type": "user_request",
    "user_id": "user-789",
    "session_id": "sess-456",
    "original_input": "Analyze Q3 revenue trends and create a report"
  },
  "execution_graph": {
    "root_step_id": "step-001",
    "total_steps": 14,
    "total_duration_ms": 5200,
    "total_tokens": { "input": 2420, "output": 1130 },
    "total_cost_usd": 0.0127,
    "goal_met": true
  },
  "steps": [
    {
      "step_id": "step-001",
      "parent_step_id": null,
      "step_type": "platform.route",
      "agent_id": "platform-orchestrator",
      "agent_version": "1.0.0",
      "team_id": null,
      "timestamp_start": "2026-02-27T14:30:00.000Z",
      "timestamp_end": "2026-02-27T14:30:00.180Z",
      "duration_ms": 180,

      "input": {
        "user_message": "Analyze Q3 revenue trends and create a report",
        "context": { "session_history_length": 3 }
      },
      "output": {
        "routing_decision": "team-analytics",
        "confidence": 0.94,
        "reasoning": "Request involves data analysis and report generation"
      },

      "llm_interaction": {
        "model": "haiku",
        "system_prompt_ref": "prompt-registry://platform-router@1.0.0",
        "messages": [ "..." ],
        "raw_response": "...",
        "tokens_in": 320,
        "tokens_out": 45,
        "temperature": 0.0,
        "cost_usd": 0.0001
      },

      "tool_calls": [],
      "guardrail_checks": [],

      "state_snapshot": {
        "snapshot_id": "snap-001",
        "memory_state": {
          "temp:routing_context": "...",
          "agent:platform-orchestrator:history": "..."
        },
        "session_state": { "turn_count": 4 }
      },

      "goal_evaluation": {
        "goal_id": "goal-route-request",
        "criteria": { "valid_team_selected": true, "confidence_above_threshold": true },
        "met": true
      },

      "children": ["step-002"]
    }
  ],
  "errors": [],
  "guardrail_interventions": [],
  "metadata": {
    "recording_version": "1.0.0",
    "platform_version": "2.4.0",
    "replay_compatible": true,
    "estimated_replay_cost_usd": 0.0095
  }
}
```

### 2.2 Step Types

The step types mirror the span types from the Observability Platform (subsystem #5, section 2.2), extended with debugging-specific metadata:

| Step Type | Source Agent | Debugging Extensions |
|-----------|------------|---------------------|
| `platform.route` | Platform Orchestrator | Routing alternatives considered, confidence distribution |
| `team.supervise` | Team Supervisor | Full plan with alternatives, delegation rationale |
| `agent.execute` | Worker Agent | Complete iteration history, all intermediate reasoning |
| `agent.llm_call` | Any agent | Full message history, system prompt, temperature, raw response |
| `agent.tool_call` | Any agent | Tool input/output (full payload, not just size), MCP server metadata |
| `guardrail.check` | Guardrail System | Policy evaluated, evidence gathered, threshold details |
| `goal.evaluate` | Goal tracker | All criteria checked, individual pass/fail per criterion |
| `error.handle` | Exception handler | Full stack trace, classification reasoning, recovery strategy chosen |

### 2.3 State Snapshot Schema

State snapshots are captured at each step boundary to enable time-travel debugging. They build on the Memory & Context Management state model (p. 148) and the checkpoint mechanism from exception handling (p. 209).

```json
{
  "snapshot_id": "snap-003",
  "step_id": "step-003",
  "timestamp": "2026-02-27T14:30:01.200Z",
  "memory_layers": {
    "session": {
      "temp:current_reasoning": "Fetching revenue data...",
      "temp:current_tool_context": { "pending": "sql_query" }
    },
    "working": {
      "agent:data-fetch:scratchpad": "Query plan: SELECT revenue FROM...",
      "agent:data-fetch:tool_cache": {},
      "team:analytics:shared_context": { "plan_progress": 1, "plan_total": 3 }
    },
    "long_term": {
      "user:preferred_format": "executive_summary",
      "app:model_config": { "default_model": "sonnet" }
    }
  },
  "context_window": {
    "messages": [ "..." ],
    "total_tokens": 620,
    "capacity_used_pct": 0.31
  },
  "agent_internal_state": {
    "iteration_count": 1,
    "max_iterations": 10,
    "plan_step_index": 0,
    "pending_tool_calls": []
  },
  "compressed": false,
  "size_bytes": 4096
}
```

### 2.4 Recording Pipeline

Execution records are assembled from the data streams already captured by the Observability Platform. No additional runtime instrumentation is required beyond what subsystem #5 already provides -- the Replay subsystem is a **consumer** of existing telemetry, not a new producer.

```
LLMInteractionMonitor (p. 310)      Observability Platform (05)
        │                                      │
        │  LLM interactions, tool calls,       │  Traces, spans, decisions,
        │  goal evaluations                    │  exceptions, metrics
        │                                      │
        └──────────────┬───────────────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │ Execution Record │
              │ Assembler        │
              │                  │    Joins trace spans with full
              │ - Trace loader   │    LLM payloads and state snapshots
              │ - Snapshot join  │    into a self-contained record
              │ - Payload attach │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │ Execution Record │    Indexed by execution_id, trace_id,
              │ Store            │    agent_id, team_id, time range,
              │ (PostgreSQL +    │    error status, goal outcome
              │  Object Store)   │
              └──────────────────┘
```

**Storage policy**: Full execution records (with LLM payloads and state snapshots) are retained for 30 days in hot storage (PostgreSQL). After 30 days, payloads are migrated to object storage (S3/MinIO) and only the structural skeleton (step graph, timing, metadata) remains in hot storage for 1 year. Records flagged for investigation (`flagged_for_debug: true`) are exempt from TTL.

---

## 3. Replay Engine

The Replay Engine reconstructs and re-plays past agent executions step-by-step. It operates in two modes: **trace replay** (playback from recorded data without making real LLM calls) and **live replay** (re-execute with real LLM calls to verify reproducibility).

### 3.1 Replay Modes

| Mode | LLM Calls | Tool Calls | Cost | Use Case |
|------|-----------|-----------|------|----------|
| **Trace Replay** | Mocked from recorded responses | Mocked from recorded outputs | Zero | Reviewing what happened, stepping through |
| **Live Replay** | Real calls to LLM API | Mocked (safe default) | Token cost | Verifying reproducibility, testing prompt changes |
| **Hybrid Replay** | Real calls for specified steps, mocked for others | Configurable per step | Partial | What-if analysis on specific steps |

### 3.2 Replay Engine Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Replay Engine                             │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Record Loader │  │ Step Executor│  │ Mock Injection Layer │  │
│  │               │  │              │  │                      │  │
│  │ Fetches exec  │  │ Advances one │  │ Replaces real LLM    │  │
│  │ record from   │  │ step at a    │  │ calls and tool calls │  │
│  │ store, builds │  │ time through │  │ with recorded data   │  │
│  │ step DAG      │  │ the DAG      │  │ or synthetic stubs   │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                      │              │
│  ┌──────┴─────────────────┴──────────────────────┴───────────┐  │
│  │                    Replay Runtime                          │  │
│  │  - Agent instantiation from versioned definitions         │  │
│  │  - Memory state restoration from snapshots                │  │
│  │  - Guardrail replay (verify policy evaluation)            │  │
│  │  - Event emission for UI subscribers                      │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                 Replay Speed Controller                    │  │
│  │  - Real-time (1x), Fast (10x, 100x), Instant, Paused     │  │
│  │  - Step-through (manual advance)                          │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Replay Engine Pseudocode

```python
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional, Callable
import uuid
import time
import asyncio


class ReplayMode(Enum):
    TRACE = "trace"      # Mocked responses from recorded data
    LIVE = "live"        # Real LLM calls for reproducibility verification
    HYBRID = "hybrid"    # Per-step override: some live, some mocked


class ReplaySpeed(Enum):
    REALTIME = 1.0       # Reproduce original timing
    FAST_10X = 0.1       # 10x speed
    FAST_100X = 0.01     # 100x speed
    INSTANT = 0.0        # No delay between steps
    PAUSED = -1.0        # Wait for manual advance (step-through)


class StepStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class ReplayStepResult:
    """Result of replaying a single step."""
    step_id: str
    status: StepStatus
    original_output: Any
    replayed_output: Any
    output_match: bool            # True if replayed output matches original
    output_diff: Optional[dict]   # Structured diff if outputs diverge
    duration_ms: float
    original_duration_ms: float
    state_snapshot: dict


@dataclass
class ReplaySession:
    """A complete replay session with its configuration and state."""
    session_id: str
    execution_id: str
    mode: ReplayMode
    speed: ReplaySpeed
    current_step_index: int = 0
    step_results: list[ReplayStepResult] = field(default_factory=list)
    breakpoints: list["Breakpoint"] = field(default_factory=list)
    live_override_steps: set[str] = field(default_factory=set)  # For hybrid mode
    status: str = "initialized"


class ReplayEngine:
    """
    Reconstructs and re-plays past agent executions step-by-step.

    Consumes execution records assembled from the Observability Platform
    (p. 310, LLMInteractionMonitor) and trajectory evaluation data (p. 308).
    Supports trace replay (mocked), live replay (real LLM calls), and
    hybrid replay (per-step override) modes.
    """

    def __init__(
        self,
        execution_store: "ExecutionRecordStore",
        agent_factory: "AgentFactory",        # Instantiates agents from versioned defs
        mock_provider: "MockProvider",         # Injects recorded responses
        event_bus: "EventBus",                 # Publishes replay events to UI
        cost_manager: "CostManager",           # Budget enforcement for live replay
    ):
        self._store = execution_store
        self._agent_factory = agent_factory
        self._mock = mock_provider
        self._events = event_bus
        self._cost = cost_manager
        self._active_sessions: dict[str, ReplaySession] = {}

    async def start_replay(
        self,
        execution_id: str,
        mode: ReplayMode = ReplayMode.TRACE,
        speed: ReplaySpeed = ReplaySpeed.INSTANT,
        start_from_step: Optional[str] = None,
        breakpoints: Optional[list["Breakpoint"]] = None,
        live_override_steps: Optional[set[str]] = None,
    ) -> ReplaySession:
        """
        Initialize a replay session for a past execution.

        Loads the execution record, builds the step DAG, restores the
        initial state snapshot, and prepares mock injection for all
        LLM and tool calls.

        Args:
            execution_id: The execution to replay.
            mode: TRACE (mocked), LIVE (real calls), or HYBRID.
            speed: Playback speed or PAUSED for step-through.
            start_from_step: Skip to a specific step (requires state snapshot).
            breakpoints: Conditional breakpoints that pause execution.
            live_override_steps: Steps to execute live in HYBRID mode.
        """
        # Load the full execution record
        record = await self._store.load_execution_record(execution_id)
        if not record:
            raise ExecutionNotFoundError(f"No execution record: {execution_id}")

        # Validate replay compatibility
        if not record["metadata"]["replay_compatible"]:
            raise ReplayIncompatibleError(
                f"Execution {execution_id} missing required data for replay"
            )

        # Budget check for live replay modes
        if mode in (ReplayMode.LIVE, ReplayMode.HYBRID):
            estimated_cost = record["metadata"]["estimated_replay_cost_usd"]
            budget_ok = await self._cost.check_budget("replay", estimated_cost)
            if not budget_ok:
                raise ReplayBudgetExceededError(
                    f"Estimated replay cost ${estimated_cost:.4f} exceeds budget"
                )

        # Build step DAG from the execution record
        steps = self._build_step_dag(record["steps"])

        # Determine starting point
        start_index = 0
        if start_from_step:
            start_index = self._find_step_index(steps, start_from_step)
            # Restore state from the snapshot at that step
            snapshot = record["steps"][start_index]["state_snapshot"]
            await self._restore_state(snapshot)

        # Register mock providers for trace/hybrid mode
        if mode in (ReplayMode.TRACE, ReplayMode.HYBRID):
            for step in record["steps"]:
                if mode == ReplayMode.TRACE or step["step_id"] not in (live_override_steps or set()):
                    self._mock.register_step_mock(
                        step_id=step["step_id"],
                        llm_response=step.get("llm_interaction", {}).get("raw_response"),
                        tool_outputs={
                            tc["tool_name"]: tc["tool_output"]
                            for tc in step.get("tool_calls", [])
                        },
                    )

        session = ReplaySession(
            session_id=str(uuid.uuid4()),
            execution_id=execution_id,
            mode=mode,
            speed=speed,
            current_step_index=start_index,
            breakpoints=breakpoints or [],
            live_override_steps=live_override_steps or set(),
        )
        session.status = "ready"
        self._active_sessions[session.session_id] = session

        await self._events.publish("replay.session_created", {
            "session_id": session.session_id,
            "execution_id": execution_id,
            "total_steps": len(steps),
            "mode": mode.value,
        })

        return session

    async def advance_step(self, session_id: str) -> ReplayStepResult:
        """
        Execute the next step in the replay session.

        For TRACE mode: injects the recorded LLM response and tool outputs.
        For LIVE mode: makes real LLM calls with the original inputs.
        For HYBRID mode: checks if this step is in the live override set.

        After each step, evaluates breakpoints and emits events to the UI.
        """
        session = self._active_sessions[session_id]
        record = await self._store.load_execution_record(session.execution_id)
        step_data = record["steps"][session.current_step_index]
        step_id = step_data["step_id"]

        session.status = "running"
        await self._events.publish("replay.step_started", {
            "session_id": session_id,
            "step_id": step_id,
            "step_type": step_data["step_type"],
            "step_index": session.current_step_index,
        })

        # Determine execution mode for this step
        use_live = (
            session.mode == ReplayMode.LIVE
            or (session.mode == ReplayMode.HYBRID and step_id in session.live_override_steps)
        )

        start_time = time.monotonic()

        if use_live:
            # Re-instantiate the agent with its versioned definition
            agent = await self._agent_factory.create(
                agent_id=step_data["agent_id"],
                agent_version=step_data["agent_version"],
            )
            # Restore state snapshot from the preceding step
            if step_data["state_snapshot"]:
                await self._restore_state(step_data["state_snapshot"])
            # Execute with real LLM calls but mocked tool calls (safety)
            replayed_output = await agent.execute(
                input_data=step_data["input"],
                mock_tools=True,  # Always mock tools for safety
            )
        else:
            # Trace mode: inject recorded response
            replayed_output = step_data["output"]

        duration_ms = (time.monotonic() - start_time) * 1000

        # Compare outputs
        output_match = self._deep_compare(step_data["output"], replayed_output)
        output_diff = None
        if not output_match:
            output_diff = self._compute_diff(step_data["output"], replayed_output)

        result = ReplayStepResult(
            step_id=step_id,
            status=StepStatus.COMPLETED,
            original_output=step_data["output"],
            replayed_output=replayed_output,
            output_match=output_match,
            output_diff=output_diff,
            duration_ms=duration_ms,
            original_duration_ms=step_data["duration_ms"],
            state_snapshot=step_data["state_snapshot"],
        )

        session.step_results.append(result)
        session.current_step_index += 1

        # Check breakpoints before proceeding
        for bp in session.breakpoints:
            if bp.evaluate(step_data, result):
                session.status = "paused_at_breakpoint"
                await self._events.publish("replay.breakpoint_hit", {
                    "session_id": session_id,
                    "step_id": step_id,
                    "breakpoint_id": bp.breakpoint_id,
                    "condition": bp.condition_description,
                })
                break

        # Apply speed control
        if session.speed == ReplaySpeed.PAUSED:
            session.status = "paused"
        elif session.speed != ReplaySpeed.INSTANT:
            delay = step_data["duration_ms"] / 1000.0 * session.speed.value
            await asyncio.sleep(delay)

        await self._events.publish("replay.step_completed", {
            "session_id": session_id,
            "step_id": step_id,
            "output_match": output_match,
            "duration_ms": duration_ms,
        })

        return result

    async def run_to_completion(self, session_id: str) -> list[ReplayStepResult]:
        """
        Run all remaining steps until completion or a breakpoint is hit.
        Returns the list of all step results.
        """
        session = self._active_sessions[session_id]
        record = await self._store.load_execution_record(session.execution_id)
        total_steps = len(record["steps"])

        while session.current_step_index < total_steps:
            if session.status in ("paused", "paused_at_breakpoint"):
                break
            await self.advance_step(session_id)

        session.status = "completed" if session.current_step_index >= total_steps else session.status
        return session.step_results

    def _build_step_dag(self, steps: list[dict]) -> list[dict]:
        """Build a topologically sorted step DAG from the execution record."""
        # Steps are already stored in execution order; validate parent references
        step_ids = {s["step_id"] for s in steps}
        for step in steps:
            if step["parent_step_id"] and step["parent_step_id"] not in step_ids:
                raise CorruptedRecordError(
                    f"Step {step['step_id']} references missing parent {step['parent_step_id']}"
                )
        return steps

    def _deep_compare(self, original: Any, replayed: Any) -> bool:
        """Deep comparison with tolerance for non-deterministic LLM outputs."""
        if isinstance(original, dict) and isinstance(replayed, dict):
            return all(
                k in replayed and self._deep_compare(original[k], replayed[k])
                for k in original
            )
        if isinstance(original, str) and isinstance(replayed, str):
            # Fuzzy match for LLM outputs -- exact match is unlikely
            return self._semantic_similarity(original, replayed) > 0.90
        return original == replayed

    def _compute_diff(self, original: Any, replayed: Any) -> dict:
        """Compute a structured diff between original and replayed output."""
        return {
            "type": "output_divergence",
            "original_summary": str(original)[:500],
            "replayed_summary": str(replayed)[:500],
            "semantic_similarity": self._semantic_similarity(
                str(original), str(replayed)
            ),
        }

    def _semantic_similarity(self, a: str, b: str) -> float:
        """Compute semantic similarity between two text outputs (embedding cosine)."""
        # Implementation uses embedding model for semantic comparison
        ...

    async def _restore_state(self, snapshot: dict) -> None:
        """
        Restore memory state from a snapshot (p. 148, p. 209).
        Loads session, working, and long-term memory layers.
        """
        for layer_name, entries in snapshot.get("memory_layers", {}).items():
            for key, value in entries.items():
                await self._agent_factory.memory_manager.set(key, value)
```

### 3.4 Mock Injection Layer

The Mock Injection Layer intercepts LLM and tool calls during trace replay and returns the recorded responses. This enables zero-cost replay of past executions.

```python
class MockProvider:
    """
    Provides recorded responses for trace replay mode.

    Intercepts calls to LLM APIs and MCP tool servers, returning
    the exact responses captured during the original execution by
    the LLMInteractionMonitor (p. 310).
    """

    def __init__(self):
        self._llm_mocks: dict[str, str] = {}       # step_id -> raw_response
        self._tool_mocks: dict[str, dict] = {}      # step_id -> {tool_name: output}

    def register_step_mock(
        self,
        step_id: str,
        llm_response: Optional[str],
        tool_outputs: Optional[dict[str, Any]],
    ) -> None:
        if llm_response is not None:
            self._llm_mocks[step_id] = llm_response
        if tool_outputs is not None:
            self._tool_mocks[step_id] = tool_outputs

    async def mock_llm_call(self, step_id: str, **kwargs) -> str:
        """Return recorded LLM response instead of making a real call."""
        if step_id not in self._llm_mocks:
            raise MockNotFoundError(f"No recorded LLM response for step {step_id}")
        return self._llm_mocks[step_id]

    async def mock_tool_call(self, step_id: str, tool_name: str, **kwargs) -> Any:
        """Return recorded tool output instead of calling the real tool."""
        step_tools = self._tool_mocks.get(step_id, {})
        if tool_name not in step_tools:
            raise MockNotFoundError(
                f"No recorded output for tool {tool_name} at step {step_id}"
            )
        return step_tools[tool_name]
```

---

## 4. Time-Travel Debugger

The Time-Travel Debugger allows engineers to rewind to any point in a past execution and inspect the complete state: memory contents, context window, agent internal variables, plan progress, and pending operations. It builds on the checkpoint & rollback pattern (p. 209) and memory state snapshots (p. 148).

### 4.1 Time-Travel Model

```
Execution Timeline
═══════════════════════════════════════════════════════════════════►  time

   step-001      step-002      step-003      step-004      step-005
   ┌──────┐      ┌──────┐      ┌──────┐      ┌──────┐      ┌──────┐
   │Route │─────>│Plan  │─────>│Fetch │─────>│Analyze─────>│Agg.  │
   │      │      │      │      │Data  │      │      │      │      │
   └──────┘      └──────┘      └──────┘      └──────┘      └──────┘
      ▲              ▲              ▲              ▲              ▲
      │              │              │              │              │
   snap-001      snap-002      snap-003      snap-004      snap-005
   ┌──────┐      ┌──────┐      ┌──────┐      ┌──────┐      ┌──────┐
   │State │      │State │      │State │      │State │      │State │
   │ t=0  │      │ t=1  │      │ t=2  │      │ t=3  │      │ t=4  │
   └──────┘      └──────┘      └──────┘      └──────┘      └──────┘

   Debugger can jump to any snapshot and inspect full state.
   "Rewind to step-003" restores snap-003 and positions the
   debugger cursor at the beginning of step-003's execution.
```

### 4.2 State Inspection Capabilities

At any point in the execution, the debugger exposes:

| Inspection Target | Contents | Source |
|-------------------|----------|--------|
| **Memory State** | All memory layers (session, working, long-term, knowledge) | State snapshot (p. 148) |
| **Context Window** | Full message array, token count, capacity used | LLMInteraction record |
| **Agent Config** | System prompt, model, temperature, tools assigned | Agent definition + Prompt Registry (07) |
| **Plan Progress** | Current plan step, completed steps, remaining steps | Team Orchestrator (02) working memory |
| **Tool State** | Pending tool calls, completed results, tool server health | MCP Manager (03) session data |
| **Goal Progress** | goals_met() result, individual criteria, progress toward SMART goal | Goal evaluation (p. 188) |
| **Guardrail State** | Active policies, recent check results, intervention history | Guardrail System (04) |
| **Error Context** | Active exceptions, retry count, recovery strategy | Exception handler state (p. 205) |

### 4.3 Time-Travel Debugger Pseudocode

```python
from dataclasses import dataclass, field
from typing import Any, Optional
from enum import Enum


class CursorPosition(Enum):
    BEFORE_STEP = "before"   # State at step entry, before execution
    AFTER_STEP = "after"     # State at step exit, after execution


@dataclass
class DebuggerCursor:
    """Represents the debugger's current position in the execution timeline."""
    execution_id: str
    step_index: int
    step_id: str
    position: CursorPosition
    timestamp: str


@dataclass
class StateInspection:
    """Complete state inspection at a point in the execution."""
    cursor: DebuggerCursor
    memory_state: dict[str, Any]
    context_window: dict
    agent_config: dict
    plan_progress: Optional[dict]
    goal_progress: Optional[dict]
    pending_tool_calls: list[dict]
    guardrail_state: dict
    error_context: Optional[dict]
    # Derived analysis
    anomalies: list[str]           # Automatically detected issues at this point
    goal_regression_detected: bool  # True if goal progress decreased from prior step


class TimeTravelDebugger:
    """
    Enables rewinding to any point in a past execution to inspect
    and analyze complete agent state.

    Builds on checkpoint & rollback (p. 209) for state restoration
    and memory state snapshots (p. 148) for memory layer inspection.
    Uses goals_met() evaluation (p. 188) to track where goal progress
    stopped or regressed.
    """

    def __init__(
        self,
        execution_store: "ExecutionRecordStore",
        memory_manager: "MemoryManager",
        event_bus: "EventBus",
    ):
        self._store = execution_store
        self._memory = memory_manager
        self._events = event_bus
        self._cursors: dict[str, DebuggerCursor] = {}  # session_id -> cursor

    async def open_session(self, execution_id: str) -> str:
        """
        Open a debugging session for a past execution.
        Returns a session_id for subsequent operations.
        """
        record = await self._store.load_execution_record(execution_id)
        if not record:
            raise ExecutionNotFoundError(execution_id)

        session_id = str(uuid.uuid4())
        # Position cursor at the first step
        first_step = record["steps"][0]
        self._cursors[session_id] = DebuggerCursor(
            execution_id=execution_id,
            step_index=0,
            step_id=first_step["step_id"],
            position=CursorPosition.BEFORE_STEP,
            timestamp=first_step["timestamp_start"],
        )
        return session_id

    async def jump_to_step(
        self,
        session_id: str,
        step_id: str,
        position: CursorPosition = CursorPosition.BEFORE_STEP,
    ) -> StateInspection:
        """
        Jump (rewind or fast-forward) to a specific step in the execution.

        Restores the complete state snapshot at that point, including all
        memory layers (p. 148) and agent internal state. This is the core
        time-travel operation, enabled by the checkpoint mechanism (p. 209).
        """
        cursor = self._cursors[session_id]
        record = await self._store.load_execution_record(cursor.execution_id)

        # Find the target step
        target_index = None
        for i, step in enumerate(record["steps"]):
            if step["step_id"] == step_id:
                target_index = i
                break

        if target_index is None:
            raise StepNotFoundError(f"Step {step_id} not found in execution")

        step_data = record["steps"][target_index]

        # Determine which snapshot to use
        if position == CursorPosition.BEFORE_STEP:
            # Use the snapshot from the end of the preceding step
            if target_index > 0:
                snapshot = record["steps"][target_index - 1]["state_snapshot"]
            else:
                snapshot = step_data["state_snapshot"]  # First step: initial state
        else:
            # AFTER_STEP: use this step's own snapshot
            snapshot = step_data["state_snapshot"]

        # Restore memory state from snapshot (p. 148)
        await self._restore_memory_state(snapshot)

        # Update cursor
        cursor.step_index = target_index
        cursor.step_id = step_id
        cursor.position = position
        cursor.timestamp = (
            step_data["timestamp_start"] if position == CursorPosition.BEFORE_STEP
            else step_data["timestamp_end"]
        )

        # Build complete state inspection
        inspection = await self._build_inspection(record, target_index, position)

        await self._events.publish("debugger.cursor_moved", {
            "session_id": session_id,
            "step_id": step_id,
            "position": position.value,
        })

        return inspection

    async def step_forward(self, session_id: str) -> StateInspection:
        """Advance cursor by one step."""
        cursor = self._cursors[session_id]
        record = await self._store.load_execution_record(cursor.execution_id)

        if cursor.position == CursorPosition.BEFORE_STEP:
            # Move to after the current step
            return await self.jump_to_step(
                session_id, cursor.step_id, CursorPosition.AFTER_STEP
            )
        else:
            # Move to before the next step
            next_index = cursor.step_index + 1
            if next_index >= len(record["steps"]):
                raise EndOfExecutionError("Already at the last step")
            next_step_id = record["steps"][next_index]["step_id"]
            return await self.jump_to_step(
                session_id, next_step_id, CursorPosition.BEFORE_STEP
            )

    async def step_backward(self, session_id: str) -> StateInspection:
        """Rewind cursor by one step."""
        cursor = self._cursors[session_id]
        record = await self._store.load_execution_record(cursor.execution_id)

        if cursor.position == CursorPosition.AFTER_STEP:
            # Move to before the current step
            return await self.jump_to_step(
                session_id, cursor.step_id, CursorPosition.BEFORE_STEP
            )
        else:
            # Move to after the previous step
            prev_index = cursor.step_index - 1
            if prev_index < 0:
                raise BeginningOfExecutionError("Already at the first step")
            prev_step_id = record["steps"][prev_index]["step_id"]
            return await self.jump_to_step(
                session_id, prev_step_id, CursorPosition.AFTER_STEP
            )

    async def inspect_variable(
        self, session_id: str, memory_key: str
    ) -> dict:
        """
        Inspect the value and history of a specific memory variable
        across the entire execution timeline.

        Returns the value at every step where it changed, enabling
        engineers to trace how a piece of state evolved.
        """
        cursor = self._cursors[session_id]
        record = await self._store.load_execution_record(cursor.execution_id)

        history = []
        prev_value = None
        for step in record["steps"]:
            snapshot = step["state_snapshot"]
            current_value = self._extract_from_snapshot(snapshot, memory_key)
            if current_value != prev_value:
                history.append({
                    "step_id": step["step_id"],
                    "step_type": step["step_type"],
                    "timestamp": step["timestamp_start"],
                    "value": current_value,
                    "changed_from": prev_value,
                })
                prev_value = current_value

        return {
            "memory_key": memory_key,
            "current_value": prev_value,
            "change_count": len(history),
            "history": history,
        }

    async def find_anomalies(self, session_id: str) -> list[dict]:
        """
        Scan the entire execution for anomalies: goal regressions,
        unexpected state mutations, guardrail near-misses, and
        unusual latency spikes.

        Uses goals_met() evaluation (p. 188) at each step to detect
        where goal progress stopped or regressed.
        """
        cursor = self._cursors[session_id]
        record = await self._store.load_execution_record(cursor.execution_id)

        anomalies = []
        prev_goal_progress = None

        for i, step in enumerate(record["steps"]):
            # Goal regression detection (p. 188)
            goal_eval = step.get("goal_evaluation")
            if goal_eval and prev_goal_progress is not None:
                if not goal_eval["met"] and prev_goal_progress:
                    anomalies.append({
                        "type": "goal_regression",
                        "step_id": step["step_id"],
                        "step_index": i,
                        "description": (
                            f"Goal progress regressed at step {step['step_id']}: "
                            f"was met, now unmet"
                        ),
                        "severity": "high",
                    })
            if goal_eval:
                prev_goal_progress = goal_eval["met"]

            # Latency spike detection
            if i > 0:
                prev_duration = record["steps"][i - 1]["duration_ms"]
                if step["duration_ms"] > prev_duration * 5 and step["duration_ms"] > 1000:
                    anomalies.append({
                        "type": "latency_spike",
                        "step_id": step["step_id"],
                        "step_index": i,
                        "description": (
                            f"Latency spike: {step['duration_ms']}ms "
                            f"(5x previous step's {prev_duration}ms)"
                        ),
                        "severity": "medium",
                    })

            # Error occurrence
            if step.get("step_type") == "error.handle":
                anomalies.append({
                    "type": "error_occurred",
                    "step_id": step["step_id"],
                    "step_index": i,
                    "description": f"Error handled: {step.get('output', {}).get('error_type', 'unknown')}",
                    "severity": "high",
                })

        return anomalies

    async def _build_inspection(
        self, record: dict, step_index: int, position: CursorPosition
    ) -> StateInspection:
        """Build a complete StateInspection from an execution record and position."""
        step = record["steps"][step_index]
        snapshot = step["state_snapshot"]

        # Detect goal regression
        goal_regression = False
        if step_index > 0:
            prev_goal = record["steps"][step_index - 1].get("goal_evaluation", {})
            curr_goal = step.get("goal_evaluation", {})
            if prev_goal.get("met") and not curr_goal.get("met"):
                goal_regression = True

        # Detect anomalies at this specific step
        anomalies = []
        if goal_regression:
            anomalies.append("Goal progress regressed at this step")
        if step["duration_ms"] > 5000:
            anomalies.append(f"High latency: {step['duration_ms']}ms")

        return StateInspection(
            cursor=self._cursors.get(record["execution_id"]),
            memory_state=snapshot.get("memory_layers", {}),
            context_window=snapshot.get("context_window", {}),
            agent_config={
                "agent_id": step["agent_id"],
                "agent_version": step["agent_version"],
                "llm_model": step.get("llm_interaction", {}).get("model"),
                "system_prompt_ref": step.get("llm_interaction", {}).get("system_prompt_ref"),
            },
            plan_progress=snapshot.get("agent_internal_state", {}).get("plan_step_index"),
            goal_progress=step.get("goal_evaluation"),
            pending_tool_calls=snapshot.get("agent_internal_state", {}).get("pending_tool_calls", []),
            guardrail_state={"checks": step.get("guardrail_checks", [])},
            error_context=step.get("error_context"),
            anomalies=anomalies,
            goal_regression_detected=goal_regression,
        )

    async def _restore_memory_state(self, snapshot: dict) -> None:
        """Restore all memory layers from a snapshot (p. 148, p. 209)."""
        for layer_name, entries in snapshot.get("memory_layers", {}).items():
            for key, value in entries.items():
                await self._memory.set(key, value)

    def _extract_from_snapshot(self, snapshot: dict, key: str) -> Any:
        """Extract a specific memory key from a snapshot across all layers."""
        for layer_name, entries in snapshot.get("memory_layers", {}).items():
            if key in entries:
                return entries[key]
        return None
```

### 4.4 Debugging UI Concept

```
┌──────────────────────────────────────────────────────────────────────────┐
│  AgentForge Debugger — Execution exec-a1b2c3d4                          │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Timeline:  [|◄] [◄] [▶] [►|]  Speed: [1x ▼]   Step 3 of 14           │
│  ═══●═══════●═══════●═══════●═══════●═══════●═══════●═══════►           │
│    001     002     003    [004]    005     006     007                   │
│   Route   Plan   Fetch  Analyze   Agg.   Guard.  Output                 │
│            ▲              ▲                                              │
│            │              └─ Breakpoint: tool_call == "python_exec"      │
│            └─ Anomaly: goal regression detected                         │
│                                                                          │
├─────────────────────────────┬────────────────────────────────────────────┤
│  Step Detail: step-004      │  State Inspector                           │
│  ─────────────────────────  │  ──────────────────────────                │
│  Type: agent.execute        │  Memory State:                             │
│  Agent: AnalysisAgent v2.1  │    temp:current_reasoning:                 │
│  Model: sonnet              │      "Running pandas analysis on Q3..."    │
│  Duration: 3800ms           │    agent:analysis:scratchpad:              │
│  Tokens: 1800 in / 950 out │      "Trend: revenue up 12% YoY"          │
│  Cost: $0.0089              │    team:analytics:shared_context:           │
│                             │      { plan_progress: 2, total: 3 }       │
│  Input:                     │                                            │
│    "Analyze the fetched     │  Context Window:                           │
│     revenue data and        │    Messages: 8                             │
│     identify trends..."     │    Tokens: 1800 / 200000 (0.9%)           │
│                             │                                            │
│  Output:                    │  Goal Progress:                            │
│    "Q3 revenue increased    │    goal: analyze-revenue                   │
│     12% YoY driven by..."  │    criteria:                               │
│                             │      data_analyzed:  [PASS]                │
│  Tool Calls:                │      trends_found:   [PASS]                │
│    1. python_exec           │      report_ready:   [PENDING]             │
│       status: success       │                                            │
│       latency: 1200ms      │  Anomalies: 0                              │
│    2. LLM: interpretation   │                                            │
│       tokens: 2750          │                                            │
│       latency: 2100ms      │                                            │
│                             │                                            │
├─────────────────────────────┴────────────────────────────────────────────┤
│  Variable Watch:                                                         │
│  ┌─────────────────────────────┬──────────────────────────────────────┐  │
│  │ Variable                    │ Value History                        │  │
│  ├─────────────────────────────┼──────────────────────────────────────┤  │
│  │ team:analytics:shared_ctx   │ step-002: {prog:0} → step-003:      │  │
│  │   .plan_progress            │ {prog:1} → step-004: {prog:2}       │  │
│  ├─────────────────────────────┼──────────────────────────────────────┤  │
│  │ agent:analysis:scratchpad   │ step-003: null → step-004:          │  │
│  │                             │ "Trend: revenue up 12% YoY"         │  │
│  └─────────────────────────────┴──────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 5. What-If Analysis

What-If Analysis allows engineers to fork an execution at any step, modify inputs (user message, tool outputs, system prompt, model parameters), and re-execute from that point forward to observe how outputs change. This is the core tool for prompt debugging and understanding agent sensitivity to input variations.

### 5.1 What-If Workflow

```
Original Execution:
  step-001 ──> step-002 ──> step-003 ──> step-004 ──> step-005
                               │
                               │  Fork here with modified input
                               ▼
What-If Fork:                step-003' ──> step-004' ──> step-005'
                             (modified     (live re-     (divergent
                              input)        execution)    output)

Comparison:
  Original step-005 output  vs.  What-if step-005' output
  "Revenue up 12% YoY..."       "Revenue up 12% YoY, with seasonal
                                  adjustment showing 8% real growth..."
```

### 5.2 Modifiable Parameters

| Parameter | Scope | Example |
|-----------|-------|---------|
| **User input** | Per-step | Change the query text at a specific step |
| **System prompt** | Per-agent | Swap to a different prompt version from the Prompt Registry (07) |
| **Model** | Per-step | Switch from `sonnet` to `haiku` or `opus` |
| **Temperature** | Per-step | Change from 0.0 to 0.7 to test creativity |
| **Tool output** | Per-tool-call | Inject a different tool result (e.g., different SQL data) |
| **Memory state** | Per-step | Modify working memory before a step executes |
| **Guardrail policy** | Per-step | Add/remove policies to test guardrail effects |

### 5.3 What-If Analyzer Pseudocode

```python
from dataclasses import dataclass, field
from typing import Any, Optional
import uuid
import copy


@dataclass
class WhatIfMutation:
    """A single modification to apply at the fork point."""
    target: str          # "input", "system_prompt", "model", "temperature",
                         # "tool_output", "memory", "guardrail_policy"
    step_id: str         # Step to modify
    key: Optional[str]   # Sub-key (e.g., memory key, tool name)
    original_value: Any
    new_value: Any


@dataclass
class WhatIfScenario:
    """A complete what-if scenario with mutations and results."""
    scenario_id: str
    execution_id: str
    fork_step_id: str
    mutations: list[WhatIfMutation]
    original_steps: list[dict]     # Steps from fork point to end (original)
    forked_steps: list[dict]       # Steps from fork point to end (re-executed)
    comparison: "WhatIfComparison"
    cost_usd: float


@dataclass
class WhatIfComparison:
    """Side-by-side comparison of original vs. forked execution."""
    final_output_match: bool
    semantic_similarity: float
    step_by_step_diffs: list[dict]
    goal_outcome_original: bool
    goal_outcome_forked: bool
    total_cost_diff_usd: float
    total_latency_diff_ms: float
    summary: str


class WhatIfAnalyzer:
    """
    Enables what-if analysis by forking an execution at any step,
    applying mutations, and re-executing from that point forward.

    Uses the Replay Engine for state restoration and the Agent Factory
    for live re-execution. Builds on Reflection patterns (p. 61) for
    comparing alternative outcomes and Prompt Chaining (p. 1) for
    understanding how input changes propagate through the execution chain.
    """

    def __init__(
        self,
        execution_store: "ExecutionRecordStore",
        replay_engine: "ReplayEngine",
        agent_factory: "AgentFactory",
        cost_manager: "CostManager",
        event_bus: "EventBus",
    ):
        self._store = execution_store
        self._replay = replay_engine
        self._agent_factory = agent_factory
        self._cost = cost_manager
        self._events = event_bus

    async def create_scenario(
        self,
        execution_id: str,
        fork_step_id: str,
        mutations: list[WhatIfMutation],
        max_budget_usd: float = 1.0,
    ) -> WhatIfScenario:
        """
        Create and execute a what-if scenario.

        1. Load the original execution record.
        2. Find the fork point and restore state from its snapshot (p. 209).
        3. Apply mutations to the inputs/config at the fork step.
        4. Re-execute from the fork point to completion using live LLM calls.
        5. Compare the forked execution against the original.

        Args:
            execution_id: The original execution to fork from.
            fork_step_id: The step at which to apply mutations and diverge.
            mutations: List of parameter changes to apply.
            max_budget_usd: Maximum cost allowed for the re-execution.
        """
        record = await self._store.load_execution_record(execution_id)

        # Find fork step index
        fork_index = None
        for i, step in enumerate(record["steps"]):
            if step["step_id"] == fork_step_id:
                fork_index = i
                break

        if fork_index is None:
            raise StepNotFoundError(f"Fork step {fork_step_id} not found")

        # Estimate cost of re-executing remaining steps
        remaining_steps = record["steps"][fork_index:]
        estimated_cost = sum(
            s.get("llm_interaction", {}).get("cost_usd", 0)
            for s in remaining_steps
        )
        if estimated_cost > max_budget_usd:
            raise WhatIfBudgetExceededError(
                f"Estimated cost ${estimated_cost:.4f} exceeds budget ${max_budget_usd:.4f}"
            )

        # Restore state at the fork point using checkpoint/rollback (p. 209)
        if fork_index > 0:
            pre_fork_snapshot = record["steps"][fork_index - 1]["state_snapshot"]
            await self._replay._restore_state(pre_fork_snapshot)
        else:
            # Forking from the first step -- use initial state
            await self._replay._restore_state(record["steps"][0]["state_snapshot"])

        # Apply mutations to create the forked step
        forked_step_data = copy.deepcopy(record["steps"][fork_index])
        for mutation in mutations:
            self._apply_mutation(forked_step_data, mutation)

        # Re-execute from the fork point forward
        forked_results = []
        current_input = forked_step_data["input"]
        actual_cost = 0.0

        for i, original_step in enumerate(remaining_steps):
            step_input = current_input if i == 0 else None

            # Instantiate the agent for this step
            agent = await self._agent_factory.create(
                agent_id=original_step["agent_id"],
                agent_version=original_step["agent_version"],
            )

            # Apply any step-specific mutations (e.g., model, temperature)
            step_config = self._get_step_config(original_step, mutations)

            # Execute the step live
            result = await agent.execute(
                input_data=step_input or original_step["input"],
                model=step_config.get("model"),
                temperature=step_config.get("temperature"),
                system_prompt_ref=step_config.get("system_prompt_ref"),
            )

            forked_results.append({
                "step_id": f"{original_step['step_id']}-forked",
                "original_step_id": original_step["step_id"],
                "input": step_input or original_step["input"],
                "output": result,
                "cost_usd": self._estimate_step_cost(result),
            })

            actual_cost += forked_results[-1]["cost_usd"]
            if actual_cost > max_budget_usd:
                # Abort early if budget exceeded
                break

            # Feed this step's output as the next step's input
            current_input = result

        # Compare original vs. forked execution
        comparison = self._compare_executions(remaining_steps, forked_results)

        scenario = WhatIfScenario(
            scenario_id=str(uuid.uuid4()),
            execution_id=execution_id,
            fork_step_id=fork_step_id,
            mutations=mutations,
            original_steps=remaining_steps,
            forked_steps=forked_results,
            comparison=comparison,
            cost_usd=actual_cost,
        )

        await self._events.publish("whatif.scenario_completed", {
            "scenario_id": scenario.scenario_id,
            "execution_id": execution_id,
            "fork_step_id": fork_step_id,
            "mutation_count": len(mutations),
            "output_match": comparison.final_output_match,
            "cost_usd": actual_cost,
        })

        return scenario

    def _apply_mutation(self, step_data: dict, mutation: WhatIfMutation) -> None:
        """Apply a single mutation to a step's data."""
        if mutation.target == "input":
            step_data["input"] = mutation.new_value
        elif mutation.target == "system_prompt":
            step_data["llm_interaction"]["system_prompt_ref"] = mutation.new_value
        elif mutation.target == "model":
            step_data["llm_interaction"]["model"] = mutation.new_value
        elif mutation.target == "temperature":
            step_data["llm_interaction"]["temperature"] = mutation.new_value
        elif mutation.target == "tool_output":
            for tc in step_data.get("tool_calls", []):
                if tc["tool_name"] == mutation.key:
                    tc["tool_output"] = mutation.new_value
        elif mutation.target == "memory":
            snapshot = step_data.get("state_snapshot", {})
            for layer in snapshot.get("memory_layers", {}).values():
                if mutation.key in layer:
                    layer[mutation.key] = mutation.new_value

    def _get_step_config(
        self, original_step: dict, mutations: list[WhatIfMutation]
    ) -> dict:
        """Extract configuration overrides for a specific step from mutations."""
        config = {}
        for m in mutations:
            if m.step_id == original_step["step_id"]:
                if m.target in ("model", "temperature", "system_prompt_ref"):
                    config[m.target] = m.new_value
        return config

    def _compare_executions(
        self, original_steps: list[dict], forked_steps: list[dict]
    ) -> WhatIfComparison:
        """
        Build a side-by-side comparison of original vs. forked execution.
        Uses semantic similarity for LLM output comparison and exact
        match for structured data.
        """
        step_diffs = []
        for orig, forked in zip(original_steps, forked_steps):
            diff = {
                "step_id": orig["step_id"],
                "output_match": orig["output"] == forked["output"],
                "semantic_similarity": self._semantic_similarity(
                    str(orig["output"]), str(forked["output"])
                ),
            }
            step_diffs.append(diff)

        final_orig = original_steps[-1]["output"] if original_steps else None
        final_forked = forked_steps[-1]["output"] if forked_steps else None
        final_match = final_orig == final_forked
        final_similarity = self._semantic_similarity(
            str(final_orig), str(final_forked)
        )

        orig_goal = original_steps[-1].get("goal_evaluation", {}).get("met", False) if original_steps else False
        forked_goal = False  # Goal evaluation on forked execution

        total_orig_cost = sum(s.get("llm_interaction", {}).get("cost_usd", 0) for s in original_steps)
        total_forked_cost = sum(s.get("cost_usd", 0) for s in forked_steps)

        total_orig_latency = sum(s.get("duration_ms", 0) for s in original_steps)
        total_forked_latency = sum(s.get("duration_ms", 0) for s in forked_steps)

        return WhatIfComparison(
            final_output_match=final_match,
            semantic_similarity=final_similarity,
            step_by_step_diffs=step_diffs,
            goal_outcome_original=orig_goal,
            goal_outcome_forked=forked_goal,
            total_cost_diff_usd=total_forked_cost - total_orig_cost,
            total_latency_diff_ms=total_forked_latency - total_orig_latency,
            summary=(
                f"What-if analysis: final outputs {'match' if final_match else 'diverge'} "
                f"(similarity: {final_similarity:.2%}). "
                f"Cost delta: ${total_forked_cost - total_orig_cost:+.4f}. "
                f"Latency delta: {total_forked_latency - total_orig_latency:+.0f}ms."
            ),
        )

    def _semantic_similarity(self, a: str, b: str) -> float:
        """Compute semantic similarity between two texts."""
        ...
```

---

## 6. Diff Mode

Diff Mode provides side-by-side comparison of two complete executions. This is the primary tool for understanding the impact of prompt changes, model upgrades, and configuration modifications. It extends the A/B testing concept (p. 306) to individual execution comparison at the step level.

### 6.1 Diff Types

| Diff Type | Use Case | Example |
|-----------|----------|---------|
| **Execution Diff** | Compare two runs of the same input with different configs | Old prompt v2.3 vs. new prompt v2.4 |
| **Version Diff** | Compare an agent across versions for the same evalset case | ResearchAgent@2.3 vs. ResearchAgent@2.4 |
| **Model Diff** | Same execution with different models | Haiku vs. Sonnet for the same routing decision |
| **Temporal Diff** | Same agent, same input, different points in time | Monday's execution vs. Friday's execution |

### 6.2 Diff Algorithm

The diff engine aligns steps between two executions using the step type and agent ID as the matching key. Steps that exist in one execution but not the other are flagged as insertions or deletions.

```
Execution A (baseline):           Execution B (comparison):
  step-001: platform.route          step-001: platform.route
  step-002: team.supervise          step-002: team.supervise
  step-003: agent.execute(A1)       step-003: agent.execute(A1)
  step-004: agent.execute(A2)       step-004: agent.execute(A2)
                                    step-004b: agent.execute(A2)  ← EXTRA (retry)
  step-005: aggregation             step-005: aggregation
  step-006: guardrail.check         step-006: guardrail.check

Alignment:
  A:step-001 ↔ B:step-001   [match]   output similarity: 100%
  A:step-002 ↔ B:step-002   [match]   output similarity: 95%
  A:step-003 ↔ B:step-003   [match]   output similarity: 87%
  A:step-004 ↔ B:step-004   [match]   output similarity: 62%  ← DIVERGENCE
             ← B:step-004b  [insert]  (extra retry in B)
  A:step-005 ↔ B:step-005   [match]   output similarity: 71%
  A:step-006 ↔ B:step-006   [match]   output similarity: 100%
```

### 6.3 Diff Visualization

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Diff Mode — exec-a1b2 (baseline) vs. exec-x7y8 (comparison)           │
├──────────────────────────────┬───────────────────────────────────────────┤
│  Baseline: exec-a1b2         │  Comparison: exec-x7y8                   │
│  Agent: ResearchAgent@2.3    │  Agent: ResearchAgent@2.4                │
│  Model: sonnet               │  Model: sonnet                           │
│  Date: 2026-02-25            │  Date: 2026-02-27                        │
├──────────────────────────────┴───────────────────────────────────────────┤
│                                                                          │
│  Summary:                                                                │
│    Steps matched: 6/6          Output similarity: 84%                   │
│    Extra steps in B: 1         Goal met: A=YES  B=YES                   │
│    Cost: A=$0.012  B=$0.018    Latency: A=5200ms  B=7100ms             │
│                                                                          │
├──────────────────────────────┬───────────────────────────────────────────┤
│  step-004: AnalysisAgent     │  step-004: AnalysisAgent                 │
│  ─────────────────────────── │  ───────────────────────────────────────  │
│                              │                                           │
│  Input:                      │  Input:                                   │
│  "Analyze the fetched        │  "Analyze the fetched                     │
│   revenue data..."           │   revenue data..."                        │
│                              │                                           │
│  Output:                     │  Output:                                  │
│  "Q3 revenue increased       │  "Q3 revenue increased                    │
│ - 12% YoY driven by          │ + 12% YoY. After seasonal                │
│ - enterprise segment          │ + adjustment, real growth                 │
│ - growth."                    │ + was 8%, primarily driven by            │
│                               │ + enterprise segment expansion           │
│                               │ + and improved retention."               │
│                              │                                           │
│  Tokens: 1800/950            │  Tokens: 1800/1420  [+470 out]           │
│  Latency: 3800ms             │  Latency: 4900ms    [+1100ms]            │
│  Cost: $0.0089               │  Cost: $0.0121      [+$0.0032]           │
│                              │                                           │
│  [62% similarity] ← DIVERGENCE POINT                                    │
├──────────────────────────────┴───────────────────────────────────────────┤
│  Divergence Analysis:                                                    │
│    Root cause: Prompt v2.4 includes instruction to apply seasonal       │
│    adjustment, producing more detailed but longer output.               │
│    Impact: Higher quality (+seasonal adjustment), higher cost (+27%),   │
│    higher latency (+29%). Goal still met.                                │
└──────────────────────────────────────────────────────────────────────────┘
```

### 6.4 Diff Engine Schema

```json
{
  "diff_id": "diff-uuid",
  "baseline_execution_id": "exec-a1b2",
  "comparison_execution_id": "exec-x7y8",
  "diff_type": "version_diff",
  "created_at": "2026-02-27T15:00:00Z",
  "summary": {
    "steps_matched": 6,
    "steps_inserted": 1,
    "steps_deleted": 0,
    "overall_similarity": 0.84,
    "divergence_step_id": "step-004",
    "goal_outcome_match": true,
    "cost_delta_usd": 0.006,
    "latency_delta_ms": 1900
  },
  "step_alignments": [
    {
      "baseline_step_id": "step-004",
      "comparison_step_id": "step-004",
      "alignment_type": "match",
      "output_similarity": 0.62,
      "is_divergence_point": true,
      "output_diff": {
        "added_lines": ["+After seasonal adjustment, real growth was 8%..."],
        "removed_lines": ["-12% YoY driven by enterprise segment growth."],
        "token_delta": { "input": 0, "output": 470 },
        "latency_delta_ms": 1100,
        "cost_delta_usd": 0.0032
      }
    }
  ]
}
```

---

## 7. Breakpoint System

The Breakpoint System enables conditional breakpoints that pause execution -- either during live replay or during real-time agent runs -- when specified conditions are met. It extends the `before_tool_callback` interception pattern (p. 295) to a general-purpose debugging mechanism.

### 7.1 Breakpoint Types

| Type | Trigger Condition | Use Case |
|------|-------------------|----------|
| **Step Type** | Execution reaches a specific step type | Pause on any tool call |
| **Agent** | Specific agent starts executing | Pause when AnalysisAgent runs |
| **Tool Call** | Specific tool is about to be called | Pause before `sql_query` execution |
| **Guardrail** | Guardrail check produces a specific result | Pause on any `non_compliant` result |
| **Output Pattern** | LLM output matches a regex or semantic pattern | Pause when output mentions "error" |
| **Goal** | Goal evaluation result matches condition | Pause when `goal_met` changes to false |
| **Cost** | Cumulative cost exceeds threshold | Pause when execution cost > $0.05 |
| **Conditional** | Arbitrary expression over step data | Pause when `tokens_out > 2000` |

### 7.2 Breakpoint Definition Schema

```json
{
  "breakpoint_id": "bp-001",
  "name": "Pause on expensive LLM calls",
  "enabled": true,
  "type": "conditional",
  "condition": {
    "expression": "step.llm_interaction.tokens_out > 2000 and step.llm_interaction.model == 'opus'",
    "description": "Pauses when an Opus call generates more than 2000 output tokens"
  },
  "actions": {
    "pause": true,
    "log": true,
    "notify": ["slack:#debug-channel"],
    "capture_snapshot": true
  },
  "hit_count": 0,
  "max_hits": null,
  "created_by": "engineer@agentforge.dev",
  "created_at": "2026-02-27T10:00:00Z"
}
```

### 7.3 Breakpoint Evaluation

```python
from dataclasses import dataclass
from typing import Any, Optional, Callable
import re


@dataclass
class Breakpoint:
    """
    A conditional breakpoint that can pause execution during
    replay or live debugging.

    Extends the before_tool_callback pattern (p. 295) to support
    arbitrary conditions on step data, tool calls, guardrail results,
    and goal evaluations (p. 188).
    """
    breakpoint_id: str
    name: str
    enabled: bool
    condition_type: str          # "step_type", "agent", "tool_call", "guardrail",
                                 # "output_pattern", "goal", "cost", "conditional"
    condition_value: Any         # Type depends on condition_type
    condition_description: str
    actions: dict                # {"pause": bool, "log": bool, "notify": list}
    hit_count: int = 0
    max_hits: Optional[int] = None

    def evaluate(self, step_data: dict, step_result: Any = None) -> bool:
        """
        Evaluate whether this breakpoint should fire for the given step.
        Returns True if the condition is met and the breakpoint should trigger.
        """
        if not self.enabled:
            return False
        if self.max_hits is not None and self.hit_count >= self.max_hits:
            return False

        triggered = False

        if self.condition_type == "step_type":
            triggered = step_data.get("step_type") == self.condition_value

        elif self.condition_type == "agent":
            triggered = step_data.get("agent_id") == self.condition_value

        elif self.condition_type == "tool_call":
            tool_calls = step_data.get("tool_calls", [])
            triggered = any(
                tc.get("tool_name") == self.condition_value for tc in tool_calls
            )

        elif self.condition_type == "guardrail":
            checks = step_data.get("guardrail_checks", [])
            triggered = any(
                c.get("result") == self.condition_value for c in checks
            )

        elif self.condition_type == "output_pattern":
            output_text = str(step_data.get("output", ""))
            triggered = bool(re.search(self.condition_value, output_text, re.IGNORECASE))

        elif self.condition_type == "goal":
            goal_eval = step_data.get("goal_evaluation", {})
            if self.condition_value == "regression":
                # Trigger when goal_met transitions from True to False
                triggered = goal_eval.get("met") is False
            elif self.condition_value == "unmet":
                triggered = goal_eval.get("met") is False

        elif self.condition_type == "cost":
            cumulative_cost = step_data.get("cumulative_cost_usd", 0)
            triggered = cumulative_cost > self.condition_value

        elif self.condition_type == "conditional":
            # Safe expression evaluation against step data
            triggered = self._safe_eval(self.condition_value, step_data)

        if triggered:
            self.hit_count += 1

        return triggered

    def _safe_eval(self, expression: str, step_data: dict) -> bool:
        """
        Safely evaluate a conditional expression against step data.
        Uses a restricted namespace -- no access to builtins, os, sys, etc.
        """
        # Build a safe evaluation context from step data
        context = {
            "step": _DotDict(step_data),
            "len": len,
            "abs": abs,
            "min": min,
            "max": max,
        }
        try:
            return bool(eval(expression, {"__builtins__": {}}, context))
        except Exception:
            return False


class _DotDict(dict):
    """Dictionary with dot-notation access for breakpoint expressions."""
    def __getattr__(self, key):
        value = self.get(key)
        if isinstance(value, dict):
            return _DotDict(value)
        return value
```

### 7.4 Live Breakpoints

Live breakpoints operate on running agent executions (not replays). They integrate with the Guardrail System's `before_tool_callback` mechanism (p. 295) to intercept execution without modifying the agent code.

```
Agent Execution Pipeline (with live breakpoints):

  Agent Loop Iteration
      │
      ▼
  ┌─────────────────┐
  │ Pre-step Hook   │──── Evaluate breakpoints against step context
  │ (breakpoint     │     If triggered: pause execution, notify debugger,
  │  evaluator)     │     wait for human "continue" / "step" / "abort"
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │ Guardrail Check │──── Standard guardrail evaluation (p. 295)
  │ (before_tool_   │     Breakpoint system operates BEFORE guardrails
  │  callback)      │     to allow debugging of guardrail behavior itself
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │ Step Execution  │──── LLM call / tool call / delegation
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │ Post-step Hook  │──── Evaluate output-based breakpoints
  │ (breakpoint     │     (output_pattern, goal, cost conditions)
  │  evaluator)     │
  └─────────────────┘
```

---

## 8. Step-Through Mode

Step-Through Mode gives a human engineer direct control over agent execution, advancing one step at a time. It is HITL (p. 210) applied to the debugging context: the human acts as the execution controller, deciding when to proceed, when to modify, and when to abort.

### 8.1 Step-Through Controls

| Control | Action | Keyboard Shortcut |
|---------|--------|-------------------|
| **Step Over** | Execute the current step and pause before the next | `F10` |
| **Step Into** | If current step delegates to a sub-agent, enter the sub-execution | `F11` |
| **Step Out** | Run to the end of the current sub-agent and pause in the parent | `Shift+F11` |
| **Continue** | Run to the next breakpoint or to completion | `F5` |
| **Abort** | Terminate the execution immediately | `Shift+F5` |
| **Modify & Retry** | Edit the current step's input and re-execute it | `Ctrl+R` |
| **Inspect** | Open the state inspector for the current position | `Ctrl+I` |
| **Watch** | Add a memory variable to the watch panel | `Ctrl+W` |

### 8.2 Step-Through Architecture

Step-Through Mode is implemented as a special configuration of the Replay Engine (section 3) and Breakpoint System (section 7):

1. **Speed** is set to `PAUSED`, requiring manual advance.
2. A **universal breakpoint** is registered that fires on every step (effectively `condition: true`).
3. The **event bus** sends step data to the debugging UI, which renders the state inspection and waits for a human command.
4. The human's command (`step_over`, `continue`, `abort`, etc.) is sent back to the Replay Engine via the API.

```python
class StepThroughController:
    """
    Step-through mode for human-controlled execution.
    Implements HITL intervention mode (p. 210) in the debugging context.

    The controller wraps the Replay Engine with a universal breakpoint
    and exposes step controls to the debugging UI.
    """

    def __init__(
        self,
        replay_engine: "ReplayEngine",
        debugger: "TimeTravelDebugger",
        event_bus: "EventBus",
    ):
        self._replay = replay_engine
        self._debugger = debugger
        self._events = event_bus
        self._pending_commands: asyncio.Queue = asyncio.Queue()

    async def start_step_through(
        self,
        execution_id: str,
        start_from_step: Optional[str] = None,
        mode: ReplayMode = ReplayMode.TRACE,
    ) -> str:
        """
        Start a step-through debugging session.

        Creates a replay session with PAUSED speed and a universal
        breakpoint, then waits for human commands to advance.
        """
        # Create a universal breakpoint that fires on every step
        universal_bp = Breakpoint(
            breakpoint_id="bp-step-through",
            name="Step-Through Universal",
            enabled=True,
            condition_type="conditional",
            condition_value="True",  # Always fires
            condition_description="Universal step-through breakpoint",
            actions={"pause": True, "log": False, "notify": []},
        )

        session = await self._replay.start_replay(
            execution_id=execution_id,
            mode=mode,
            speed=ReplaySpeed.PAUSED,
            start_from_step=start_from_step,
            breakpoints=[universal_bp],
        )

        # Open a time-travel debugger session in parallel
        debug_session = await self._debugger.open_session(execution_id)

        await self._events.publish("stepthrough.started", {
            "session_id": session.session_id,
            "execution_id": execution_id,
            "debug_session_id": debug_session,
        })

        return session.session_id

    async def send_command(self, session_id: str, command: str, **kwargs) -> dict:
        """
        Process a human command for the step-through session.

        Commands: step_over, step_into, step_out, continue, abort,
                  modify_and_retry, inspect, watch.
        """
        session = self._replay._active_sessions.get(session_id)
        if not session:
            raise SessionNotFoundError(session_id)

        if command == "step_over":
            result = await self._replay.advance_step(session_id)
            inspection = await self._debugger.step_forward(session_id)
            return {"result": result, "inspection": inspection}

        elif command == "step_into":
            # If the current step has children, descend into the first child
            record = await self._replay._store.load_execution_record(session.execution_id)
            current_step = record["steps"][session.current_step_index]
            children = current_step.get("children", [])
            if children:
                result = await self._replay.advance_step(session_id)
                return {"result": result, "descended_into": children[0]}
            else:
                # No children, behave like step_over
                return await self.send_command(session_id, "step_over")

        elif command == "step_out":
            # Run until we return to the parent step's scope
            record = await self._replay._store.load_execution_record(session.execution_id)
            current_step = record["steps"][session.current_step_index]
            parent_id = current_step.get("parent_step_id")

            while session.current_step_index < len(record["steps"]):
                step = record["steps"][session.current_step_index]
                if step.get("parent_step_id") != current_step.get("parent_step_id"):
                    break
                await self._replay.advance_step(session_id)

            inspection = await self._debugger.jump_to_step(
                session_id, record["steps"][session.current_step_index]["step_id"]
            )
            return {"inspection": inspection}

        elif command == "continue":
            # Remove the universal breakpoint, run to next real breakpoint or end
            session.breakpoints = [
                bp for bp in session.breakpoints
                if bp.breakpoint_id != "bp-step-through"
            ]
            session.speed = ReplaySpeed.INSTANT
            results = await self._replay.run_to_completion(session_id)
            return {"results": results, "status": session.status}

        elif command == "abort":
            session.status = "aborted"
            await self._events.publish("stepthrough.aborted", {
                "session_id": session_id,
            })
            return {"status": "aborted"}

        elif command == "modify_and_retry":
            # What-if analysis on the current step
            mutations = kwargs.get("mutations", [])
            # This delegates to the What-If Analyzer
            return {"status": "delegated_to_whatif", "mutations": mutations}

        elif command == "inspect":
            inspection = await self._debugger.jump_to_step(
                session_id,
                session._cursors[session_id].step_id if hasattr(session, '_cursors') else
                record["steps"][session.current_step_index]["step_id"],
            )
            return {"inspection": inspection}

        elif command == "watch":
            variable_key = kwargs.get("variable_key")
            history = await self._debugger.inspect_variable(session_id, variable_key)
            return {"watch": history}

        else:
            raise UnknownCommandError(f"Unknown command: {command}")
```

---

## 9. Root Cause Analyzer

The Root Cause Analyzer is an LLM-powered system that automatically investigates why an agent execution produced a bad output. It implements the Reflection pattern (p. 65): a **critic agent** analyzes the full failure trace, classifies the error (p. 205), identifies the causal chain, and proposes remediation.

### 9.1 Root Cause Analysis Workflow

```
Failed Execution                Root Cause Analyzer
      │                                │
      │  Execution record with         │
      │  goal_met=false or             │
      │  error_occurred=true           │
      │                                │
      └──────────────────────────────> │
                                       │
                          ┌────────────┴────────────┐
                          │                         │
                          ▼                         ▼
                  ┌───────────────┐        ┌───────────────┐
                  │ Failure Point │        │ Cascading      │
                  │ Locator       │        │ Failure        │
                  │               │        │ Analyzer       │
                  │ Finds the     │        │                │
                  │ first step    │        │ Traces failure │
                  │ where goals   │        │ propagation    │
                  │ regressed     │        │ across agent   │
                  │ (p. 188)      │        │ boundaries     │
                  └───────┬───────┘        │ (p. 126)       │
                          │                └───────┬───────┘
                          │                        │
                          └───────────┬────────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │ Critic Agent (p. 65)  │
                          │                       │
                          │ Analyzes the failure  │
                          │ trace with full       │
                          │ context, classifies   │
                          │ the error (p. 205),   │
                          │ proposes remediation   │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │ Root Cause Report     │
                          │                       │
                          │ - Failure point       │
                          │ - Causal chain        │
                          │ - Error class         │
                          │ - Confidence score    │
                          │ - Remediation steps   │
                          │ - Regression test     │
                          └───────────────────────┘
```

### 9.2 Error Classification (p. 205)

The Root Cause Analyzer classifies failures using the Error Triad from the Exception Handling pattern:

| Error Class | Description | Typical Causes | Remediation |
|-------------|-------------|---------------|-------------|
| **Transient** | Temporary failure that may succeed on retry | API timeout, rate limit, network blip | Retry with exponential backoff |
| **Logic** | Agent reasoning error, wrong tool selection, bad plan | Ambiguous prompt, insufficient context, model limitation | Prompt refinement, add examples, model upgrade |
| **Unrecoverable** | Fundamental inability to complete the task | Missing tool, impossible goal, data unavailable | Goal redefinition, tool addition, human escalation |
| **Cascading** | Failure in one agent that propagates to downstream agents | Upstream agent produced malformed output (p. 126) | Input validation at agent boundaries, circuit breaker |
| **Guardrail** | Execution blocked by safety policy | PII in output, unauthorized tool access, content violation | Policy review, agent prompt adjustment |

### 9.3 Root Cause Analyzer Pseudocode

```python
from dataclasses import dataclass, field
from typing import Any, Optional
from enum import Enum
import uuid


class ErrorClass(Enum):
    TRANSIENT = "transient"
    LOGIC = "logic"
    UNRECOVERABLE = "unrecoverable"
    CASCADING = "cascading"
    GUARDRAIL = "guardrail"


class ConfidenceLevel(Enum):
    HIGH = "high"          # > 0.8: clear causal chain identified
    MEDIUM = "medium"      # 0.5-0.8: probable cause with some ambiguity
    LOW = "low"            # < 0.5: multiple possible causes


@dataclass
class CausalLink:
    """A single link in the causal chain from root cause to failure."""
    step_id: str
    step_type: str
    agent_id: str
    description: str
    contribution: str      # "root_cause", "propagated", "amplified", "observed"


@dataclass
class RootCauseReport:
    """Complete root cause analysis report for a failed execution."""
    report_id: str
    execution_id: str
    created_at: str

    # Failure identification
    failure_step_id: str          # Step where the failure manifested
    failure_type: str             # "goal_unmet", "error", "guardrail_block", "timeout"
    failure_description: str

    # Root cause analysis
    root_cause_step_id: str       # Step where the root cause originated
    error_class: ErrorClass       # Error classification (p. 205)
    causal_chain: list[CausalLink]
    confidence: ConfidenceLevel
    confidence_score: float

    # Explanation
    analysis_summary: str         # Human-readable summary from the critic agent
    contributing_factors: list[str]
    what_went_right: list[str]    # Steps that worked correctly (context)

    # Remediation
    recommended_actions: list[dict]  # Ordered remediation steps
    regression_test: Optional[dict]  # Auto-generated test case for eval framework

    # Metadata
    critic_model: str             # Model used for analysis
    analysis_cost_usd: float
    analysis_latency_ms: float


class RootCauseAnalyzer:
    """
    LLM-powered root cause analysis for failed agent executions.

    Implements the Reflection pattern (p. 65): a critic agent analyzes
    the complete failure trace, using error classification (p. 205) to
    categorize the failure and goals_met() evaluation (p. 188) to
    identify where goal progress stopped.

    For multi-agent executions, traces cascading failures across agent
    boundaries (p. 126) to find the originating agent.
    """

    CRITIC_SYSTEM_PROMPT = """You are a root cause analysis expert for agentic AI systems.
You are given the complete execution trace of a failed agent execution, including:
- Every step (LLM calls, tool calls, guardrail checks, delegations)
- State snapshots at each step
- Goal evaluation results at each step
- Error details if an exception occurred

Your task:
1. Identify the EXACT step where the failure originated (not where it was observed).
2. Classify the error: transient, logic, unrecoverable, cascading, or guardrail.
3. Trace the causal chain from root cause to observed failure.
4. Explain WHY the failure happened in plain language.
5. Recommend specific remediation actions, ordered by priority.
6. Generate a regression test case to prevent recurrence.

Be precise. Cite specific step IDs. Do not speculate beyond the evidence in the trace.
Output your analysis as structured JSON."""

    def __init__(
        self,
        execution_store: "ExecutionRecordStore",
        llm_client: "LLMClient",
        eval_framework: "EvaluationFramework",
        event_bus: "EventBus",
        critic_model: str = "sonnet",
    ):
        self._store = execution_store
        self._llm = llm_client
        self._eval = eval_framework
        self._events = event_bus
        self._critic_model = critic_model

    async def analyze(
        self,
        execution_id: str,
        failure_context: Optional[str] = None,
    ) -> RootCauseReport:
        """
        Perform root cause analysis on a failed execution.

        Steps:
        1. Load the execution record and identify the failure point.
        2. Locate the first step where goal progress regressed (p. 188).
        3. Trace cascading failures across agent boundaries (p. 126).
        4. Submit the trace to the critic agent for analysis (p. 65).
        5. Generate a remediation plan and regression test.

        Args:
            execution_id: The failed execution to analyze.
            failure_context: Optional human description of what went wrong.
        """
        import time as time_module

        start_time = time_module.monotonic()
        record = await self._store.load_execution_record(execution_id)

        # Step 1: Identify the failure point
        failure_step, failure_type = self._locate_failure_point(record)

        # Step 2: Find goal regression point (p. 188)
        regression_step = self._find_goal_regression(record)

        # Step 3: Trace cascading failures (p. 126)
        cascade_chain = self._trace_cascading_failures(record, failure_step)

        # Step 4: Build the context for the critic agent
        critic_context = self._build_critic_context(
            record=record,
            failure_step=failure_step,
            failure_type=failure_type,
            regression_step=regression_step,
            cascade_chain=cascade_chain,
            human_context=failure_context,
        )

        # Step 5: Submit to critic agent (Reflection pattern, p. 65)
        critic_response = await self._llm.generate(
            model=self._critic_model,
            system_prompt=self.CRITIC_SYSTEM_PROMPT,
            user_message=critic_context,
            temperature=0.0,         # Deterministic analysis
            response_format="json",
        )

        analysis = self._parse_critic_response(critic_response)
        analysis_cost = self._compute_cost(critic_response)

        # Step 6: Generate regression test for the Evaluation Framework (08)
        regression_test = await self._generate_regression_test(
            record, analysis, failure_step
        )

        end_time = time_module.monotonic()
        latency_ms = (end_time - start_time) * 1000

        report = RootCauseReport(
            report_id=str(uuid.uuid4()),
            execution_id=execution_id,
            created_at=self._now_iso(),
            failure_step_id=failure_step["step_id"],
            failure_type=failure_type,
            failure_description=analysis.get("failure_description", ""),
            root_cause_step_id=analysis.get("root_cause_step_id", failure_step["step_id"]),
            error_class=ErrorClass(analysis.get("error_class", "logic")),
            causal_chain=[
                CausalLink(**link) for link in analysis.get("causal_chain", [])
            ],
            confidence=self._classify_confidence(analysis.get("confidence_score", 0.5)),
            confidence_score=analysis.get("confidence_score", 0.5),
            analysis_summary=analysis.get("summary", ""),
            contributing_factors=analysis.get("contributing_factors", []),
            what_went_right=analysis.get("what_went_right", []),
            recommended_actions=analysis.get("recommended_actions", []),
            regression_test=regression_test,
            critic_model=self._critic_model,
            analysis_cost_usd=analysis_cost,
            analysis_latency_ms=latency_ms,
        )

        # Publish report for downstream consumers
        await self._events.publish("rca.report_generated", {
            "report_id": report.report_id,
            "execution_id": execution_id,
            "error_class": report.error_class.value,
            "confidence": report.confidence.value,
            "root_cause_step": report.root_cause_step_id,
        })

        return report

    def _locate_failure_point(self, record: dict) -> tuple[dict, str]:
        """
        Find the step where the failure manifested.

        Checks in priority order:
        1. Steps with error.handle type (explicit errors)
        2. Steps where guardrail blocked execution
        3. The last step with goal_met=False
        4. The final step (if overall goal_met=False)
        """
        # Check for explicit errors
        for step in record["steps"]:
            if step["step_type"] == "error.handle":
                return step, "error"

        # Check for guardrail blocks
        for step in record["steps"]:
            for check in step.get("guardrail_checks", []):
                if check.get("result") == "non_compliant":
                    return step, "guardrail_block"

        # Check for goal failure
        for step in reversed(record["steps"]):
            goal_eval = step.get("goal_evaluation", {})
            if goal_eval.get("met") is False:
                return step, "goal_unmet"

        # Default to last step
        return record["steps"][-1], "unknown"

    def _find_goal_regression(self, record: dict) -> Optional[dict]:
        """
        Find the first step where goal progress regressed.

        Uses goals_met() evaluation (p. 188) at each step to detect
        where the execution went from making progress to losing it.
        """
        prev_met = None
        for step in record["steps"]:
            goal_eval = step.get("goal_evaluation", {})
            current_met = goal_eval.get("met")

            if prev_met is True and current_met is False:
                return step  # Goal regression detected here

            if current_met is not None:
                prev_met = current_met

        return None

    def _trace_cascading_failures(
        self, record: dict, failure_step: dict
    ) -> list[dict]:
        """
        Trace failure propagation across agent boundaries (p. 126).

        Starting from the failure step, walks backward through the
        execution graph following parent_step_id links to find where
        bad data or errors originated in upstream agents.
        """
        chain = []
        current_step = failure_step

        while current_step:
            chain.append({
                "step_id": current_step["step_id"],
                "agent_id": current_step["agent_id"],
                "step_type": current_step["step_type"],
                "had_error": current_step.get("step_type") == "error.handle",
                "goal_met": current_step.get("goal_evaluation", {}).get("met"),
            })

            # Walk up to parent
            parent_id = current_step.get("parent_step_id")
            if parent_id:
                current_step = next(
                    (s for s in record["steps"] if s["step_id"] == parent_id),
                    None,
                )
            else:
                current_step = None

        chain.reverse()  # Root-to-leaf order
        return chain

    def _build_critic_context(
        self,
        record: dict,
        failure_step: dict,
        failure_type: str,
        regression_step: Optional[dict],
        cascade_chain: list[dict],
        human_context: Optional[str],
    ) -> str:
        """
        Build the prompt context for the critic agent.

        Includes the full execution trace, failure details, goal
        progression history, and cascading failure chain.
        """
        context_parts = [
            "# Failed Execution Analysis Request\n",
            f"Execution ID: {record['execution_id']}",
            f"Total Steps: {len(record['steps'])}",
            f"Overall Goal Met: {record['execution_graph']['goal_met']}",
            f"Failure Type: {failure_type}",
            f"Failure Step: {failure_step['step_id']} ({failure_step['step_type']})",
        ]

        if regression_step:
            context_parts.append(
                f"Goal Regression Detected At: {regression_step['step_id']}"
            )

        if human_context:
            context_parts.append(f"\nHuman Description: {human_context}")

        context_parts.append("\n## Cascading Failure Chain:")
        for link in cascade_chain:
            context_parts.append(
                f"  {link['step_id']} ({link['agent_id']}): "
                f"error={link['had_error']}, goal_met={link['goal_met']}"
            )

        context_parts.append("\n## Full Execution Trace:")
        for step in record["steps"]:
            context_parts.append(self._format_step_for_critic(step))

        return "\n".join(context_parts)

    def _format_step_for_critic(self, step: dict) -> str:
        """Format a single step for the critic agent's context."""
        lines = [
            f"\n### Step: {step['step_id']} ({step['step_type']})",
            f"Agent: {step['agent_id']} v{step['agent_version']}",
            f"Duration: {step['duration_ms']}ms",
            f"Input: {str(step.get('input', ''))[:500]}",
            f"Output: {str(step.get('output', ''))[:500]}",
        ]

        goal_eval = step.get("goal_evaluation", {})
        if goal_eval:
            lines.append(f"Goal Met: {goal_eval.get('met')}")
            lines.append(f"Goal Criteria: {goal_eval.get('criteria', {})}")

        for tc in step.get("tool_calls", []):
            lines.append(f"Tool: {tc.get('tool_name')} -> {tc.get('status')}")

        for gc in step.get("guardrail_checks", []):
            lines.append(f"Guardrail: {gc.get('policy')} -> {gc.get('result')}")

        return "\n".join(lines)

    async def _generate_regression_test(
        self,
        record: dict,
        analysis: dict,
        failure_step: dict,
    ) -> dict:
        """
        Generate a regression test case for the Evaluation Framework (08).

        Creates an evalset entry that captures the failure scenario so it
        can be used to verify that the root cause has been addressed.
        """
        return {
            "test_type": "regression",
            "source": "root_cause_analysis",
            "execution_id": record["execution_id"],
            "input": record["steps"][0].get("input", {}),
            "expected_outcome": {
                "goal_met": True,
                "no_error_at_step": failure_step["step_id"],
                "error_class_absent": analysis.get("error_class"),
            },
            "created_from_report": analysis.get("report_id"),
            "description": (
                f"Regression test for {analysis.get('error_class', 'unknown')} "
                f"failure at {failure_step['step_id']}: "
                f"{analysis.get('summary', '')[:200]}"
            ),
        }

    def _parse_critic_response(self, response: Any) -> dict:
        """Parse the critic agent's structured JSON response."""
        # Extract JSON from the LLM response
        ...

    def _compute_cost(self, response: Any) -> float:
        """Compute the cost of the critic agent's analysis."""
        ...

    def _classify_confidence(self, score: float) -> ConfidenceLevel:
        if score > 0.8:
            return ConfidenceLevel.HIGH
        elif score > 0.5:
            return ConfidenceLevel.MEDIUM
        else:
            return ConfidenceLevel.LOW

    def _now_iso(self) -> str:
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).isoformat()
```

### 9.4 Automated Root Cause Analysis Triggers

Root cause analysis runs automatically when:

| Trigger | Condition | Priority |
|---------|-----------|----------|
| **Goal failure** | `execution_graph.goal_met == false` | High |
| **Unrecoverable error** | `error_class == "unrecoverable"` in exception log | High |
| **Guardrail block** | Execution terminated by guardrail intervention | Medium |
| **Repeated failure** | Same agent fails 3+ times on similar inputs within 1 hour | Critical |
| **Cost anomaly** | Execution cost > 5x the agent's historical median | Medium |
| **Manual request** | Engineer triggers analysis via API or UI | Varies |

---

## 10. API Surface

### 10.1 Replay API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/replay/sessions` | Create a new replay session for a past execution. Body: `{execution_id, mode, speed, start_from_step, breakpoints}` |
| `GET` | `/api/v1/replay/sessions/{session_id}` | Get replay session status and progress. |
| `POST` | `/api/v1/replay/sessions/{session_id}/advance` | Advance one step. Returns `ReplayStepResult`. |
| `POST` | `/api/v1/replay/sessions/{session_id}/run` | Run to completion or next breakpoint. |
| `POST` | `/api/v1/replay/sessions/{session_id}/pause` | Pause a running replay. |
| `DELETE` | `/api/v1/replay/sessions/{session_id}` | Terminate and clean up a replay session. |

### 10.2 Time-Travel Debugger API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/debug/sessions` | Open a debugging session. Body: `{execution_id}` |
| `POST` | `/api/v1/debug/sessions/{session_id}/jump` | Jump to a specific step. Body: `{step_id, position}` |
| `POST` | `/api/v1/debug/sessions/{session_id}/step-forward` | Move cursor forward one step. |
| `POST` | `/api/v1/debug/sessions/{session_id}/step-backward` | Move cursor backward one step. |
| `GET` | `/api/v1/debug/sessions/{session_id}/inspect` | Get full state inspection at current cursor position. |
| `GET` | `/api/v1/debug/sessions/{session_id}/variable/{key}` | Get value history for a specific memory variable. |
| `GET` | `/api/v1/debug/sessions/{session_id}/anomalies` | Scan the entire execution for anomalies. |

### 10.3 What-If Analysis API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/whatif/scenarios` | Create and execute a what-if scenario. Body: `{execution_id, fork_step_id, mutations, max_budget_usd}` |
| `GET` | `/api/v1/whatif/scenarios/{scenario_id}` | Get scenario results and comparison. |
| `GET` | `/api/v1/whatif/scenarios/{scenario_id}/diff` | Get step-by-step diff between original and forked execution. |
| `GET` | `/api/v1/whatif/executions/{execution_id}/scenarios` | List all what-if scenarios for a given execution. |

### 10.4 Diff API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/diff/compare` | Compare two executions. Body: `{baseline_execution_id, comparison_execution_id}` |
| `GET` | `/api/v1/diff/{diff_id}` | Get diff results with step alignments. |
| `GET` | `/api/v1/diff/{diff_id}/step/{step_id}` | Get detailed diff for a specific step. |

### 10.5 Breakpoint API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/breakpoints` | Create a new breakpoint. Body: `Breakpoint` schema. |
| `GET` | `/api/v1/breakpoints` | List all registered breakpoints. |
| `PUT` | `/api/v1/breakpoints/{breakpoint_id}` | Update a breakpoint (enable/disable, modify condition). |
| `DELETE` | `/api/v1/breakpoints/{breakpoint_id}` | Delete a breakpoint. |
| `GET` | `/api/v1/breakpoints/{breakpoint_id}/history` | Get breakpoint hit history. |

### 10.6 Step-Through API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/stepthrough/sessions` | Start a step-through session. Body: `{execution_id, mode, start_from_step}` |
| `POST` | `/api/v1/stepthrough/sessions/{session_id}/command` | Send a command. Body: `{command, kwargs}` |
| `GET` | `/api/v1/stepthrough/sessions/{session_id}/state` | Get current step-through state and cursor position. |

### 10.7 Root Cause Analysis API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/rca/analyze` | Trigger root cause analysis. Body: `{execution_id, failure_context}` |
| `GET` | `/api/v1/rca/reports/{report_id}` | Get a root cause analysis report. |
| `GET` | `/api/v1/rca/executions/{execution_id}/reports` | List all RCA reports for an execution. |
| `GET` | `/api/v1/rca/reports/{report_id}/regression-test` | Get the auto-generated regression test case. |
| `POST` | `/api/v1/rca/reports/{report_id}/promote-test` | Promote the regression test to the Evaluation Framework (08). |

### 10.8 Execution Record API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/executions/{execution_id}` | Get a full execution record. |
| `GET` | `/api/v1/executions/search` | Search execution records. Params: `agent_id`, `team_id`, `time_range`, `goal_met`, `has_error`. |
| `POST` | `/api/v1/executions/{execution_id}/flag` | Flag an execution for investigation (exempt from TTL). |
| `GET` | `/api/v1/executions/{execution_id}/steps/{step_id}` | Get a single step with full detail. |

---

## 11. Failure Modes & Mitigations

| Failure Mode | Impact | Mitigation |
|-------------|--------|-----------|
| **Execution record incomplete** (missing state snapshots or LLM payloads) | Time-travel and what-if analysis unavailable for that execution | Mark record as `replay_compatible: false`. Degrade gracefully to trace-only replay (step timing and outcomes visible, but no state inspection). Alert on snapshot capture failure rate > 1%. |
| **State snapshot too large** (agent with massive context window or memory) | Storage cost spike, slow snapshot restore | Compress snapshots (zstd). For snapshots > 1MB, store a delta from the previous snapshot instead of a full copy. Set hard limit at 10MB per snapshot with automatic summarization. |
| **Live replay cost overrun** (what-if analysis triggers expensive model calls) | Unexpected cost spike | Budget enforcement on every live replay and what-if session. Estimated cost displayed before execution. Hard abort if running cost exceeds 2x the estimate. Integration with Cost & Resource Manager (09). |
| **Mock injection mismatch** (recorded response schema does not match current agent version) | Replay produces errors or incorrect comparisons | Version-pin replay to the agent version in the execution record. Warn if current agent version differs from recorded version. Schema migration layer for backward compatibility. |
| **Critic agent hallucination** (root cause analyzer produces incorrect analysis) | Misleading root cause report sends engineers on wrong investigation path | Require confidence score in every report. Flag reports with `confidence < 0.5` as "uncertain." Allow human override and correction of RCA reports. Track RCA accuracy over time as a meta-metric. |
| **Breakpoint evaluation overhead** (too many breakpoints slow down live execution) | Agent latency degradation | Limit to 50 active breakpoints per session. Evaluate breakpoints asynchronously where possible. Simple conditions (step_type, agent_id) evaluated in < 1ms; complex conditions (output_pattern with regex) have a 10ms timeout. |
| **Concurrent debugger sessions** (multiple engineers debugging the same execution) | State conflicts, confusing UI updates | Each debugging session operates on an independent, read-only copy of the execution record. Sessions do not interfere with each other. Session count limit: 10 concurrent sessions per execution. |
| **Cascading failure analysis crosses team boundaries** (A2A protocol obscures inter-team trace links) | Root cause analyzer cannot trace the full causal chain | Require `trace_id` propagation in all A2A calls (W3C Trace Context, see Observability subsystem 2.3). If trace linking is broken, RCA reports flag "incomplete cross-team visibility" in the confidence assessment. |
| **What-if fork produces infinite loop** (modified input causes agent to loop indefinitely) | Resource exhaustion, budget drain | Enforce the same `max_iterations` limit on forked executions as on the original. Add a wall-clock timeout (5 minutes per forked execution). Kill and report if either limit is hit. |
| **Time-travel to step with external side effects** (e.g., step that sent an email or wrote to a database) | Risk of re-triggering side effects during live replay | All tool calls in replay use mocked outputs by default. Live replay only allows real LLM calls, never real tool calls. Tool calls are always intercepted by the Mock Injection Layer. Display a warning for steps with side-effect-capable tools. |

### Graceful Degradation Hierarchy

When data quality issues prevent full debugging capabilities, the subsystem degrades in this order:

1. **Full capability**: All features available -- state snapshots, LLM payloads, tool I/O all present.
2. **No state snapshots**: Time-travel and what-if analysis unavailable. Trace replay, diff mode, and root cause analysis still work from trace data alone.
3. **No LLM payloads**: Live replay and what-if analysis unavailable. Trace replay works with structural data (timing, step graph, outcomes). Diff mode works for structural comparison.
4. **Trace-only**: Minimal degradation. Only step timing, step types, and final outcomes available. Root cause analysis operates on structural data with reduced confidence.

---

## 12. Instrumentation

The Replay & Debugging subsystem emits its own telemetry to the Observability Platform (05) for monitoring the debugging infrastructure itself.

### 12.1 Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `replay.sessions_active` | Gauge | Number of currently active replay sessions |
| `replay.session_duration_ms` | Histogram | Time spent in a replay session |
| `replay.step_advance_latency_ms` | Histogram | Time to advance one step during replay |
| `replay.output_match_rate` | Gauge | Fraction of replayed steps where output matches original (live mode) |
| `debug.sessions_active` | Gauge | Number of active time-travel debugging sessions |
| `debug.jump_latency_ms` | Histogram | Time to jump to a step (state restoration time) |
| `debug.anomalies_found` | Counter | Total anomalies found across all debugging sessions |
| `whatif.scenarios_created` | Counter | Total what-if scenarios executed |
| `whatif.scenario_cost_usd` | Histogram | Cost per what-if scenario |
| `whatif.output_similarity` | Histogram | Semantic similarity between original and forked outputs |
| `diff.comparisons_created` | Counter | Total diff comparisons performed |
| `diff.divergence_step_depth` | Histogram | How deep in the execution graph the first divergence occurs |
| `breakpoint.evaluations_total` | Counter | Total breakpoint evaluations performed |
| `breakpoint.hits_total` | Counter | Total breakpoint hits |
| `breakpoint.eval_latency_ms` | Histogram | Breakpoint evaluation latency |
| `rca.reports_generated` | Counter | Total root cause analysis reports generated |
| `rca.analysis_latency_ms` | Histogram | Time to generate an RCA report |
| `rca.analysis_cost_usd` | Histogram | LLM cost per RCA report |
| `rca.confidence_distribution` | Histogram | Distribution of RCA confidence scores |
| `rca.regression_tests_promoted` | Counter | Regression tests promoted to the Evaluation Framework |
| `execution_record.assembly_latency_ms` | Histogram | Time to assemble an execution record from trace data |
| `execution_record.size_bytes` | Histogram | Size distribution of execution records |
| `execution_record.snapshot_capture_failures` | Counter | Failed state snapshot captures |

### 12.2 Health Checks

| Check | Interval | Failure Action |
|-------|----------|---------------|
| Execution Record Store connectivity | 30s | Alert if unavailable > 2 minutes |
| State snapshot capture pipeline | 60s | Alert if failure rate > 1% |
| Mock provider integrity | On session start | Reject replay if mock data inconsistent |
| Critic agent responsiveness | 5m | Fall back to rule-based RCA if critic agent unreachable |
| Breakpoint evaluation budget | Per evaluation | Disable breakpoints with > 10ms average evaluation time |

### 12.3 Audit Trail

All debugging operations are logged to the Observability Platform's Decision Audit Log for compliance and team coordination:

| Event | Logged Fields |
|-------|---------------|
| Replay session created | `engineer_id`, `execution_id`, `mode`, `timestamp` |
| What-if scenario executed | `engineer_id`, `execution_id`, `mutations`, `cost`, `timestamp` |
| Root cause report generated | `report_id`, `execution_id`, `error_class`, `confidence`, `timestamp` |
| Breakpoint created/modified | `engineer_id`, `breakpoint_id`, `condition`, `timestamp` |
| Step-through command issued | `engineer_id`, `session_id`, `command`, `step_id`, `timestamp` |
| Execution flagged for investigation | `engineer_id`, `execution_id`, `reason`, `timestamp` |

---

*This subsystem depends on: Observability Platform (05) for trace data, Agent Builder (01) for agent instantiation, Team Orchestrator (02) for execution graph topology, Memory & Context Management (11) for state snapshots, Evaluation Framework (08) for regression test promotion, Cost & Resource Manager (09) for replay budget enforcement. It is consumed by: engineers via the debugging UI and API, and by the Evaluation Framework (08) for auto-generated regression tests.*
