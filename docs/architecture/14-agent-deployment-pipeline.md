# 14 — Agent Deployment Pipeline (CI/CD)

## Contents

| # | Section | Description |
|---|---------|-------------|
| 1 | [Overview & Responsibility](#1-overview--responsibility) | CI/CD mandate: every agent in production is an immutable, evaluated artifact |
| 2 | [Agent Artifact Schema](#2-agent-artifact-schema) | Versioned artifact bundle: prompt, tools, guardrails, and eval criteria |
| 3 | [Build Pipeline](#3-build-pipeline) | Six-stage pipeline from source commit to staging deployment |
| 4 | [Deployment Strategies](#4-deployment-strategies) | Blue/green, canary (1%→100%), and shadow deployment patterns |
| 5 | [Environment Management](#5-environment-management) | Dev, staging, and production environment configuration and promotion gates |
| 6 | [Rollback Mechanism](#6-rollback-mechanism) | Automated rollback triggers and sub-60-second recovery SLA |
| 7 | [Team Deployment](#7-team-deployment) | Coordinated multi-agent team rollout with dependency ordering |
| 8 | [Integration Points](#8-integration-points) | How the pipeline integrates with Agent Builder, Prompt Registry, and Eval |
| 9 | [API Surface](#9-api-surface) | REST endpoints for pipeline triggers, status, and artifact queries |
| 10 | [Failure Modes & Mitigations](#10-failure-modes--mitigations) | Failed eval gates, rollback storms, and artifact corruption recovery |
| 11 | [Instrumentation](#11-instrumentation) | Deployment duration, canary error rates, and rollback frequency metrics |

---

## 1. Overview & Responsibility

The Agent Deployment Pipeline is the **continuous integration and continuous deployment (CI/CD) subsystem** for the AgentForge platform. It treats every agent as a holistic deployable artifact -- a versioned, immutable snapshot of prompt, tools, guardrail policies, memory configuration, model configuration, and evaluation criteria -- and moves that artifact through a deterministic pipeline of validation, testing, evaluation, staging, and deployment gates before it reaches production traffic.

Within the broader platform architecture (see `00-system-overview.md`, Section 2), the Agent Deployment Pipeline occupies subsystem #14 and sits at the intersection of the Agent Builder (01), Prompt Registry (07), Evaluation Framework (08), and Guardrail System (04). Its core invariant is:

> **Every agent serving production traffic is backed by an immutable, fully-evaluated, human-approved artifact whose deployment can be rolled back in under 60 seconds.**

The pipeline models the deployment process itself as a **deterministic prompt chain** (p. 5) -- a sequence of stages where each stage's output is validated before the next stage executes. This ensures that no partially-validated agent ever reaches live users.

### Design-pattern grounding

| Concern | Pattern | Reference |
|---------|---------|-----------|
| Pipeline structure | Prompt Chaining -- deterministic chain with validation gates between stages | p. 5 |
| Eval gates at deploy | Evaluation & Monitoring -- evalset regression testing before promotion | p. 312 |
| Baseline comparison | Evaluation & Monitoring -- compare candidate against production baseline | p. 305 |
| Safety gates | Guardrails/Safety -- red-team testing as a deployment gate | p. 298 |
| Checkpoint & rollback | Guardrails/Safety -- snapshot state before risky operations, revert on failure | p. 290 |
| Human approval | HITL -- human approval required for production deployments | p. 211 |
| Approval timeout | HITL -- approval gates with timeout and safe default | p. 214 |
| Deployment success criteria | Goal Setting & Monitoring -- SMART goals for canary evaluation | p. 185 |
| Canary promotion | Goal Setting & Monitoring -- `goals_met()` check to decide promotion | p. 188 |
| Automatic rollback | Exception Handling -- rollback on deployment failure | p. 209 |
| Error classification | Exception Handling -- classify errors to determine rollback vs. retry | p. 205 |
| Cost-aware rollout | Resource-Aware Optimization -- canary traffic splitting to control cost exposure | p. 255-272 |

### Responsibilities

1. **Build** agent artifacts by assembling prompt, tools, guardrails, memory config, model config, and eval criteria into a single immutable snapshot.
2. **Validate** artifact integrity: schema conformance, reference resolution, dependency availability.
3. **Test** artifacts against evalsets and red-team suites before any live traffic exposure.
4. **Deploy** artifacts using blue-green, canary, or progressive rollout strategies.
5. **Monitor** deployed artifacts against SMART quality goals, triggering automatic rollback on degradation.
6. **Roll back** to the previous known-good artifact within seconds, automatically or manually.
7. **Manage environments** (development, staging, production) with strict promotion rules.
8. **Coordinate team deployments** by deploying multiple agents as a single atomic unit.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Agent Deployment Pipeline                               │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐    │
│  │  Artifact     │  │  Build       │  │  Deployment  │  │  Rollback     │   │
│  │  Builder      │  │  Pipeline    │  │  Strategies  │  │  Controller   │   │
│  │  (assemble &  │  │  (validate → │  │  (blue-green │  │  (auto &      │   │
│  │   snapshot)   │  │   test →     │  │   canary,    │  │   manual)     │   │
│  │              │  │   evaluate → │  │   progressive│  │               │    │
│  │              │  │   stage →    │  │   rollout)   │  │               │    │
│  │              │  │   deploy)    │  │              │  │               │    │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘    │
│         │                 │                  │                   │          │
│  ┌──────┴─────────────────┴──────────────────┴───────────────────┴────────┐ │
│  │                    Environment Manager                                  │  │
│  │        (dev → staging → production promotion rules)                    │ │
│  └──────┬─────────────────┬──────────────────┬───────────────────┬────────┘ │
│         │                 │                  │                   │          │
│  ┌──────┴───────┐  ┌─────┴────────┐  ┌──────┴───────┐  ┌───────┴────────┐   │
│  │  Team         │  │  Canary      │  │  HITL        │  │  Audit &       │  │
│  │  Deployment   │  │  Evaluator   │  │  Approval    │  │  Event Log     │  │
│  │  Coordinator  │  │  (goals_met) │  │  Gate        │  │                │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Agent Artifact Schema

An agent artifact is the **complete deployable unit**. It bundles every configuration dimension that affects agent behavior into a single, content-addressable, immutable snapshot. This goes beyond the agent identity record (see `00-system-overview.md`, Section 3.2) by pinning every reference to a specific resolved version.

### 2.1 Canonical schema

```json
{
  "$schema": "https://agentforge.io/schemas/agent-artifact/v1.json",
  "artifact_id": "art_7f3a9b2e4c1d",
  "agent_id": "agt_research_001",
  "agent_name": "ResearchAgent",
  "artifact_version": "2.3.1-build.48",
  "created_at": "2026-02-27T14:30:00Z",
  "created_by": {
    "type": "pipeline",
    "identity": "deployment-pipeline:build-48",
    "trigger": "manual"
  },
  "content_hash": "sha256:a4f8c2e91b3d7f6a5c0e8d2b4a6f9c1e3d5b7a9f0c2e4d6b8a0f2c4e6d8b0a2",

  "prompt": {
    "prompt_id": "prm_a1b2c3d4e5f6",
    "semver": "2.3.1",
    "content_hash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "resolved_content_hash": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "registry_ref": "prompt-registry://research-agent@2.3.1"
  },

  "tools": [
    {
      "tool_ref": "mcp://search-server/web_search",
      "server_version": "1.4.2",
      "config_hash": "sha256:abc123...",
      "required": true
    },
    {
      "tool_ref": "mcp://search-server/scholar_search",
      "server_version": "1.4.2",
      "config_hash": "sha256:def456...",
      "required": true
    }
  ],

  "guardrail_policies": [
    {
      "policy_id": "no-pii-output",
      "version": "1.0.3",
      "config_hash": "sha256:ghi789..."
    },
    {
      "policy_id": "citation-required",
      "version": "2.1.0",
      "config_hash": "sha256:jkl012..."
    }
  ],

  "memory_config": {
    "memory_backend": "postgresql",
    "context_window_strategy": "sliding_window_with_summary",
    "max_context_tokens": 32000,
    "rag_enabled": true,
    "rag_collection": "research-knowledge-base",
    "session_state_prefix": "user:",
    "config_hash": "sha256:mno345..."
  },

  "model_config": {
    "default_tier": "balanced",
    "allowed_tiers": ["fast", "balanced", "frontier"],
    "escalation_enabled": true,
    "max_iterations": 10,
    "temperature": 0.3,
    "config_hash": "sha256:pqr678..."
  },

  "eval_criteria": {
    "evalset_id": "evalset_research_v3",
    "min_overall_score": 0.88,
    "dimension_floors": {
      "accuracy": 0.85,
      "citation_quality": 0.80,
      "format_compliance": 0.90,
      "safety": 0.99
    },
    "red_team_suite_id": "redteam_research_v2",
    "red_team_pass_rate": 0.95,
    "trajectory_match_type": "in_order",
    "config_hash": "sha256:stu901..."
  },

  "schemas": {
    "input_schema": {
      "type": "object",
      "properties": {
        "query": { "type": "string" }
      },
      "required": ["query"]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "summary": { "type": "string" },
        "sources": { "type": "array" }
      },
      "required": ["summary", "sources"]
    }
  },

  "dependencies": {
    "mcp_servers": ["search-server@1.4.2"],
    "shared_prompts": ["prompt-registry://shared/safety-preamble@2.1.0"],
    "peer_agents": []
  },

  "deployment": {
    "target_environment": "production",
    "strategy": "canary",
    "canary_config": {
      "initial_traffic_pct": 5,
      "increment_pct": 15,
      "evaluation_window_minutes": 30,
      "max_steps": 5,
      "promotion_threshold": 0.88,
      "rollback_threshold": 0.82
    }
  },

  "metadata": {
    "team_id": "team-alpha",
    "tags": ["research", "web-search", "citations"],
    "build_number": 48,
    "pipeline_run_id": "run_abc123",
    "parent_artifact_id": "art_6e2a8b1d3c0f",
    "change_summary": "Updated prompt to APA-7 citation style; tightened safety policy version."
  }
}
```

### 2.2 Field semantics

| Field | Purpose | Immutability |
|-------|---------|-------------|
| `artifact_id` | Globally unique identifier for this specific build | Immutable |
| `artifact_version` | Semver of the agent + build number for traceability | Immutable |
| `content_hash` | SHA-256 of the entire artifact JSON (excluding `content_hash` itself) | Immutable |
| `prompt` | Pinned reference to a specific prompt version in the Prompt Registry (07) | Immutable |
| `tools` | Pinned references to specific MCP server versions with config hashes | Immutable |
| `guardrail_policies` | Pinned policy versions from the Guardrail System (04) | Immutable |
| `memory_config` | Memory backend, context strategy, RAG settings | Immutable |
| `model_config` | Model tier, temperature, iteration limits | Immutable |
| `eval_criteria` | Quality thresholds that must be met for deployment to proceed | Immutable |
| `schemas` | Input/output contract schemas (p. 126) | Immutable |
| `dependencies` | Explicit list of all external dependencies for availability checking | Immutable |
| `deployment` | Target environment and strategy configuration | Immutable |

### 2.3 Content addressing

The `content_hash` field is computed over the canonical JSON serialization (sorted keys, no whitespace) of all fields except `content_hash`, `artifact_id`, and `created_at`. This enables:

- **Deduplication**: Identical configurations produce the same hash, preventing redundant deployments.
- **Tamper detection**: Any modification to the artifact after build invalidates the hash.
- **Cache keying**: Resolved artifacts are cached under `app:artifact:{content_hash}` (Memory Management, p. 151).

```python
# Pseudocode: artifact content hash computation
import hashlib
import json

def compute_artifact_hash(artifact: dict) -> str:
    """Compute deterministic content hash for an agent artifact."""
    hashable = {
        k: v for k, v in artifact.items()
        if k not in ("content_hash", "artifact_id", "created_at")
    }
    canonical = json.dumps(hashable, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"
```

---

## 3. Build Pipeline

The build pipeline implements the Prompt Chaining pattern (p. 5) as a deterministic sequence of stages. Each stage produces structured output that feeds the next stage, and a validation gate between stages ensures that failures are caught early and never propagate.

### 3.1 Pipeline stages

```
┌───────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  ASSEMBLE  │───►│ VALIDATE │───►│   TEST   │───►│ EVALUATE │───►│  STAGE  │
│            │    │          │    │          │    │          │    │         │
│ Collect all│    │ Schema   │    │ Evalset  │    │ LLM-as-  │    │ Snapshot│
│ refs, pin  │    │ check,   │    │ regress- │    │ Judge +  │    │ to target│
│ versions,  │    │ dep avail│    │ ion,     │    │ red-team │    │ environ-│
│ build hash │    │ lint,    │    │ traject- │    │ suite,   │    │ ment    │
│            │    │ safety   │    │ ory      │    │ baseline │    │         │
│            │    │ scan     │    │ match    │    │ compare  │    │         │
└───────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
     │                │                │                │                │
     ▼                ▼                ▼                ▼                ▼
  artifact         pass/fail       test_results    eval_report     staged_id
  (draft)          + reasons       + coverage      + approval       (ready)
                                                   (HITL gate)
```

Each gate enforces a strict pass/fail contract. The pipeline halts on the first failure, logs the complete context, and emits an event to the Observability Platform (05).

### 3.2 Stage definitions

| Stage | Input | Gate Condition | Output | Pattern |
|-------|-------|---------------|--------|---------|
| **Assemble** | Agent ID + requested versions | All referenced versions exist and are in valid state | Draft artifact with `content_hash` | Prompt Chaining (p. 5) |
| **Validate** | Draft artifact | Schema passes JSON Schema validation; all dependencies reachable; lint rules pass; safety scan finds no policy violations | Validated artifact | Guardrails/Safety (p. 298) |
| **Test** | Validated artifact | Evalset regression score >= `min_overall_score`; all dimension floors met; trajectory match passes | Test results with coverage metrics | Evaluation & Monitoring (p. 312) |
| **Evaluate** | Test results + validated artifact | LLM-as-Judge score >= baseline; red-team pass rate >= threshold; HITL approval granted (for production) | Evaluation report with human sign-off | HITL (p. 211), Evaluation & Monitoring (p. 305) |
| **Stage** | Evaluation report + artifact | Target environment has capacity; no conflicting deployments in progress | Staged deployment record ready for activation | Goal Setting (p. 185) |

### 3.3 Pseudocode: Build Pipeline

```python
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
from datetime import datetime


class PipelineStage(str, Enum):
    ASSEMBLE = "assemble"
    VALIDATE = "validate"
    TEST = "test"
    EVALUATE = "evaluate"
    STAGE = "stage"
    DEPLOY = "deploy"


class StageResult(str, Enum):
    PASSED = "passed"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class GateVerdict:
    """Result of a pipeline gate check (Prompt Chaining, p. 5)."""
    stage: PipelineStage
    result: StageResult
    reasons: list[str] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    duration_ms: int = 0
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat())


@dataclass
class PipelineRun:
    """Tracks the full lifecycle of a single pipeline execution."""
    run_id: str
    agent_id: str
    artifact_id: Optional[str] = None
    target_environment: str = "staging"
    stages: list[GateVerdict] = field(default_factory=list)
    status: str = "pending"  # pending | running | succeeded | failed | cancelled
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    triggered_by: dict = field(default_factory=dict)


class AgentDeploymentPipeline:
    """Deterministic build-and-deploy pipeline for agent artifacts.

    Implements the Prompt Chaining pattern (p. 5): each stage is a
    deterministic step whose output feeds the next, with validation
    gates ensuring failures do not propagate downstream.
    """

    def __init__(
        self,
        prompt_registry,       # Subsystem 07
        eval_framework,        # Subsystem 08
        guardrail_system,      # Subsystem 04
        tool_manager,          # Subsystem 03
        environment_manager,
        observability,         # Subsystem 05
    ):
        self.prompt_registry = prompt_registry
        self.eval_framework = eval_framework
        self.guardrail_system = guardrail_system
        self.tool_manager = tool_manager
        self.env_manager = environment_manager
        self.observability = observability

    async def run(
        self,
        agent_id: str,
        target_environment: str,
        deployment_strategy: str = "canary",
        triggered_by: dict = None,
    ) -> PipelineRun:
        """Execute the full build pipeline for an agent.

        Stages execute sequentially (deterministic chain, p. 5).
        Pipeline halts on first gate failure.
        """
        pipeline_run = PipelineRun(
            run_id=generate_run_id(),
            agent_id=agent_id,
            target_environment=target_environment,
            status="running",
            started_at=datetime.utcnow().isoformat(),
            triggered_by=triggered_by or {},
        )

        self.observability.emit_event("pipeline.started", pipeline_run.__dict__)

        try:
            # --- STAGE 1: ASSEMBLE ---
            artifact, assemble_verdict = await self._assemble(agent_id)
            pipeline_run.stages.append(assemble_verdict)
            if assemble_verdict.result == StageResult.FAILED:
                return await self._finalize(pipeline_run, "failed")
            pipeline_run.artifact_id = artifact["artifact_id"]

            # --- STAGE 2: VALIDATE ---
            validate_verdict = await self._validate(artifact)
            pipeline_run.stages.append(validate_verdict)
            if validate_verdict.result == StageResult.FAILED:
                return await self._finalize(pipeline_run, "failed")

            # --- STAGE 3: TEST ---
            test_verdict = await self._test(artifact)
            pipeline_run.stages.append(test_verdict)
            if test_verdict.result == StageResult.FAILED:
                return await self._finalize(pipeline_run, "failed")

            # --- STAGE 4: EVALUATE ---
            eval_verdict = await self._evaluate(
                artifact, target_environment, triggered_by
            )
            pipeline_run.stages.append(eval_verdict)
            if eval_verdict.result == StageResult.FAILED:
                return await self._finalize(pipeline_run, "failed")

            # --- STAGE 5: STAGE ---
            stage_verdict = await self._stage(
                artifact, target_environment, deployment_strategy
            )
            pipeline_run.stages.append(stage_verdict)
            if stage_verdict.result == StageResult.FAILED:
                return await self._finalize(pipeline_run, "failed")

            # --- STAGE 6: DEPLOY ---
            deploy_verdict = await self._deploy(
                artifact, target_environment, deployment_strategy
            )
            pipeline_run.stages.append(deploy_verdict)
            if deploy_verdict.result == StageResult.FAILED:
                return await self._finalize(pipeline_run, "failed")

            return await self._finalize(pipeline_run, "succeeded")

        except Exception as e:
            # Exception Handling (p. 205): classify and log
            error_class = classify_error(e)  # transient | logic | unrecoverable
            self.observability.emit_event("pipeline.error", {
                "run_id": pipeline_run.run_id,
                "error": str(e),
                "error_class": error_class,
                "stage": pipeline_run.stages[-1].stage if pipeline_run.stages else None,
            })
            return await self._finalize(pipeline_run, "failed")

    # ── Stage Implementations ──────────────────────────────────────────

    async def _assemble(self, agent_id: str) -> tuple[dict, GateVerdict]:
        """Collect all references and pin them to specific versions."""
        start = now_ms()

        agent_config = await self.prompt_registry.get_agent_config(agent_id)
        prompt_version = await self.prompt_registry.get_production_version(
            agent_config["prompt_id"]
        )
        tool_refs = await self.tool_manager.resolve_tool_versions(
            agent_config["tools"]
        )
        policies = await self.guardrail_system.resolve_policy_versions(
            agent_config["guardrail_policies"]
        )

        artifact = build_artifact(
            agent_id=agent_id,
            prompt=prompt_version,
            tools=tool_refs,
            policies=policies,
            memory_config=agent_config["memory_config"],
            model_config=agent_config["model_config"],
            eval_criteria=agent_config["eval_criteria"],
            schemas=agent_config["schemas"],
        )
        artifact["content_hash"] = compute_artifact_hash(artifact)

        verdict = GateVerdict(
            stage=PipelineStage.ASSEMBLE,
            result=StageResult.PASSED,
            metrics={"component_count": len(tool_refs) + len(policies) + 1},
            duration_ms=now_ms() - start,
        )
        return artifact, verdict

    async def _validate(self, artifact: dict) -> GateVerdict:
        """Schema validation, dependency checks, lint, safety scan (p. 298)."""
        start = now_ms()
        reasons = []

        # 1. JSON Schema conformance
        schema_errors = validate_json_schema(artifact, ARTIFACT_SCHEMA)
        if schema_errors:
            reasons.extend([f"Schema: {e}" for e in schema_errors])

        # 2. Dependency availability check
        for dep in artifact["dependencies"]["mcp_servers"]:
            if not await self.tool_manager.is_available(dep):
                reasons.append(f"MCP server unavailable: {dep}")

        # 3. Prompt lint (no unresolved variables, no deprecated instructions)
        lint_issues = await self.prompt_registry.lint(
            artifact["prompt"]["registry_ref"]
        )
        if lint_issues:
            reasons.extend([f"Lint: {i}" for i in lint_issues])

        # 4. Safety scan -- red-team pre-check (p. 298)
        safety_result = await self.guardrail_system.safety_scan(artifact)
        if not safety_result.passed:
            reasons.extend([f"Safety: {v}" for v in safety_result.violations])

        result = StageResult.FAILED if reasons else StageResult.PASSED
        return GateVerdict(
            stage=PipelineStage.VALIDATE,
            result=result,
            reasons=reasons,
            duration_ms=now_ms() - start,
        )

    async def _test(self, artifact: dict) -> GateVerdict:
        """Evalset regression and trajectory testing (p. 312)."""
        start = now_ms()
        reasons = []
        criteria = artifact["eval_criteria"]

        # Run evalset regression (Evaluation Framework, p. 312)
        eval_result = await self.eval_framework.run_evalset(
            evalset_id=criteria["evalset_id"],
            agent_artifact=artifact,
        )

        if eval_result.overall_score < criteria["min_overall_score"]:
            reasons.append(
                f"Overall score {eval_result.overall_score:.3f} "
                f"< threshold {criteria['min_overall_score']:.3f}"
            )

        # Check per-dimension floors
        for dim, floor in criteria["dimension_floors"].items():
            actual = eval_result.dimension_scores.get(dim, 0.0)
            if actual < floor:
                reasons.append(
                    f"Dimension '{dim}' score {actual:.3f} < floor {floor:.3f}"
                )

        # Trajectory match (p. 308)
        traj_result = await self.eval_framework.run_trajectory_eval(
            evalset_id=criteria["evalset_id"],
            agent_artifact=artifact,
            match_type=criteria["trajectory_match_type"],
        )
        if not traj_result.passed:
            reasons.append(f"Trajectory check failed: {traj_result.explanation}")

        result = StageResult.FAILED if reasons else StageResult.PASSED
        return GateVerdict(
            stage=PipelineStage.TEST,
            result=result,
            reasons=reasons,
            metrics={
                "overall_score": eval_result.overall_score,
                "dimension_scores": eval_result.dimension_scores,
                "trajectory_tool_accuracy": traj_result.tool_accuracy,
            },
            duration_ms=now_ms() - start,
        )

    async def _evaluate(
        self, artifact: dict, target_env: str, triggered_by: dict
    ) -> GateVerdict:
        """LLM-as-Judge + red-team suite + baseline comparison + HITL gate."""
        start = now_ms()
        reasons = []
        criteria = artifact["eval_criteria"]

        # 1. Red-team suite (Guardrails/Safety, p. 298)
        redteam_result = await self.guardrail_system.run_red_team_suite(
            suite_id=criteria["red_team_suite_id"],
            agent_artifact=artifact,
        )
        if redteam_result.pass_rate < criteria["red_team_pass_rate"]:
            reasons.append(
                f"Red-team pass rate {redteam_result.pass_rate:.3f} "
                f"< threshold {criteria['red_team_pass_rate']:.3f}"
            )

        # 2. Baseline comparison (Evaluation & Monitoring, p. 305)
        current_prod = await self.env_manager.get_active_artifact(
            artifact["agent_id"], "production"
        )
        if current_prod:
            baseline_score = current_prod.get("last_eval_score", 0.0)
            candidate_score = artifact.get("last_eval_score", 0.0)
            if candidate_score < baseline_score - 0.02:  # 2% tolerance
                reasons.append(
                    f"Candidate score {candidate_score:.3f} regresses from "
                    f"baseline {baseline_score:.3f} (tolerance 0.02)"
                )

        # 3. HITL approval gate for production (p. 211, p. 214)
        if target_env == "production" and not reasons:
            approval = await self._request_hitl_approval(
                artifact=artifact,
                triggered_by=triggered_by,
                timeout_minutes=60,  # Approval timeout (p. 214)
            )
            if not approval.granted:
                reasons.append(
                    f"HITL approval denied: {approval.reason}"
                )

        result = StageResult.FAILED if reasons else StageResult.PASSED
        return GateVerdict(
            stage=PipelineStage.EVALUATE,
            result=result,
            reasons=reasons,
            metrics={
                "red_team_pass_rate": redteam_result.pass_rate,
                "hitl_approved": not reasons,
            },
            duration_ms=now_ms() - start,
        )

    async def _request_hitl_approval(
        self, artifact: dict, triggered_by: dict, timeout_minutes: int
    ):
        """Request human approval with timeout-with-safe-default (p. 214).

        If timeout expires, the safe default is DENY -- the deployment
        does not proceed without explicit human approval.
        """
        approval_request = {
            "artifact_id": artifact["artifact_id"],
            "agent_id": artifact["agent_id"],
            "artifact_version": artifact["artifact_version"],
            "change_summary": artifact["metadata"]["change_summary"],
            "eval_metrics": artifact.get("last_eval_metrics", {}),
            "requested_by": triggered_by,
            "timeout_minutes": timeout_minutes,
        }
        return await self.env_manager.request_approval(approval_request)

    async def _stage(
        self, artifact: dict, target_env: str, strategy: str
    ) -> GateVerdict:
        """Prepare the deployment in the target environment."""
        start = now_ms()
        reasons = []

        # Check environment capacity
        env_status = await self.env_manager.check_capacity(target_env)
        if not env_status.has_capacity:
            reasons.append(f"Environment '{target_env}' at capacity")

        # Check no conflicting deployments
        active_deployments = await self.env_manager.get_active_deployments(
            target_env, artifact["agent_id"]
        )
        for dep in active_deployments:
            if dep["status"] == "in_progress":
                reasons.append(
                    f"Conflicting deployment in progress: {dep['deployment_id']}"
                )

        if not reasons:
            await self.env_manager.create_staged_deployment(
                artifact=artifact,
                environment=target_env,
                strategy=strategy,
            )

        result = StageResult.FAILED if reasons else StageResult.PASSED
        return GateVerdict(
            stage=PipelineStage.STAGE,
            result=result,
            reasons=reasons,
            duration_ms=now_ms() - start,
        )

    async def _deploy(
        self, artifact: dict, target_env: str, strategy: str
    ) -> GateVerdict:
        """Execute the deployment using the selected strategy."""
        start = now_ms()

        deployer = self._get_deployer(strategy)
        deploy_result = await deployer.deploy(artifact, target_env)

        return GateVerdict(
            stage=PipelineStage.DEPLOY,
            result=StageResult.PASSED if deploy_result.success else StageResult.FAILED,
            reasons=deploy_result.reasons,
            metrics=deploy_result.metrics,
            duration_ms=now_ms() - start,
        )

    def _get_deployer(self, strategy: str):
        """Factory for deployment strategy implementations."""
        deployers = {
            "blue_green": BlueGreenDeployer(self.env_manager, self.observability),
            "canary": CanaryDeployer(self.env_manager, self.eval_framework, self.observability),
            "progressive": ProgressiveDeployer(self.env_manager, self.eval_framework, self.observability),
            "immediate": ImmediateDeployer(self.env_manager, self.observability),
        }
        return deployers[strategy]

    async def _finalize(self, pipeline_run: PipelineRun, status: str) -> PipelineRun:
        """Record final pipeline state and emit completion event."""
        pipeline_run.status = status
        pipeline_run.completed_at = datetime.utcnow().isoformat()

        self.observability.emit_event("pipeline.completed", {
            "run_id": pipeline_run.run_id,
            "agent_id": pipeline_run.agent_id,
            "artifact_id": pipeline_run.artifact_id,
            "status": status,
            "stage_count": len(pipeline_run.stages),
            "failed_stage": next(
                (s.stage for s in pipeline_run.stages if s.result == StageResult.FAILED),
                None,
            ),
            "total_duration_ms": sum(s.duration_ms for s in pipeline_run.stages),
        })

        await store_pipeline_run(pipeline_run)
        return pipeline_run
```

---

## 4. Deployment Strategies

The pipeline supports four deployment strategies, each offering a different tradeoff between safety, speed, and resource consumption. The strategy is selected per-deployment and encoded in the artifact's `deployment` section.

### 4.1 Strategy comparison

| Strategy | Risk | Speed | Cost | Use Case |
|----------|------|-------|------|----------|
| **Blue-Green** | Low | Fast cutover | 2x resources during transition | Major version changes, schema-breaking changes |
| **Canary** | Very low | Gradual (30min - 4h) | 1.05x - 1.5x resources | Standard production deployments |
| **Progressive** | Very low | Slowest (hours - days) | Variable | High-stakes agents, first-time deployments |
| **Immediate** | High | Instant | 1x resources | Emergency hotfixes (requires HITL override) |

### 4.2 Blue-Green Deployment

Blue-green deployment maintains two complete environments (blue and green). At any time, one is live (serving traffic) and the other is idle (staged with the new artifact). Cutover is a single routing switch.

```
                         BEFORE CUTOVER
┌─────────────────────────────────────────────────────┐
│                                                       │
│   Traffic ──────────► ┌───────────────────────┐      │
│   (100%)               │   BLUE (current v2.3.0)│      │
│                        │   ██████████████████████│      │
│                        └───────────────────────┘      │
│                                                       │
│                        ┌───────────────────────┐      │
│                        │   GREEN (new v2.3.1)   │      │
│                        │   (staged, idle)       │      │
│                        └───────────────────────┘      │
│                                                       │
│                         AFTER CUTOVER                 │
│                                                       │
│                        ┌───────────────────────┐      │
│                        │   BLUE (old v2.3.0)    │      │
│                        │   (idle, rollback       │      │
│                        │    target)              │      │
│                        └───────────────────────┘      │
│                                                       │
│   Traffic ──────────► ┌───────────────────────┐      │
│   (100%)               │   GREEN (new v2.3.1)  │      │
│                        │   ██████████████████████│      │
│                        └───────────────────────┘      │
└─────────────────────────────────────────────────────┘
```

Rollback is simply switching back to the blue environment. The old artifact remains warm and ready for instant reactivation.

### 4.3 Canary Deployment

Canary deployment gradually shifts traffic from the current artifact to the new one, evaluating quality at each step. If quality degrades below the rollback threshold, traffic is immediately routed back to the current artifact.

```
Step 1:  ████████████████████████████████████████████████░░  (5% canary)
         current v2.3.0 ──────────────────────────── new v2.3.1
                                                     ▲
                                            evaluate goals_met() (p. 188)

Step 2:  ████████████████████████████████████████░░░░░░░░░░  (20% canary)
         current v2.3.0 ─────────────────── new v2.3.1
                                             ▲
                                    evaluate goals_met()

Step 3:  ████████████████████████████░░░░░░░░░░░░░░░░░░░░░░  (35% canary)
         current v2.3.0 ─────── new v2.3.1
                                 ▲
                        evaluate goals_met()

Step 4:  ████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  (50% canary)
         current ────── new v2.3.1
                         ▲
                evaluate goals_met()

Step 5:  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  (100% new)
         new v2.3.1 ─────────────────────────────────────────
         PROMOTED (canary complete)
```

### 4.4 Pseudocode: Canary Evaluator

```python
from dataclasses import dataclass
from enum import Enum


class CanaryDecision(str, Enum):
    PROMOTE = "promote"       # Increase traffic to canary
    HOLD = "hold"             # Keep current traffic split
    ROLLBACK = "rollback"     # Revert all traffic to current


@dataclass
class CanaryStepResult:
    step: int
    traffic_pct: float
    sample_size: int
    canary_score: float
    baseline_score: float
    decision: CanaryDecision
    reasons: list[str]
    goals_met: bool


class CanaryEvaluator:
    """Evaluates canary deployment health using SMART goals (p. 185).

    At each canary step, the evaluator collects quality metrics from
    the canary traffic slice and compares against the production baseline.
    Promotion decisions use goals_met() (p. 188).

    Traffic splitting is cost-aware (Resource-Aware Optimization, p. 255-272):
    canary starts at a small percentage to limit cost exposure during
    the most uncertain phase, then increases as confidence grows.
    """

    def __init__(
        self,
        eval_framework,       # Subsystem 08
        observability,        # Subsystem 05
        promotion_threshold: float = 0.88,
        rollback_threshold: float = 0.82,
        min_sample_size: int = 50,
    ):
        self.eval_framework = eval_framework
        self.observability = observability
        self.promotion_threshold = promotion_threshold
        self.rollback_threshold = rollback_threshold
        self.min_sample_size = min_sample_size

    async def evaluate_step(
        self,
        deployment_id: str,
        canary_artifact: dict,
        baseline_artifact: dict,
        current_step: int,
        traffic_pct: float,
        evaluation_window_minutes: int,
    ) -> CanaryStepResult:
        """Evaluate one step of a canary deployment.

        Implements goals_met() pattern (p. 188):
        - Specific: Quality metrics >= promotion_threshold
        - Measurable: LLM-as-Judge scores on canary traffic
        - Achievable: Compared against known production baseline
        - Relevant: Same evalset dimensions as the agent's criteria
        - Time-bound: evaluation_window_minutes per step
        """
        # Collect metrics from canary traffic slice
        canary_metrics = await self.observability.collect_metrics(
            deployment_id=deployment_id,
            artifact_id=canary_artifact["artifact_id"],
            window_minutes=evaluation_window_minutes,
        )

        # Collect metrics from baseline (production) traffic
        baseline_metrics = await self.observability.collect_metrics(
            deployment_id=deployment_id,
            artifact_id=baseline_artifact["artifact_id"],
            window_minutes=evaluation_window_minutes,
        )

        canary_score = canary_metrics.overall_quality_score
        baseline_score = baseline_metrics.overall_quality_score
        sample_size = canary_metrics.request_count

        reasons = []
        decision = CanaryDecision.HOLD  # Default: hold and wait for more data

        # Insufficient data -- hold position
        if sample_size < self.min_sample_size:
            reasons.append(
                f"Insufficient sample size: {sample_size} < {self.min_sample_size}"
            )
            return CanaryStepResult(
                step=current_step,
                traffic_pct=traffic_pct,
                sample_size=sample_size,
                canary_score=canary_score,
                baseline_score=baseline_score,
                decision=CanaryDecision.HOLD,
                reasons=reasons,
                goals_met=False,
            )

        # Check rollback condition (Exception Handling, p. 209)
        if canary_score < self.rollback_threshold:
            reasons.append(
                f"Canary score {canary_score:.3f} < rollback threshold "
                f"{self.rollback_threshold:.3f}"
            )
            decision = CanaryDecision.ROLLBACK

        # Check for significant regression against baseline (p. 305)
        elif canary_score < baseline_score - 0.03:
            reasons.append(
                f"Canary score {canary_score:.3f} regresses from baseline "
                f"{baseline_score:.3f} by more than tolerance (0.03)"
            )
            decision = CanaryDecision.ROLLBACK

        # Check error rate spike
        elif canary_metrics.error_rate > baseline_metrics.error_rate * 2:
            reasons.append(
                f"Canary error rate {canary_metrics.error_rate:.3f} > "
                f"2x baseline {baseline_metrics.error_rate:.3f}"
            )
            decision = CanaryDecision.ROLLBACK

        # Check promotion condition -- goals_met() (p. 188)
        elif canary_score >= self.promotion_threshold:
            reasons.append(
                f"Canary score {canary_score:.3f} >= promotion threshold "
                f"{self.promotion_threshold:.3f}"
            )
            decision = CanaryDecision.PROMOTE

        else:
            reasons.append(
                f"Canary score {canary_score:.3f} between rollback "
                f"({self.rollback_threshold:.3f}) and promotion "
                f"({self.promotion_threshold:.3f}) thresholds -- holding"
            )
            decision = CanaryDecision.HOLD

        goals_met = decision == CanaryDecision.PROMOTE

        self.observability.emit_event("canary.step.evaluated", {
            "deployment_id": deployment_id,
            "step": current_step,
            "traffic_pct": traffic_pct,
            "canary_score": canary_score,
            "baseline_score": baseline_score,
            "decision": decision.value,
            "goals_met": goals_met,
            "sample_size": sample_size,
        })

        return CanaryStepResult(
            step=current_step,
            traffic_pct=traffic_pct,
            sample_size=sample_size,
            canary_score=canary_score,
            baseline_score=baseline_score,
            decision=decision,
            reasons=reasons,
            goals_met=goals_met,
        )

    async def run_canary_loop(
        self,
        deployment_id: str,
        canary_artifact: dict,
        baseline_artifact: dict,
        canary_config: dict,
    ) -> str:
        """Run the full canary deployment loop.

        Returns final status: 'promoted' | 'rolled_back' | 'timed_out'.

        Cost-aware traffic splitting (p. 255-272): starts at a small
        percentage (e.g., 5%) to limit cost exposure, then ramps up
        as confidence grows.
        """
        traffic_pct = canary_config["initial_traffic_pct"]
        increment = canary_config["increment_pct"]
        window = canary_config["evaluation_window_minutes"]
        max_steps = canary_config["max_steps"]

        for step in range(1, max_steps + 1):
            # Set traffic split
            await self.observability.set_traffic_split(
                deployment_id=deployment_id,
                canary_pct=traffic_pct,
            )

            # Wait for evaluation window to collect sufficient data
            await wait_minutes(window)

            # Evaluate
            result = await self.evaluate_step(
                deployment_id=deployment_id,
                canary_artifact=canary_artifact,
                baseline_artifact=baseline_artifact,
                current_step=step,
                traffic_pct=traffic_pct,
                evaluation_window_minutes=window,
            )

            if result.decision == CanaryDecision.ROLLBACK:
                return "rolled_back"

            if result.decision == CanaryDecision.PROMOTE:
                if traffic_pct >= 100:
                    return "promoted"
                # Increase canary traffic
                traffic_pct = min(traffic_pct + increment, 100)

            # HOLD: stay at current traffic, re-evaluate on next iteration

        # Exhausted all steps without full promotion
        return "timed_out"
```

### 4.5 Progressive Rollout

Progressive rollout extends the canary pattern with finer-grained control, longer evaluation windows, and explicit human checkpoints at key thresholds:

| Phase | Traffic % | Duration | Gate |
|-------|-----------|----------|------|
| Shadow | 0% (dual-write, no serve) | 1-4 hours | Automated eval |
| Canary | 1-5% | 2-8 hours | Automated eval |
| Early Adopters | 10-25% | 4-24 hours | HITL checkpoint (p. 211) |
| Majority | 50-75% | 24-72 hours | Automated eval + HITL |
| Full | 100% | -- | Final sign-off |

Progressive rollout is recommended for first-time deployments of new agents and for agents with `critical` severity guardrail policies.

---

## 5. Environment Management

### 5.1 Environment hierarchy

The platform maintains three environments with strict promotion rules. Each environment has its own isolated set of active agent artifacts, traffic routing, and metric collection.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Environment Hierarchy                              │
│                                                                         │
│  ┌─────────────────┐    ┌──────────────────┐    ┌────────────────────┐  │
│  │  DEVELOPMENT     │───►│  STAGING          │───►│  PRODUCTION        │  │
│  │                  │    │                   │    │                    │  │
│  │  - Auto-deploy   │    │  - Evalset gate   │    │  - HITL approval   │  │
│  │    on commit     │    │  - Red-team suite  │    │  - Canary/BG gate  │  │
│  │  - No quality    │    │  - Baseline        │    │  - Quality mon.    │  │
│  │    gates         │    │    comparison      │    │  - Auto-rollback   │  │
│  │  - Ephemeral     │    │  - Load testing    │    │  - Audit logging   │  │
│  │  - Per-developer │    │  - Shared team env │    │  - 99.9% SLA       │  │
│  └─────────────────┘    └──────────────────┘    └────────────────────┘  │
│         │                        │                        │             │
│         ▼                        ▼                        ▼             │
│    No rollback              Auto-rollback on         Auto-rollback on   │
│    needed                   eval regression          quality degradation│
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Promotion rules

| Transition | Gate | Automated? | Details |
|-----------|------|-----------|---------|
| dev --> staging | Validate + Test stages pass | Yes | Automatically promoted when all build stages pass. No HITL gate. |
| staging --> production | Evaluate stage passes + HITL approval (p. 211) | No | Requires human approval. Approval request includes full eval report, baseline comparison, and red-team results. Timeout-with-safe-default: deny after 60 minutes (p. 214). |
| production --> rollback | Quality degradation detected OR manual trigger | Conditional | Automatic on quality degradation (see Section 6). Manual rollback requires HITL authorization. |

### 5.3 Environment isolation

Each environment maintains independent:

- **Artifact store**: Active and historical artifacts for each agent.
- **Traffic routing**: Separate load balancer configuration with traffic-split support.
- **Metric pipeline**: Independent metric collection and aggregation to prevent cross-contamination of quality data.
- **Secret scope**: Environment-specific API keys and credentials (no production secrets in dev/staging).

```python
# Pseudocode: environment manager
@dataclass
class Environment:
    name: str                           # "development" | "staging" | "production"
    active_artifacts: dict[str, str]    # agent_id -> artifact_id
    traffic_config: dict                # routing rules
    metric_namespace: str               # isolated metric prefix
    secret_scope: str                   # vault path prefix
    sla_target: float                   # e.g., 0.999 for production


class EnvironmentManager:
    """Manages environment lifecycle and promotion rules."""

    PROMOTION_RULES = {
        "development": "staging",
        "staging": "production",
    }

    async def promote_artifact(
        self,
        artifact: dict,
        from_env: str,
        to_env: str,
        promoted_by: dict,
    ) -> dict:
        """Promote an artifact from one environment to the next."""
        expected_target = self.PROMOTION_RULES.get(from_env)
        if expected_target != to_env:
            raise InvalidPromotionError(
                f"Cannot promote from '{from_env}' to '{to_env}'. "
                f"Expected target: '{expected_target}'."
            )

        # HITL gate for production promotion (p. 211)
        if to_env == "production":
            if promoted_by.get("type") != "human":
                raise HITLRequiredError(
                    "Human approval required for production promotion (p. 211)"
                )

        # Snapshot current state for rollback (Checkpoint, p. 290)
        checkpoint = await self.create_checkpoint(to_env, artifact["agent_id"])

        # Activate artifact in target environment
        deployment = await self.activate_artifact(artifact, to_env)
        deployment["rollback_checkpoint"] = checkpoint

        return deployment

    async def create_checkpoint(self, environment: str, agent_id: str) -> dict:
        """Checkpoint current state before deployment (p. 290).
        Captures current active artifact and routing config."""
        env = self.get_environment(environment)
        return {
            "checkpoint_id": generate_checkpoint_id(),
            "environment": environment,
            "agent_id": agent_id,
            "previous_artifact_id": env.active_artifacts.get(agent_id),
            "traffic_config_snapshot": env.traffic_config.copy(),
            "created_at": datetime.utcnow().isoformat(),
        }
```

---

## 6. Rollback Mechanism

Rollback is a first-class operation in the deployment pipeline. Because every artifact is immutable and every deployment creates a checkpoint (p. 290), rollback is deterministic: restore the previous artifact and routing configuration from the checkpoint.

### 6.1 Rollback triggers

| Trigger | Type | Response Time | Authority |
|---------|------|--------------|-----------|
| Canary quality below rollback threshold | Automatic | < 30 seconds | Pipeline (no HITL) |
| Error rate spike > 2x baseline | Automatic | < 30 seconds | Pipeline (no HITL) |
| Latency P99 > 3x baseline | Automatic | < 60 seconds | Pipeline (no HITL) |
| Guardrail violation rate spike | Automatic | < 30 seconds | Pipeline (no HITL) |
| Manual operator trigger | Manual | < 60 seconds | HITL required (p. 211) |
| Eval score drift below floor (post-deploy) | Automatic | < 5 minutes | Pipeline (no HITL) |
| Critical safety incident | Automatic | < 10 seconds | Guardrail System (04) |

### 6.2 Rollback strategies

| Strategy | Description | Use Case |
|----------|-------------|----------|
| **Instant rollback** | Restore previous artifact from checkpoint. Skip all pipeline gates. | Active quality degradation, safety incidents |
| **Graceful rollback** | Drain canary traffic to 0%, then restore. Active requests complete on current version. | Canary evaluation failure where current traffic is not impacted |
| **Targeted rollback** | Deploy a specific historical artifact through the full pipeline (accelerated gates). | Reverting to a known-good version from several releases ago |

### 6.3 Pseudocode: Rollback Controller

```python
from dataclasses import dataclass
from enum import Enum
from typing import Optional


class RollbackType(str, Enum):
    INSTANT = "instant"
    GRACEFUL = "graceful"
    TARGETED = "targeted"


class RollbackTrigger(str, Enum):
    CANARY_QUALITY = "canary_quality_degradation"
    ERROR_RATE = "error_rate_spike"
    LATENCY = "latency_spike"
    GUARDRAIL_VIOLATIONS = "guardrail_violation_spike"
    SAFETY_INCIDENT = "safety_incident"
    EVAL_DRIFT = "eval_score_drift"
    MANUAL = "manual_operator"


@dataclass
class RollbackResult:
    rollback_id: str
    deployment_id: str
    agent_id: str
    rolled_back_from: str   # artifact_id
    rolled_back_to: str     # artifact_id
    rollback_type: RollbackType
    trigger: RollbackTrigger
    duration_ms: int
    success: bool
    reason: str


class RollbackController:
    """Controls automatic and manual rollback for agent deployments.

    Automatic rollback is triggered by quality degradation (p. 209, p. 305).
    Manual rollback requires HITL authorization (p. 211).
    All rollbacks use checkpoint/restore (p. 290).
    """

    def __init__(
        self,
        environment_manager,
        observability,        # Subsystem 05
        guardrail_system,     # Subsystem 04
    ):
        self.env_manager = environment_manager
        self.observability = observability
        self.guardrail_system = guardrail_system

    async def auto_rollback(
        self,
        deployment_id: str,
        trigger: RollbackTrigger,
        evidence: dict,
    ) -> RollbackResult:
        """Execute automatic rollback on quality degradation.

        Automatic rollback does NOT require HITL approval -- speed is
        critical. The system prefers a false-positive rollback over
        serving degraded quality to users (Exception Handling, p. 209).

        Error classification (p. 205) determines whether to rollback
        or retry:
        - Transient errors (network, timeout): retry up to 3 times
        - Logic errors (eval failure, quality drop): rollback
        - Unrecoverable errors (safety incident): rollback + quarantine
        """
        start = now_ms()

        deployment = await self.env_manager.get_deployment(deployment_id)
        checkpoint = deployment["rollback_checkpoint"]

        # Classify the error to determine action (p. 205)
        error_class = self._classify_trigger(trigger, evidence)

        if error_class == "transient":
            # Retry logic -- do not rollback yet
            retry_count = evidence.get("retry_count", 0)
            if retry_count < 3:
                self.observability.emit_event("rollback.retry", {
                    "deployment_id": deployment_id,
                    "trigger": trigger.value,
                    "retry_count": retry_count + 1,
                })
                return RollbackResult(
                    rollback_id=generate_rollback_id(),
                    deployment_id=deployment_id,
                    agent_id=deployment["agent_id"],
                    rolled_back_from=deployment["artifact_id"],
                    rolled_back_to=deployment["artifact_id"],  # No change
                    rollback_type=RollbackType.GRACEFUL,
                    trigger=trigger,
                    duration_ms=now_ms() - start,
                    success=False,
                    reason=f"Transient error, retrying ({retry_count + 1}/3)",
                )

        # --- EXECUTE ROLLBACK ---

        # For safety incidents: quarantine the agent immediately
        if trigger == RollbackTrigger.SAFETY_INCIDENT:
            await self.guardrail_system.quarantine_agent(deployment["agent_id"])

        # Restore from checkpoint (p. 290)
        previous_artifact_id = checkpoint["previous_artifact_id"]
        if not previous_artifact_id:
            # No previous artifact -- this was the first deployment.
            # Deactivate the agent entirely.
            await self.env_manager.deactivate_agent(
                deployment["agent_id"], deployment["environment"]
            )
            rolled_back_to = "none"
        else:
            await self.env_manager.restore_checkpoint(checkpoint)
            rolled_back_to = previous_artifact_id

        # Invalidate all caches for this agent
        await self.env_manager.invalidate_caches(deployment["agent_id"])

        duration = now_ms() - start

        result = RollbackResult(
            rollback_id=generate_rollback_id(),
            deployment_id=deployment_id,
            agent_id=deployment["agent_id"],
            rolled_back_from=deployment["artifact_id"],
            rolled_back_to=rolled_back_to,
            rollback_type=RollbackType.INSTANT,
            trigger=trigger,
            duration_ms=duration,
            success=True,
            reason=f"Auto-rollback on {trigger.value}: {evidence.get('reason', '')}",
        )

        # Emit critical event for Observability Platform
        self.observability.emit_event("deployment.rollback", {
            **result.__dict__,
            "evidence": evidence,
        }, severity="critical")

        return result

    async def manual_rollback(
        self,
        deployment_id: str,
        target_artifact_id: Optional[str],
        authorized_by: dict,
        reason: str,
    ) -> RollbackResult:
        """Execute manual rollback. Requires HITL authorization (p. 211)."""
        if authorized_by.get("type") != "human":
            raise HITLRequiredError(
                "Manual rollback requires human authorization (p. 211)"
            )

        start = now_ms()
        deployment = await self.env_manager.get_deployment(deployment_id)

        if target_artifact_id:
            # Targeted rollback to a specific artifact
            target = await self.env_manager.get_artifact(target_artifact_id)
            await self.env_manager.activate_artifact(
                target, deployment["environment"]
            )
        else:
            # Rollback to checkpoint (most recent previous artifact)
            checkpoint = deployment["rollback_checkpoint"]
            await self.env_manager.restore_checkpoint(checkpoint)
            target_artifact_id = checkpoint["previous_artifact_id"]

        await self.env_manager.invalidate_caches(deployment["agent_id"])

        result = RollbackResult(
            rollback_id=generate_rollback_id(),
            deployment_id=deployment_id,
            agent_id=deployment["agent_id"],
            rolled_back_from=deployment["artifact_id"],
            rolled_back_to=target_artifact_id or "none",
            rollback_type=RollbackType.TARGETED if target_artifact_id else RollbackType.INSTANT,
            trigger=RollbackTrigger.MANUAL,
            duration_ms=now_ms() - start,
            success=True,
            reason=reason,
        )

        self.observability.emit_event("deployment.rollback", {
            **result.__dict__,
            "authorized_by": authorized_by,
        }, severity="high")

        return result

    def _classify_trigger(self, trigger: RollbackTrigger, evidence: dict) -> str:
        """Classify rollback trigger for error handling (p. 205).

        Returns: 'transient' | 'logic' | 'unrecoverable'
        """
        if trigger == RollbackTrigger.SAFETY_INCIDENT:
            return "unrecoverable"
        if trigger in (RollbackTrigger.CANARY_QUALITY, RollbackTrigger.EVAL_DRIFT):
            return "logic"
        if trigger == RollbackTrigger.ERROR_RATE:
            # Check if errors are network-related (transient) or logic errors
            error_types = evidence.get("error_types", {})
            transient_pct = error_types.get("timeout", 0) + error_types.get("network", 0)
            if transient_pct > 0.7:
                return "transient"
            return "logic"
        if trigger == RollbackTrigger.LATENCY:
            return "transient"  # Latency spikes are often transient
        return "logic"
```

### 6.4 Quality monitoring loop

After every deployment, a background monitoring loop continuously evaluates the deployed artifact against its SMART quality goals (p. 185). This loop is responsible for triggering automatic rollback when post-deployment quality drifts.

```python
async def post_deployment_monitor(
    deployment_id: str,
    artifact: dict,
    rollback_controller: RollbackController,
    eval_framework,
    observability,
    check_interval_minutes: int = 5,
    monitoring_duration_hours: int = 24,
):
    """Continuous quality monitoring after deployment.

    Implements Goal Setting & Monitoring (p. 185):
    - SMART goals defined in artifact['eval_criteria']
    - goals_met() checked at each interval (p. 188)
    - Automatic rollback on sustained degradation (p. 209)
    """
    criteria = artifact["eval_criteria"]
    checks_remaining = (monitoring_duration_hours * 60) // check_interval_minutes
    consecutive_failures = 0
    MAX_CONSECUTIVE_FAILURES = 3  # Rollback after 3 consecutive failures

    for check in range(checks_remaining):
        await wait_minutes(check_interval_minutes)

        # Collect live metrics from production traffic
        metrics = await observability.collect_metrics(
            deployment_id=deployment_id,
            artifact_id=artifact["artifact_id"],
            window_minutes=check_interval_minutes,
        )

        # goals_met() check (p. 188)
        goals_met = True
        violations = []

        if metrics.overall_quality_score < criteria["min_overall_score"]:
            goals_met = False
            violations.append(
                f"Quality {metrics.overall_quality_score:.3f} "
                f"< {criteria['min_overall_score']:.3f}"
            )

        if metrics.error_rate > 0.05:  # 5% error rate threshold
            goals_met = False
            violations.append(f"Error rate {metrics.error_rate:.3f} > 0.05")

        for dim, floor in criteria["dimension_floors"].items():
            actual = metrics.dimension_scores.get(dim, 0.0)
            if actual < floor:
                goals_met = False
                violations.append(f"Dimension '{dim}' {actual:.3f} < {floor:.3f}")

        if goals_met:
            consecutive_failures = 0
        else:
            consecutive_failures += 1
            observability.emit_event("deployment.quality.degraded", {
                "deployment_id": deployment_id,
                "check_number": check,
                "consecutive_failures": consecutive_failures,
                "violations": violations,
            })

        # Trigger rollback after sustained degradation
        if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
            await rollback_controller.auto_rollback(
                deployment_id=deployment_id,
                trigger=RollbackTrigger.EVAL_DRIFT,
                evidence={
                    "consecutive_failures": consecutive_failures,
                    "violations": violations,
                    "last_score": metrics.overall_quality_score,
                    "threshold": criteria["min_overall_score"],
                },
            )
            return  # Monitoring ends after rollback
```

---

## 7. Team Deployment

When agents operate within teams (see Team Orchestrator, subsystem 02), deploying a single agent in isolation can create version incompatibilities. The Team Deployment Coordinator ensures that teams are deployed as a coordinated unit, with all member agents moving to their new artifacts atomically.

### 7.1 Team deployment artifact

```json
{
  "$schema": "https://agentforge.io/schemas/team-deployment/v1.json",
  "team_deployment_id": "tdep_4a8f2c1e",
  "team_id": "team-alpha",
  "team_version": "3.1.0-build.12",
  "created_at": "2026-02-27T15:00:00Z",
  "agent_artifacts": [
    {
      "agent_id": "agt_research_001",
      "artifact_id": "art_7f3a9b2e4c1d",
      "artifact_version": "2.3.1-build.48",
      "role": "researcher"
    },
    {
      "agent_id": "agt_writer_002",
      "artifact_id": "art_8e4b1c3d5f2a",
      "artifact_version": "1.5.0-build.22",
      "role": "writer"
    },
    {
      "agent_id": "agt_reviewer_003",
      "artifact_id": "art_9d5c2e4f6a3b",
      "artifact_version": "1.2.0-build.15",
      "role": "reviewer"
    }
  ],
  "team_topology": {
    "type": "supervisor",
    "supervisor_agent": "agt_research_001",
    "communication_pattern": "sequential_handoff"
  },
  "cross_agent_eval": {
    "evalset_id": "evalset_team_alpha_integration_v2",
    "min_overall_score": 0.85,
    "end_to_end_trajectory_match": "in_order"
  },
  "deployment_strategy": "blue_green",
  "rollback_strategy": "atomic"
}
```

### 7.2 Atomic team deployment

Team deployments follow an atomic commit pattern: either all agents in the team deploy successfully, or none of them do. This prevents partial deployments where some agents are on the new version and others are on the old version.

```
┌───────────────────────────────────────────────────────────────────┐
│                    Team Deployment Flow                           │
│                                                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                │
│  │ Agent A      │  │ Agent B      │  │ Agent C      │  Individual │
│  │ Pipeline     │  │ Pipeline     │  │ Pipeline     │  pipelines  │
│  │ (build,      │  │ (build,      │  │ (build,      │  run in     │
│  │  validate,   │  │  validate,   │  │  validate,   │  parallel   │
│  │  test)       │  │  test)       │  │  test)       │             │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘             │
│         │                 │                  │                    │
│         ▼                 ▼                  ▼                    │
│  ┌─────────────────────────────────────────────────────────┐      │
│  │           Integration Test Gate                          │     │
│  │   Run cross-agent evalset on the entire team             │     │
│  │   All agents must pass individual AND team evals         │     │
│  └────────────────────────┬────────────────────────────────┘      │
│                           │                                       │
│                           ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐      │
│  │           HITL Approval (production only, p. 211)        │     │
│  │   Reviewer sees full team change summary                 │     │
│  └────────────────────────┬────────────────────────────────┘      │
│                           │                                       │
│                           ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐      │
│  │           Atomic Deploy                                  │     │
│  │   All agents switch simultaneously (blue-green)          │     │
│  │   OR canary with team-level traffic split                │     │
│  └────────────────────────┬────────────────────────────────┘      │
│                           │                                       │
│                           ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐      │
│  │           Atomic Rollback (if needed)                    │     │
│  │   All agents revert together -- no partial rollback      │     │
│  └─────────────────────────────────────────────────────────┘      │
└───────────────────────────────────────────────────────────────────┘
```

### 7.3 Team deployment coordinator pseudocode

```python
@dataclass
class TeamDeploymentResult:
    team_deployment_id: str
    team_id: str
    status: str             # "deployed" | "rolled_back" | "failed"
    agent_results: list     # Per-agent pipeline results
    integration_eval: dict  # Cross-agent evaluation results
    duration_ms: int


class TeamDeploymentCoordinator:
    """Coordinates deployment of multiple agents as an atomic unit.

    Ensures that team members are version-compatible and that
    cross-agent integration tests pass before any agent goes live.
    Rollback is all-or-nothing: if one agent fails, all revert.
    """

    def __init__(self, pipeline: AgentDeploymentPipeline, env_manager, eval_framework):
        self.pipeline = pipeline
        self.env_manager = env_manager
        self.eval_framework = eval_framework

    async def deploy_team(
        self,
        team_deployment: dict,
        triggered_by: dict,
    ) -> TeamDeploymentResult:
        """Deploy an entire team as a coordinated unit."""
        start = now_ms()
        team_id = team_deployment["team_id"]
        agent_artifacts = team_deployment["agent_artifacts"]
        target_env = team_deployment.get("target_environment", "production")

        # Phase 1: Run individual pipelines in parallel (up to Test stage)
        individual_results = await asyncio.gather(*[
            self.pipeline.run(
                agent_id=aa["agent_id"],
                target_environment=target_env,
                deployment_strategy="hold",  # Don't deploy individually
                triggered_by=triggered_by,
            )
            for aa in agent_artifacts
        ])

        # Check all individual pipelines passed
        failed_agents = [
            r for r in individual_results if r.status == "failed"
        ]
        if failed_agents:
            return TeamDeploymentResult(
                team_deployment_id=team_deployment["team_deployment_id"],
                team_id=team_id,
                status="failed",
                agent_results=individual_results,
                integration_eval={},
                duration_ms=now_ms() - start,
            )

        # Phase 2: Cross-agent integration test
        integration_result = await self.eval_framework.run_team_evalset(
            evalset_id=team_deployment["cross_agent_eval"]["evalset_id"],
            agent_artifacts=[
                self.env_manager.get_artifact(r.artifact_id)
                for r in individual_results
            ],
            match_type=team_deployment["cross_agent_eval"].get(
                "end_to_end_trajectory_match", "in_order"
            ),
        )

        if integration_result.overall_score < team_deployment["cross_agent_eval"]["min_overall_score"]:
            return TeamDeploymentResult(
                team_deployment_id=team_deployment["team_deployment_id"],
                team_id=team_id,
                status="failed",
                agent_results=individual_results,
                integration_eval=integration_result.__dict__,
                duration_ms=now_ms() - start,
            )

        # Phase 3: Atomic deploy -- all agents switch together
        checkpoint = await self.env_manager.create_team_checkpoint(team_id, target_env)

        try:
            for result in individual_results:
                artifact = await self.env_manager.get_artifact(result.artifact_id)
                await self.env_manager.activate_artifact(artifact, target_env)

            return TeamDeploymentResult(
                team_deployment_id=team_deployment["team_deployment_id"],
                team_id=team_id,
                status="deployed",
                agent_results=individual_results,
                integration_eval=integration_result.__dict__,
                duration_ms=now_ms() - start,
            )

        except Exception:
            # Atomic rollback: restore ALL agents from checkpoint
            await self.env_manager.restore_team_checkpoint(checkpoint)
            return TeamDeploymentResult(
                team_deployment_id=team_deployment["team_deployment_id"],
                team_id=team_id,
                status="rolled_back",
                agent_results=individual_results,
                integration_eval=integration_result.__dict__,
                duration_ms=now_ms() - start,
            )
```

---

## 8. Integration Points

The Agent Deployment Pipeline integrates with four primary subsystems and several secondary ones.

### 8.1 Prompt Registry (Subsystem 07)

| Integration | Direction | Details |
|-------------|-----------|---------|
| Prompt version resolution | Pipeline --> Registry | Assemble stage resolves `system_prompt_ref` to a pinned, immutable version |
| Prompt lint | Pipeline --> Registry | Validate stage runs lint checks on the resolved prompt |
| Promotion coordination | Bidirectional | Prompt lifecycle (draft --> review --> staged --> production) aligns with deployment pipeline stages |
| Rollback notification | Pipeline --> Registry | On rollback, the pipeline notifies the Registry to re-activate the previous prompt version |

The Prompt Registry is the source of truth for prompt content. The deployment pipeline never modifies prompts -- it only reads and pins specific versions into the artifact.

### 8.2 Evaluation Framework (Subsystem 08)

| Integration | Direction | Details |
|-------------|-----------|---------|
| Evalset regression | Pipeline --> Eval | Test stage runs the agent's evalset against the candidate artifact (p. 312) |
| LLM-as-Judge | Pipeline --> Eval | Evaluate stage requests LLM-as-Judge scoring for baseline comparison (p. 305) |
| Trajectory evaluation | Pipeline --> Eval | Test stage validates agent action sequences against expected trajectories (p. 308) |
| Canary metrics | Pipeline --> Eval | Canary evaluator collects quality scores from live traffic via the Eval Framework |
| Team integration eval | Pipeline --> Eval | Team deployment runs cross-agent evalsets |
| A/B experiment | Pipeline <-- Eval | Canary deployments are modeled as A/B experiments with statistical gates (p. 306) |

### 8.3 Guardrail System (Subsystem 04)

| Integration | Direction | Details |
|-------------|-----------|---------|
| Policy resolution | Pipeline --> Guardrails | Assemble stage resolves guardrail policy versions |
| Safety scan | Pipeline --> Guardrails | Validate stage runs safety scan on the full artifact configuration |
| Red-team suite | Pipeline --> Guardrails | Evaluate stage runs the red-team test suite (p. 298) |
| Safety-triggered rollback | Guardrails --> Pipeline | Guardrail System can trigger immediate rollback via the Rollback Controller |
| Agent quarantine | Pipeline --> Guardrails | On safety incidents, the pipeline quarantines the agent through the Guardrail System |

### 8.4 Observability Platform (Subsystem 05)

| Integration | Direction | Details |
|-------------|-----------|---------|
| Pipeline tracing | Pipeline --> Observability | Every pipeline run produces a trace with spans per stage |
| Metric collection | Pipeline <-- Observability | Canary evaluator and quality monitor collect live metrics |
| Event emission | Pipeline --> Observability | All deployment events (start, stage pass/fail, rollback) are emitted |
| Alert routing | Observability --> Pipeline | Observability alerts can trigger automatic rollback via the Rollback Controller |
| Traffic split tracking | Pipeline --> Observability | Canary traffic percentages are recorded for metric segmentation |

### 8.5 Integration diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                Agent Deployment Pipeline (14)                     │
│                                                                   │
│         ┌──────────────────────────────────────┐                 │
│         │        Build Pipeline                  │                 │
│         │  assemble → validate → test → eval →   │                 │
│         │  stage → deploy                        │                 │
│         └───┬──────────┬──────────┬──────────┬──┘                 │
│             │          │          │          │                     │
└─────────────┼──────────┼──────────┼──────────┼────────────────────┘
              │          │          │          │
      ┌───────▼──┐  ┌───▼──────┐  ┌▼────────┐ ┌▼──────────────┐
      │ Prompt   │  │ Eval     │  │Guardrail│ │ Observability │
      │ Registry │  │ Framework│  │ System  │ │ Platform      │
      │ (07)     │  │ (08)     │  │ (04)    │ │ (05)          │
      │          │  │          │  │         │ │               │
      │ -version │  │ -evalset │  │ -policy │ │ -traces       │
      │  resolve │  │  regress │  │  resolve│ │ -metrics      │
      │ -lint    │  │ -LLM     │  │ -safety │ │ -events       │
      │ -rollback│  │  judge   │  │  scan   │ │ -alerts       │
      │  notify  │  │ -traject │  │ -redteam│ │ -traffic      │
      │          │  │ -A/B exp │  │ -quarant│ │  split        │
      └──────────┘  └──────────┘  └─────────┘ └───────────────┘
              │          │          │          │
              └──────────┼──────────┼──────────┘
                         │          │
                  ┌──────▼──────────▼───────────────┐
                  │  Agent Builder (01)               │
                  │  Team Orchestrator (02)            │
                  │  Tool & MCP Manager (03)           │
                  │  Cost & Resource Manager (09)      │
                  └───────────────────────────────────┘
```

---

## 9. API Surface

### 9.1 Pipeline Operations

```
POST   /api/v1/deployments/pipeline/run
       Body: { agent_id, target_environment, strategy, triggered_by }
       → Starts a new pipeline run. Returns PipelineRun with run_id.

GET    /api/v1/deployments/pipeline/runs/{run_id}
       → Returns full pipeline run status with stage verdicts.

GET    /api/v1/deployments/pipeline/runs?agent_id=X&status=Y&limit=N
       → List pipeline runs with filtering.

POST   /api/v1/deployments/pipeline/runs/{run_id}/cancel
       → Cancel a running pipeline (idempotent).

GET    /api/v1/deployments/pipeline/runs/{run_id}/stages/{stage}
       → Detailed stage result with metrics and reasons.
```

### 9.2 Artifact Operations

```
GET    /api/v1/deployments/artifacts/{artifact_id}
       → Returns the full artifact schema.

GET    /api/v1/deployments/artifacts?agent_id=X&environment=Y
       → List artifacts for an agent, optionally filtered by environment.

GET    /api/v1/deployments/artifacts/{artifact_id}/diff/{other_artifact_id}
       → Structured diff between two artifacts (prompt diff, config diff).

POST   /api/v1/deployments/artifacts/build
       Body: { agent_id, overrides }
       → Build an artifact without deploying (dry run for validation).
```

### 9.3 Deployment Operations

```
POST   /api/v1/deployments/deploy
       Body: { artifact_id, target_environment, strategy, canary_config }
       → Deploy a pre-built artifact using the specified strategy.

GET    /api/v1/deployments/{deployment_id}
       → Deployment status, traffic split, canary step, metrics.

GET    /api/v1/deployments/{deployment_id}/canary/status
       → Current canary step, traffic percentage, scores, decision history.

POST   /api/v1/deployments/{deployment_id}/canary/promote
       → Force-promote canary to 100% (requires HITL for production).

POST   /api/v1/deployments/{deployment_id}/canary/rollback
       → Force-rollback canary to 0% and restore previous artifact.

GET    /api/v1/deployments/active?environment=production&agent_id=X
       → Currently active deployments.
```

### 9.4 Rollback Operations

```
POST   /api/v1/deployments/{deployment_id}/rollback
       Body: { target_artifact_id (optional), reason, authorized_by }
       → Manual rollback. Requires HITL authorization for production.

GET    /api/v1/deployments/{deployment_id}/rollback/history
       → History of rollbacks for a deployment.

GET    /api/v1/deployments/rollbacks?agent_id=X&since=ISO8601
       → List all rollbacks across deployments.
```

### 9.5 Environment Operations

```
GET    /api/v1/environments
       → List all environments with their active artifact counts.

GET    /api/v1/environments/{name}/agents
       → List all active agents in an environment with their artifact versions.

POST   /api/v1/environments/{name}/promote
       Body: { artifact_id, promoted_by }
       → Promote an artifact into an environment (applies promotion rules).

GET    /api/v1/environments/{name}/checkpoints
       → List available rollback checkpoints.
```

### 9.6 Team Deployment Operations

```
POST   /api/v1/deployments/teams/deploy
       Body: { team_deployment schema }
       → Deploy a team as an atomic unit.

GET    /api/v1/deployments/teams/{team_deployment_id}
       → Team deployment status with per-agent details.

POST   /api/v1/deployments/teams/{team_deployment_id}/rollback
       Body: { reason, authorized_by }
       → Atomic rollback of all agents in the team.
```

### 9.7 Event Stream

```
WebSocket /api/v1/deployments/events?run_id=X
          → Real-time event stream for a pipeline run.

WebSocket /api/v1/deployments/events?deployment_id=X
          → Real-time events for an active deployment (canary steps, metrics).
```

---

## 10. Failure Modes & Mitigations

| # | Failure Mode | Detection | Impact | Mitigation | Pattern Reference |
|---|-------------|-----------|--------|------------|-------------------|
| 1 | **Dependency unavailable during Assemble** (MCP server down, prompt version archived) | Validate stage dep-check | Pipeline fails before any deployment | Retry with exponential backoff for transient failures; fail-fast for missing versions. Alert on-call if critical dependency. | Exception Handling (p. 205) |
| 2 | **Evalset regression at Test stage** | Test gate score comparison | Pipeline halts; no deployment | Log regression details with per-dimension breakdown. Notify agent owner. Suggest prompt optimization via Agent Builder (01). | Evaluation & Monitoring (p. 312) |
| 3 | **Red-team suite discovers vulnerability** | Evaluate stage red-team check | Pipeline halts; potential security review | Quarantine the artifact. Route to security team for review. Block agent from re-deployment until vulnerability is resolved. | Guardrails/Safety (p. 298) |
| 4 | **HITL approval timeout** | 60-minute timer expires | Pipeline halts; safe default is DENY (p. 214) | Notify approver escalation chain. Auto-deny after timeout. Pipeline can be re-triggered with a new approval request. | HITL (p. 214) |
| 5 | **Canary quality degradation during rollout** | Canary evaluator detects score below rollback threshold | Automatic rollback; no user impact beyond canary slice | Instant rollback of canary traffic. Full incident report with metrics. Root cause analysis via Eval Framework. | Exception Handling (p. 209), Goal Setting (p. 188) |
| 6 | **Post-deployment quality drift** | Quality monitor detects sustained failures | Auto-rollback after N consecutive failures | Rollback to checkpoint. Alert agent owner. Trigger diagnostic eval run to identify drift cause. | Checkpoint & Rollback (p. 290) |
| 7 | **Atomic team deployment partial failure** | One agent's pipeline fails while others succeed | No agents deployed; atomic guarantee maintained | All successful pipelines' artifacts are staged but not activated. Team deployment coordinator reports which agent(s) failed. | Prompt Chaining (p. 5) |
| 8 | **Rollback target artifact corrupted or unavailable** | Checkpoint restore fails integrity check | Cannot rollback; service degradation | Fall back to second-most-recent checkpoint. If no valid checkpoint exists, deactivate agent and escalate to human operator. Maintain at least 3 checkpoint history. | Exception Handling (p. 209) |
| 9 | **Pipeline infrastructure failure** (database down, event bus unavailable) | Health checks and circuit breakers | Pipeline cannot start or complete | Circuit breaker prevents new pipeline runs. Existing deployments continue serving current artifacts (last-known-good). Alert infrastructure team. | Exception Handling (p. 206) |
| 10 | **Traffic split misconfiguration** (canary receiving too much/too little traffic) | Canary evaluator detects sample size anomaly | Under-powered evaluation or over-exposed canary | Canary evaluator's `min_sample_size` check catches under-sampling and enters HOLD state. Over-exposure detected by comparing actual traffic to configured percentage. Auto-correct split. | Resource-Aware Optimization (p. 255) |

---

## 11. Instrumentation

All pipeline and deployment operations are instrumented via the Observability Platform (05). Every operation produces structured telemetry across three dimensions: traces, metrics, and events.

### 11.1 Traces

Every pipeline run produces an OpenTelemetry trace with nested spans per stage:

```
Trace: pipeline-run-{run_id}
│
├── Span: Assemble
│   ├── agent_id: "agt_research_001"
│   ├── components_resolved: 5
│   ├── artifact_hash: "sha256:a4f8..."
│   └── duration_ms: 340
│
├── Span: Validate
│   ├── schema_errors: 0
│   ├── dep_checks: 3 (all passed)
│   ├── lint_issues: 0
│   ├── safety_scan: "passed"
│   └── duration_ms: 1200
│
├── Span: Test
│   ├── evalset_id: "evalset_research_v3"
│   ├── overall_score: 0.91
│   ├── dimension_scores: {accuracy: 0.93, ...}
│   ├── trajectory_passed: true
│   └── duration_ms: 45000
│
├── Span: Evaluate
│   ├── red_team_pass_rate: 0.97
│   ├── baseline_comparison: "+0.03"
│   ├── hitl_approval: "granted"
│   ├── hitl_approver: "user:alice@acme.com"
│   └── duration_ms: 3620000  (includes HITL wait)
│
├── Span: Stage
│   ├── environment: "production"
│   ├── strategy: "canary"
│   ├── checkpoint_created: true
│   └── duration_ms: 800
│
└── Span: Deploy
    ├── strategy: "canary"
    ├── canary_steps: 5
    ├── final_status: "promoted"
    ├── total_canary_duration_ms: 9000000
    └── Span: Canary Step 1
        ├── traffic_pct: 5
        ├── canary_score: 0.90
        ├── baseline_score: 0.89
        ├── decision: "promote"
        └── duration_ms: 1800000
```

### 11.2 Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `pipeline.runs.total` | Counter | `agent_id`, `environment`, `status` | Total pipeline runs |
| `pipeline.stage.duration_ms` | Histogram | `agent_id`, `stage`, `result` | Duration per pipeline stage |
| `pipeline.stage.pass_rate` | Gauge | `stage` | Rolling pass rate per stage |
| `deployment.active` | Gauge | `environment`, `strategy` | Currently active deployments |
| `deployment.canary.traffic_pct` | Gauge | `deployment_id` | Current canary traffic percentage |
| `deployment.canary.score` | Gauge | `deployment_id`, `artifact_id` | Canary quality score |
| `deployment.rollback.total` | Counter | `agent_id`, `trigger`, `type` | Total rollbacks |
| `deployment.rollback.duration_ms` | Histogram | `type` | Time to complete rollback |
| `deployment.quality.score` | Gauge | `agent_id`, `environment` | Post-deployment quality score |
| `deployment.hitl.approval_time_ms` | Histogram | `environment` | Time to HITL approval |
| `deployment.hitl.timeout_rate` | Gauge | `environment` | Rate of HITL approval timeouts |
| `team_deployment.total` | Counter | `team_id`, `status` | Total team deployments |
| `artifact.build.total` | Counter | `agent_id` | Total artifacts built |
| `artifact.size_bytes` | Histogram | `agent_id` | Artifact size distribution |

### 11.3 Events

All events are structured JSON records emitted to the Observability Platform event bus:

| Event | Severity | Payload |
|-------|----------|---------|
| `pipeline.started` | `info` | `run_id`, `agent_id`, `environment`, `triggered_by` |
| `pipeline.stage.passed` | `info` | `run_id`, `stage`, `metrics`, `duration_ms` |
| `pipeline.stage.failed` | `warning` | `run_id`, `stage`, `reasons`, `metrics` |
| `pipeline.completed` | `info` | `run_id`, `status`, `total_duration_ms`, `failed_stage` |
| `deployment.started` | `info` | `deployment_id`, `artifact_id`, `environment`, `strategy` |
| `deployment.canary.step` | `info` | `deployment_id`, `step`, `traffic_pct`, `score`, `decision` |
| `deployment.promoted` | `info` | `deployment_id`, `artifact_id`, `environment` |
| `deployment.rollback` | `critical` | `rollback_id`, `trigger`, `from_artifact`, `to_artifact`, `evidence` |
| `deployment.quality.degraded` | `warning` | `deployment_id`, `violations`, `consecutive_failures` |
| `team_deployment.started` | `info` | `team_deployment_id`, `team_id`, `agent_count` |
| `team_deployment.completed` | `info` | `team_deployment_id`, `status`, `integration_score` |
| `hitl.approval.requested` | `info` | `artifact_id`, `environment`, `requested_by` |
| `hitl.approval.granted` | `info` | `artifact_id`, `approved_by`, `duration_ms` |
| `hitl.approval.denied` | `warning` | `artifact_id`, `denied_by`, `reason` |
| `hitl.approval.timeout` | `warning` | `artifact_id`, `timeout_minutes` |

### 11.4 Dashboards

The deployment pipeline provides two primary dashboards to the Observability Platform:

**Pipeline Health Dashboard**:
- Pipeline success/failure rates by stage (stacked bar chart)
- Average stage duration trends (time series)
- HITL approval latency distribution (histogram)
- Most common failure reasons (top-N table)
- Active pipeline runs (live status board)

**Deployment Health Dashboard**:
- Active deployments by environment and strategy (summary cards)
- Canary progress tracker (step-by-step visualization with scores)
- Rollback frequency and triggers (pie chart by trigger type)
- Post-deployment quality trends (time series per agent)
- Team deployment status board (atomic status per team)

---

*Next: See `00-system-overview.md` for the full subsystem map and `10-review-checklist-assessment.md` for platform-wide review criteria. For details on how evaluation gates work, see `08-evaluation-framework.md`. For guardrail policy definitions used in safety scanning, see `04-guardrail-system.md`. For prompt version resolution, see `07-prompt-registry.md`.*
