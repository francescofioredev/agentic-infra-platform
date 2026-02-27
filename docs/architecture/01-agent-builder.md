# Subsystem 01 — Agent Builder

**Owner**: Platform Architecture Team
**Status**: `Draft`
**Last updated**: 2026-02-27

---

## 1. Overview & Responsibility

The Agent Builder is subsystem #1 of the AgentForge platform. It is the authoritative service for **creating, versioning, optimizing, and managing the lifecycle of agent definitions**. Every agent that exists within AgentForge begins its life inside the Agent Builder.

**Core responsibilities**:

1. **Agent Creation** -- Accept agent definitions (system prompt, capabilities, schemas, tool assignments) and persist them as immutable, versioned records.
2. **Prompt Versioning** -- Maintain a full version history for every system prompt, including structured diffs, authorship, and promotion metadata.
3. **AI-Driven Prompt Optimization** -- Automatically improve agent prompts using a Reflection-pattern generator-critic loop (p. 61-68) combined with evolutionary search (AlphaEvolve pattern, p. 172).
4. **Agent Lifecycle Management** -- Govern the progression of agent versions through a strict state machine: `draft` -> `review` -> `staged` -> `production`, with HITL approval gates (p. 211).

**What the Agent Builder is NOT responsible for**:

- Runtime execution of agents (that is the Team Orchestrator, subsystem #2).
- Tool registration and assignment (that is the Tool & MCP Manager, subsystem #3).
- Guardrail policy definition (that is the Guardrail System, subsystem #4).
- Evaluation infrastructure (that is the Evaluation Framework, subsystem #8).

The Agent Builder depends on the Evaluation Framework for running evalsets and on the Observability Platform for logging all mutations.

---

## 2. Agent Definition Schema

Every agent is represented as an **AgentDefinition** record. This is the canonical data structure that travels across the platform.

```json
{
  "agent_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "ResearchAgent",
  "description": "Performs web research and produces cited summaries.",
  "version": "3.1.0",
  "lifecycle_state": "production",

  "system_prompt": {
    "prompt_id": "prompt-9f8e7d6c-5b4a-3210-fedc-ba0987654321",
    "version": 14,
    "content": "You are a research agent specialized in...",
    "content_hash": "sha256:a3f2b1c0...",
    "author": "optimizer:reflection-loop-v2",
    "created_at": "2026-02-25T14:30:00Z"
  },

  "capabilities": ["web_search", "summarization", "citation_extraction"],

  "input_schema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "minLength": 1, "maxLength": 2000 },
      "max_sources": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 }
    },
    "required": ["query"]
  },

  "output_schema": {
    "type": "object",
    "properties": {
      "summary": { "type": "string" },
      "sources": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "url": { "type": "string", "format": "uri" },
            "title": { "type": "string" },
            "relevance_score": { "type": "number", "minimum": 0, "maximum": 1 }
          }
        }
      },
      "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
    },
    "required": ["summary", "sources"]
  },

  "tools": [
    "mcp://search-server/web_search",
    "mcp://search-server/scholar_search"
  ],

  "guardrail_policies": ["no-pii-output", "citation-required", "max-tokens-4096"],

  "model_config": {
    "model_tier": "auto",
    "fallback_tier": "pro",
    "max_tokens": 4096,
    "temperature": 0.3
  },

  "operational_limits": {
    "max_iterations": 10,
    "timeout_seconds": 120,
    "token_budget": 50000
  },

  "metadata": {
    "team_id": "team-alpha",
    "created_by": "user:jane.doe@company.com",
    "tags": ["research", "summarization"],
    "optimization_history": [
      {
        "cycle_id": "opt-001",
        "previous_version": 13,
        "quality_delta": "+0.08",
        "method": "reflection-loop"
      }
    ]
  }
}
```

### 2.1 Schema Design Decisions

| Field | Rationale |
|-------|-----------|
| `system_prompt.content_hash` | Deduplication and tamper detection. Every prompt version has a SHA-256 hash of its content. |
| `system_prompt.author` | Tracks whether a human or an optimizer wrote this version. Critical for audit trails. |
| `input_schema` / `output_schema` | Explicit contracts between agents (p. 126). Validated at agent boundaries. |
| `model_config.model_tier: "auto"` | Enables Resource-Aware Optimization (p. 258): the platform routes to the cheapest model that meets quality requirements. |
| `operational_limits` | Hard bounds that prevent runaway agents. `max_iterations` implements the iteration limit from Reflection pattern (p. 67). |
| `lifecycle_state` | Current position in the state machine. Only `production` agents serve live traffic. |

### 2.2 Storage Layout (Memory Management, p. 151)

Agent definitions use the state prefix system defined in the Memory Management pattern:

| Prefix | Data | Storage | TTL |
|--------|------|---------|-----|
| `app:agents:{agent_id}` | Agent definition (latest production version) | PostgreSQL | Indefinite |
| `app:prompts:{prompt_id}:v{N}` | Immutable prompt version record | Git-backed PostgreSQL | Indefinite |
| `app:prompts:{prompt_id}:diffs` | Diff chain between consecutive versions | Git-backed PostgreSQL | Indefinite |
| `temp:optimization:{cycle_id}` | In-progress optimization state (candidate prompts, scores) | Redis | 24 hours |
| `user:{user_id}:agent_drafts` | User's in-progress agent drafts | Redis | 7 days |
| `app:agents:{agent_id}:evalset` | Agent-specific evaluation test cases | PostgreSQL | Indefinite |

---

## 3. Prompt Versioning System

### 3.1 Versioning Model

Every system prompt is an **append-only sequence of immutable versions**. Prompts are never mutated in place; every change produces a new version. This design mirrors a git commit history and provides complete auditability.

```
prompt-9f8e7d6c
  ├── v1  (draft)      author: user:jane.doe     2026-01-10
  ├── v2  (production)  author: user:jane.doe     2026-01-12
  ├── v3  (production)  author: user:jane.doe     2026-01-20
  ├── v4  (production)  author: optimizer:refl-v2  2026-02-01
  ├── v5  (production)  author: optimizer:refl-v2  2026-02-15
  └── v6  (staged)      author: optimizer:evo-v1   2026-02-25  <-- current head
```

### 3.2 Version Record Structure

```json
{
  "prompt_id": "prompt-9f8e7d6c-5b4a-3210-fedc-ba0987654321",
  "version": 6,
  "parent_version": 5,
  "content": "You are a research agent specialized in...",
  "content_hash": "sha256:b4c3d2e1...",
  "author": "optimizer:evo-v1",
  "author_type": "ai",
  "method": "evolutionary_search",
  "lifecycle_state": "staged",
  "created_at": "2026-02-25T14:30:00Z",
  "promotion_history": [],
  "eval_results": {
    "evalset_version": "evalset-research-v3",
    "scores": {
      "task_accuracy": 0.91,
      "clarity": 0.88,
      "safety_compliance": 1.0,
      "token_efficiency": 0.85,
      "overall": 0.91
    },
    "regression_tests_passed": true,
    "baseline_comparison": "+0.04 vs v5"
  },
  "diff_from_parent": {
    "type": "unified_diff",
    "hunks": [
      {
        "old_start": 3,
        "old_count": 2,
        "new_start": 3,
        "new_count": 4,
        "content": "@@ -3,2 +3,4 @@\n-When summarizing, include at least 3 sources.\n+When summarizing, include at least 5 sources with relevance scores.\n+Prioritize peer-reviewed sources over blog posts.\n+Always include publication dates in citations."
      }
    ],
    "stats": { "additions": 3, "deletions": 1, "changed_lines": 4 }
  }
}
```

### 3.3 Diff Computation

Diffs are computed at write time when a new version is created and stored alongside the version record. This enables efficient diff retrieval without recomputation.

```python
import difflib
import hashlib
from dataclasses import dataclass


@dataclass
class PromptDiff:
    hunks: list[dict]
    additions: int
    deletions: int


def compute_prompt_diff(old_content: str, new_content: str) -> PromptDiff:
    """Compute a structured diff between two prompt versions.

    Uses unified diff format, splitting on newlines for line-level
    granularity. Returns a serializable PromptDiff with hunk details
    and summary statistics.
    """
    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)

    differ = difflib.unified_diff(old_lines, new_lines, lineterm="")
    hunks = []
    additions = 0
    deletions = 0

    current_hunk = None
    for line in differ:
        if line.startswith("@@"):
            if current_hunk:
                hunks.append(current_hunk)
            current_hunk = {"header": line, "lines": []}
        elif current_hunk is not None:
            current_hunk["lines"].append(line)
            if line.startswith("+") and not line.startswith("+++"):
                additions += 1
            elif line.startswith("-") and not line.startswith("---"):
                deletions += 1

    if current_hunk:
        hunks.append(current_hunk)

    return PromptDiff(hunks=hunks, additions=additions, deletions=deletions)


def content_hash(content: str) -> str:
    """SHA-256 hash of prompt content for deduplication and integrity."""
    return f"sha256:{hashlib.sha256(content.encode('utf-8')).hexdigest()}"
```

### 3.4 Version Retrieval API

The versioning system supports the following access patterns, all critical for the optimization loop and the lifecycle state machine:

| Operation | Description |
|-----------|-------------|
| `get_version(prompt_id, version)` | Retrieve a specific version by number. |
| `get_latest(prompt_id, state=None)` | Retrieve the latest version, optionally filtered by lifecycle state. |
| `get_diff(prompt_id, from_version, to_version)` | Compute or retrieve the diff between any two versions. |
| `list_versions(prompt_id, limit, offset)` | Paginated version history. |
| `get_lineage(prompt_id, version)` | Full ancestry chain back to v1 (for optimization provenance). |
| `rollback(prompt_id, target_version)` | Create a new version whose content matches `target_version` (no destructive rewrite). |

---

## 4. AI-Driven Prompt Optimization

This section defines the two optimization strategies used by the Agent Builder: the **Reflection Loop** (short-term, targeted improvement) and **Evolutionary Search** (long-term, exploratory improvement). Both strategies operate on prompts that are already in `production` state, producing new `draft` versions as candidates.

### 4.1 Reflection Loop (p. 61-68)

The Reflection pattern implements a generator-critic loop where a Generator LLM proposes prompt improvements and a separate Critic LLM evaluates them against an explicit rubric.

**Key design constraints from the pattern**:
- The critic MUST be a separate prompt, not the same prompt that generated the output (p. 68).
- The critic MUST evaluate against explicit, measurable criteria -- not vague "is this good?" (p. 65).
- The loop MUST have a hard iteration limit to prevent runaway optimization (p. 67).
- Use a cheap model for generation and an expensive model for quality evaluation (Resource-Aware Optimization, p. 258).

#### 4.1.1 Architecture

```
                    ┌──────────────────────────────┐
                    │   Optimization Trigger       │
                    │ (eval score below threshold  │
                    │  OR scheduled optimization)  │
                    └──────────────┬───────────────┘
                                   │
                                   v
                    ┌──────────────────────────────┐
                    │   Load Current Production    │
                    │   Prompt + Eval Results +    │
                    │   Failure Cases              │
                    └──────────────┬───────────────┘
                                   │
                     ┌─────────────v──────────────┐
                     │                            │
              ┌──────┴───────┐             ┌──────┴───────┐
              │  Generator   │             │   Critic     │
              │  (cheap LLM) │             │ (strong LLM) │
              │              │◄────────────│              │
              │  Proposes    │  feedback   │  Evaluates   │
              │  improved    │             │  against     │
              │  prompt      ├────────────►│  rubric      │
              │              │  candidate  │              │
              └──────┬───────┘             └───────┬──────┘
                     │                             │
                     │     Loop max N iterations   │
                     │     (p. 67)                 │
                     └─────────────┬───────────────┘
                                   │
                                   v
                    ┌──────────────────────────────┐
                    │   Best Candidate Prompt      │
                    │   Saved as new Draft version │
                    └──────────────┬───────────────┘
                                   │
                                   v
                    ┌──────────────────────────────┐
                    │   Run Full Evalset           │
                    │   (Evaluation Framework)     │
                    └──────────────┬───────────────┘
                                   │
                               Pass? ──── No ──► Discard candidate
                                   │
                                  Yes
                                   │
                                   v
                    ┌──────────────────────────────┐
                    │   Promote to Review state    │
                    │   (HITL gate, p. 211)        │
                    └──────────────────────────────┘
```

#### 4.1.2 Critic Rubric (Evaluation & Monitoring, p. 306)

The critic evaluates every candidate prompt against a five-dimension rubric. Each dimension is scored on a 1-5 scale with explicit anchors. This rubric aligns with the LLM-as-Judge rubric defined in Evaluation & Monitoring (p. 306).

| Dimension | Weight | 1 (Failing) | 3 (Acceptable) | 5 (Excellent) |
|-----------|--------|-------------|-----------------|---------------|
| **Task Accuracy** | 0.35 | Prompt causes agent to misinterpret task goals; failures on >30% of evalset. | Agent completes most tasks correctly; <10% evalset failures. | Agent handles all evalset cases including edge cases; zero regressions. |
| **Clarity & Specificity** | 0.20 | Prompt is ambiguous; multiple valid but conflicting interpretations exist. | Prompt is clear for common cases; some edge cases undefined. | Every instruction is unambiguous; behavior is fully specified for all cases. |
| **Safety Compliance** | 0.20 | Prompt allows or encourages unsafe behaviors; PII leakage possible. | Prompt includes safety constraints but they are incomplete. | All safety constraints are explicit, tested, and robust against adversarial inputs. |
| **Token Efficiency** | 0.10 | Prompt is bloated with redundant instructions; >2x necessary tokens. | Prompt is reasonably concise; minor redundancies. | Every token contributes; prompt is minimal without sacrificing clarity. |
| **Robustness** | 0.15 | Agent fails on unexpected inputs; no graceful degradation. | Agent handles most input variations; some failure modes exist. | Agent gracefully handles all input variations, adversarial inputs, and edge cases. |

**Minimum threshold for promotion**: weighted score >= 3.5 AND no single dimension below 2.0.

#### 4.1.3 Pseudocode: Reflection Loop

```python
from dataclasses import dataclass
from enum import Enum


class ModelTier(Enum):
    CHEAP = "haiku"       # Fast/cheap: variant generation (p. 258)
    STRONG = "opus"       # Strong/expensive: quality evaluation (p. 258)


@dataclass
class CriticScore:
    task_accuracy: float       # 1-5
    clarity: float             # 1-5
    safety_compliance: float   # 1-5
    token_efficiency: float    # 1-5
    robustness: float          # 1-5
    feedback: str              # Structured textual feedback
    weighted_total: float      # Weighted composite score

    WEIGHTS = {
        "task_accuracy": 0.35,
        "clarity": 0.20,
        "safety_compliance": 0.20,
        "token_efficiency": 0.10,
        "robustness": 0.15,
    }

    def compute_weighted_total(self) -> float:
        total = 0.0
        for dim, weight in self.WEIGHTS.items():
            total += getattr(self, dim) * weight
        self.weighted_total = round(total, 3)
        return self.weighted_total

    def passes_threshold(self, minimum: float = 3.5, floor: float = 2.0) -> bool:
        """Check if score meets promotion thresholds."""
        if self.weighted_total < minimum:
            return False
        for dim in self.WEIGHTS:
            if getattr(self, dim) < floor:
                return False
        return True


@dataclass
class OptimizationResult:
    cycle_id: str
    original_prompt_version: int
    best_candidate: str | None
    best_score: CriticScore | None
    iterations_used: int
    improvement_delta: float
    promoted: bool


async def run_reflection_loop(
    agent_id: str,
    prompt_id: str,
    current_version: int,
    evalset_id: str,
    max_iterations: int = 3,        # Hard limit per p. 67
    min_improvement: float = 0.02,   # Minimum score delta to accept
) -> OptimizationResult:
    """Run a Reflection-pattern optimization loop on an agent's prompt.

    Implements the Generator-Critic loop (p. 61-68):
    - Generator (cheap model, p. 258) proposes improved prompts.
    - Critic (strong model, p. 258) evaluates against rubric (p. 306).
    - Loop terminates at max_iterations or when improvement plateaus.
    - Critic is a SEPARATE prompt from generator (p. 68).
    """
    cycle_id = generate_cycle_id()
    current_prompt = await prompt_registry.get_version(prompt_id, current_version)
    baseline_score = await evaluate_prompt_on_evalset(current_prompt.content, evalset_id)

    # Load failure cases from production to guide the generator
    failure_cases = await eval_framework.get_failure_cases(
        agent_id=agent_id,
        limit=20,
        sort_by="severity_desc",
    )

    best_candidate = None
    best_score = baseline_score
    iteration = 0

    for iteration in range(1, max_iterations + 1):
        logger.info(
            "reflection_loop.iteration",
            cycle_id=cycle_id,
            iteration=iteration,
            current_best_score=best_score.weighted_total,
        )

        # --- GENERATOR PHASE (cheap model, p. 258) ---
        candidate_prompt = await llm_call(
            model=ModelTier.CHEAP,
            system_prompt=GENERATOR_SYSTEM_PROMPT,
            user_prompt=format_generator_input(
                current_prompt=best_candidate or current_prompt.content,
                failure_cases=failure_cases,
                previous_feedback=best_score.feedback if iteration > 1 else None,
                rubric=CRITIC_RUBRIC_DESCRIPTION,
            ),
        )

        # --- CRITIC PHASE (strong model, p. 258; separate prompt, p. 68) ---
        critic_result = await llm_call(
            model=ModelTier.STRONG,
            system_prompt=CRITIC_SYSTEM_PROMPT,   # Separate from generator (p. 68)
            user_prompt=format_critic_input(
                candidate_prompt=candidate_prompt,
                evalset_id=evalset_id,
                rubric=CRITIC_RUBRIC_DESCRIPTION,  # Explicit measurable criteria (p. 65)
            ),
        )

        score = parse_critic_score(critic_result)
        score.compute_weighted_total()

        # --- IMPROVEMENT CHECK ---
        delta = score.weighted_total - best_score.weighted_total

        if delta >= min_improvement:
            best_candidate = candidate_prompt
            best_score = score
            logger.info(
                "reflection_loop.improvement",
                cycle_id=cycle_id,
                iteration=iteration,
                delta=delta,
                new_score=score.weighted_total,
            )
        else:
            logger.info(
                "reflection_loop.plateau",
                cycle_id=cycle_id,
                iteration=iteration,
                delta=delta,
            )
            # Early termination: no meaningful improvement
            break

    # --- POST-LOOP: Full evalset validation ---
    improvement_delta = best_score.weighted_total - baseline_score.weighted_total

    if best_candidate and improvement_delta >= min_improvement:
        # Run full evalset regression test (p. 312) before saving
        regression_result = await eval_framework.run_evalset(
            prompt_content=best_candidate,
            evalset_id=evalset_id,
        )

        if regression_result.all_passed:
            new_version = await prompt_registry.create_version(
                prompt_id=prompt_id,
                content=best_candidate,
                author=f"optimizer:reflection-loop-v2",
                method="reflection_loop",
                parent_version=current_version,
                eval_results=best_score,
                lifecycle_state="draft",
            )

            return OptimizationResult(
                cycle_id=cycle_id,
                original_prompt_version=current_version,
                best_candidate=best_candidate,
                best_score=best_score,
                iterations_used=iteration,
                improvement_delta=improvement_delta,
                promoted=True,
            )

    # No improvement found or regression detected
    return OptimizationResult(
        cycle_id=cycle_id,
        original_prompt_version=current_version,
        best_candidate=None,
        best_score=best_score,
        iterations_used=iteration,
        improvement_delta=improvement_delta,
        promoted=False,
    )
```

#### 4.1.4 Generator and Critic Prompts

The generator and critic are **separate prompts** (p. 68), each with a clearly defined role. The critic uses **adversarial framing** to prevent sycophantic evaluation.

```python
GENERATOR_SYSTEM_PROMPT = """You are a prompt engineering specialist. Your task is to
improve an agent's system prompt based on evaluation feedback and failure cases.

Rules:
1. Preserve the core task definition -- do not change WHAT the agent does.
2. Improve HOW the agent executes: clarity, specificity, edge case handling.
3. Address every failure case provided -- each one represents a real production failure.
4. Keep the prompt concise. Remove redundant instructions.
5. Maintain all safety constraints from the original prompt.
6. Output ONLY the improved system prompt, nothing else.
"""

CRITIC_SYSTEM_PROMPT = """You are a rigorous prompt quality evaluator. Your job is to find
weaknesses in agent system prompts. You are adversarial by design -- assume the prompt
will face hostile inputs, ambiguous requests, and edge cases in production.

Evaluate the candidate prompt against these EXACT dimensions (score each 1-5):

1. TASK ACCURACY (weight 0.35): Will this prompt cause the agent to complete its
   designated task correctly across a diverse set of inputs?
2. CLARITY & SPECIFICITY (weight 0.20): Is every instruction unambiguous? Could a
   different LLM interpret any instruction differently?
3. SAFETY COMPLIANCE (weight 0.20): Are safety constraints explicit and robust?
   Could an adversarial input bypass them?
4. TOKEN EFFICIENCY (weight 0.10): Is the prompt concise without sacrificing clarity?
5. ROBUSTNESS (weight 0.15): Does the prompt handle unexpected inputs, malformed data,
   and adversarial attacks gracefully?

Output format (JSON):
{
  "task_accuracy": <1-5>,
  "clarity": <1-5>,
  "safety_compliance": <1-5>,
  "token_efficiency": <1-5>,
  "robustness": <1-5>,
  "feedback": "<specific, actionable feedback for the generator to improve the prompt>"
}

Be harsh. A score of 5 should be rare. Always provide concrete examples of weaknesses.
"""
```

### 4.2 Evolutionary Search (Learning & Adaptation, p. 163-172)

For longer-term, exploratory optimization, the Agent Builder implements an **Evolutionary Prompt Search** inspired by the AlphaEvolve pattern (p. 172). Where the Reflection Loop makes targeted, incremental improvements, the Evolutionary Search explores a broader space of prompt structures.

#### 4.2.1 Algorithm

```
Generation 0:  [current_prod_prompt] + [N-1 random mutations]
                         │
                         v
               ┌─────────────────────┐
               │  Evaluate all       │
               │  candidates on      │  LLM-as-Judge (strong model)
               │  evalset (p. 312)   │  + automated metric scoring
               └────────┬────────────┘
                         │
                         v
               ┌─────────────────────┐
               │  Select top-K       │
               │  by fitness score   │  Tournament selection
               └────────┬────────────┘
                         │
                         v
               ┌─────────────────────┐
               │  Generate next      │
               │  generation via:    │  Crossover: merge best parts of 2 parents
               │  - Crossover        │  Mutation: targeted changes via LLM
               │  - Mutation         │  Elitism: carry best unchanged
               │  - Elitism          │
               └────────┬────────────┘
                         │
                    Repeat for G generations
                    (configurable, typically 3-5)
                         │
                         v
               ┌─────────────────────┐
               │  Best prompt from   │
               │  final generation   │  Must beat current production by
               │                     │  min_improvement threshold
               └─────────────────────┘
```

#### 4.2.2 Pseudocode: Evolutionary Search

```python
import random
from dataclasses import dataclass


@dataclass
class PromptCandidate:
    content: str
    score: CriticScore | None
    lineage: list[str]  # Track parent candidate IDs for provenance


@dataclass
class EvolutionConfig:
    population_size: int = 8
    generations: int = 4
    top_k: int = 3                    # Parents selected per generation
    mutation_rate: float = 0.7        # Probability of mutation vs. crossover
    elitism_count: int = 1            # Best N carried unchanged
    min_improvement: float = 0.03     # Minimum delta vs. production baseline


async def run_evolutionary_search(
    agent_id: str,
    prompt_id: str,
    current_version: int,
    evalset_id: str,
    config: EvolutionConfig = EvolutionConfig(),
) -> OptimizationResult:
    """Run evolutionary prompt search (AlphaEvolve pattern, p. 172).

    Uses RLVR-style verifiable rewards (p. 168): the evalset provides
    deterministic, reproducible scoring for each candidate. This is the
    'verifiable reward' signal that drives selection.

    Resource-Aware: candidate generation uses cheap model; evaluation
    uses strong model (p. 258).
    """
    cycle_id = generate_cycle_id()
    current_prompt = await prompt_registry.get_version(prompt_id, current_version)
    baseline_score = await evaluate_prompt_on_evalset(current_prompt.content, evalset_id)

    # --- GENERATION 0: Seed population ---
    population: list[PromptCandidate] = [
        PromptCandidate(
            content=current_prompt.content,
            score=baseline_score,
            lineage=["seed:production"],
        )
    ]

    # Generate initial mutants using cheap model (p. 258)
    for i in range(config.population_size - 1):
        mutant = await generate_mutation(
            parent=current_prompt.content,
            mutation_instruction=f"Variant {i+1}: explore a different structural approach.",
            model=ModelTier.CHEAP,
        )
        population.append(PromptCandidate(
            content=mutant,
            score=None,
            lineage=[f"seed:mutation-{i}"],
        ))

    # --- EVOLUTION LOOP ---
    for generation in range(config.generations):
        # Evaluate all unscored candidates (strong model, p. 258)
        for candidate in population:
            if candidate.score is None:
                candidate.score = await evaluate_prompt_on_evalset(
                    candidate.content, evalset_id
                )
                candidate.score.compute_weighted_total()

        # Sort by fitness (RLVR: verifiable reward from evalset, p. 168)
        population.sort(key=lambda c: c.score.weighted_total, reverse=True)

        logger.info(
            "evolutionary_search.generation",
            cycle_id=cycle_id,
            generation=generation,
            best_score=population[0].score.weighted_total,
            worst_score=population[-1].score.weighted_total,
        )

        if generation == config.generations - 1:
            break  # Final generation -- skip reproduction

        # --- SELECTION: top-K parents ---
        parents = population[:config.top_k]

        # --- REPRODUCTION ---
        next_generation: list[PromptCandidate] = []

        # Elitism: carry best unchanged
        for i in range(config.elitism_count):
            next_generation.append(parents[i])

        # Fill rest of population
        while len(next_generation) < config.population_size:
            if random.random() < config.mutation_rate:
                # MUTATION: LLM-guided targeted change
                parent = random.choice(parents)
                child_content = await generate_mutation(
                    parent=parent.content,
                    mutation_instruction="Improve the weakest dimension based on feedback.",
                    feedback=parent.score.feedback,
                    model=ModelTier.CHEAP,
                )
                next_generation.append(PromptCandidate(
                    content=child_content,
                    score=None,
                    lineage=parent.lineage + [f"mutation:gen{generation}"],
                ))
            else:
                # CROSSOVER: merge strengths of two parents
                parent_a, parent_b = random.sample(parents, 2)
                child_content = await generate_crossover(
                    parent_a=parent_a.content,
                    parent_b=parent_b.content,
                    model=ModelTier.CHEAP,
                )
                next_generation.append(PromptCandidate(
                    content=child_content,
                    score=None,
                    lineage=parent_a.lineage + parent_b.lineage + [f"crossover:gen{generation}"],
                ))

        population = next_generation

    # --- FINAL EVALUATION ---
    best = population[0]
    improvement_delta = best.score.weighted_total - baseline_score.weighted_total

    if improvement_delta >= config.min_improvement:
        regression_result = await eval_framework.run_evalset(
            prompt_content=best.content,
            evalset_id=evalset_id,
        )

        if regression_result.all_passed:
            await prompt_registry.create_version(
                prompt_id=prompt_id,
                content=best.content,
                author="optimizer:evolutionary-search-v1",
                method="evolutionary_search",
                parent_version=current_version,
                eval_results=best.score,
                lifecycle_state="draft",
            )

            return OptimizationResult(
                cycle_id=cycle_id,
                original_prompt_version=current_version,
                best_candidate=best.content,
                best_score=best.score,
                iterations_used=config.generations,
                improvement_delta=improvement_delta,
                promoted=True,
            )

    return OptimizationResult(
        cycle_id=cycle_id,
        original_prompt_version=current_version,
        best_candidate=None,
        best_score=best.score,
        iterations_used=config.generations,
        improvement_delta=improvement_delta,
        promoted=False,
    )
```

### 4.3 Prompt Creation Pipeline (Prompt Chaining, p. 1-7)

When a user creates a brand new agent (not optimizing an existing one), the Agent Builder uses a **deterministic sequential pipeline** (Prompt Chaining pattern, p. 1-7) to produce a high-quality initial system prompt.

```
Step 1              Step 2              Step 3              Step 4
┌──────────┐        ┌──────────┐        ┌──────────┐        ┌──────────┐
│ Extract  │──gate─>│ Generate │──gate─>│ Safety   │──gate─>│ Eval &   │
│ Intent & │        │ Draft    │        │ Review   │        │ Baseline │
│ Schema   │        │ Prompt   │        │ Pass     │        │ Score    │
└──────────┘        └──────────┘        └──────────┘        └──────────┘
                                                              │
                                                              v
                                                        Save as Draft v1
```

Each step is a separate LLM call with a validation gate between steps (p. 3). If any gate fails, the pipeline halts and returns an error to the user.

```python
async def create_agent_pipeline(
    name: str,
    description: str,
    capabilities: list[str],
    example_inputs: list[str],
    example_outputs: list[str],
) -> AgentDefinition:
    """Prompt Chaining pipeline for new agent creation (p. 1-7).

    Each step feeds its output as input to the next step.
    Gate checks between steps validate intermediate results
    before proceeding (p. 3).
    """

    # STEP 1: Extract structured intent from user description
    intent = await llm_call(
        model=ModelTier.STRONG,
        system_prompt=INTENT_EXTRACTION_PROMPT,
        user_prompt=f"Name: {name}\nDescription: {description}\n"
                    f"Capabilities: {capabilities}\n"
                    f"Examples: {example_inputs} -> {example_outputs}",
    )
    intent_parsed = parse_and_validate(intent, IntentSchema)  # Gate 1

    # STEP 2: Generate draft system prompt from structured intent
    draft_prompt = await llm_call(
        model=ModelTier.STRONG,
        system_prompt=PROMPT_GENERATION_PROMPT,
        user_prompt=json.dumps(intent_parsed),
    )
    validate_prompt_structure(draft_prompt)  # Gate 2

    # STEP 3: Safety review of the generated prompt
    safety_result = await llm_call(
        model=ModelTier.STRONG,
        system_prompt=SAFETY_REVIEW_PROMPT,
        user_prompt=draft_prompt,
    )
    safety_parsed = parse_and_validate(safety_result, SafetyReviewSchema)
    if not safety_parsed["approved"]:  # Gate 3
        raise SafetyReviewFailure(
            issues=safety_parsed["issues"],
            prompt=draft_prompt,
        )

    # STEP 4: Run baseline evaluation
    baseline_score = await evaluate_prompt_on_evalset(
        prompt_content=draft_prompt,
        evalset_id=generate_bootstrap_evalset(example_inputs, example_outputs),
    )

    # Persist as draft v1
    agent = await create_agent_definition(
        name=name,
        description=description,
        system_prompt=draft_prompt,
        capabilities=capabilities,
        baseline_score=baseline_score,
        lifecycle_state="draft",
    )

    return agent
```

---

## 5. Agent Lifecycle State Machine

### 5.1 State Diagram

```
                            ┌──────────────────────────────────────────────┐
                            │                                              │
                            │  ┌─────────────────────────────────────┐     │
                            │  │         OPTIMIZATION LOOP           │     │
                            │  │  (Reflection p. 61 / Evo p. 172)   │     │
                            │  └──────────────┬──────────────────────┘     │
                            │                 │ generates new candidate    │
                            v                 │                            │
                     ┌──────────┐             │                            │
       User creates  │          │◄────────────┘                            │
       ───────────►  │  DRAFT   │                                          │
                     │          │──── User deletes ────► [ARCHIVED]        │
                     └────┬─────┘                                          │
                          │                                                │
                          │ submit_for_review()                            │
                          │ Pre-condition: passes basic validation         │
                          v                                                │
                     ┌──────────┐                                          │
                     │          │                                          │
                     │  REVIEW  │──── Reviewer rejects ──► [DRAFT]        │
                     │  (HITL)  │     with feedback                       │
                     │          │                                          │
                     └────┬─────┘                                          │
                          │                                                │
                          │ approve() -- requires human approval (p. 211)  │
                          │ Pre-condition: authorized reviewer             │
                          v                                                │
                     ┌──────────┐                                          │
                     │          │                                          │
                     │  STAGED  │──── Evalset fails ──────► [DRAFT]       │
                     │  (Eval)  │     regression detected                 │
                     │          │                                          │
                     └────┬─────┘                                          │
                          │                                                │
                          │ promote() -- requires eval pass + HITL (p.211)│
                          │ Pre-condition: evalset pass, no regressions    │
                          v                                                │
                     ┌──────────┐                                          │
                     │          │                                          │
                     │PRODUCTION│──── Score degrades below threshold ──────┘
                     │          │     triggers optimization loop
                     │          │
                     │          │──── Emergency rollback ──► [Previous PRODUCTION]
                     └──────────┘
```

### 5.2 State Transition Rules

| Transition | From | To | Pre-conditions | HITL Required | Automated |
|-----------|------|-----|----------------|---------------|-----------|
| `create` | -- | `draft` | Valid agent definition schema | No | Yes |
| `submit_for_review` | `draft` | `review` | Passes schema validation; prompt non-empty; diff computed | No | Yes |
| `approve` | `review` | `staged` | Human reviewer explicitly approves (p. 211) | **Yes** | No |
| `reject` | `review` | `draft` | Reviewer provides rejection reason | **Yes** | No |
| `promote` | `staged` | `production` | All evalset tests pass (p. 312); no regressions vs. current production; HITL confirmation | **Yes** | No |
| `eval_fail` | `staged` | `draft` | Evalset regression detected | No | Yes |
| `rollback` | `production` | `production` (previous version) | Emergency trigger; creates audit record | **Yes** | No |
| `archive` | `draft` | `archived` | User or system initiates deletion | No | Yes |
| `optimize` | `production` | triggers `draft` | Quality score below threshold for >24h | No | Yes (trigger), then enters HITL flow |

### 5.3 HITL Gate Implementation (p. 207-215)

The Agent Builder enforces two mandatory HITL gates:

1. **Review Approval Gate** (`review` -> `staged`): A human reviewer must explicitly approve the prompt changes. This gate exists because deploying a modified system prompt is an **irreversible action** that changes agent behavior in production (p. 211).

2. **Production Promotion Gate** (`staged` -> `production`): After evalset validation passes, a human must confirm promotion. This is the final safety check.

**Escalation triggers** (p. 211) that force HITL even for auto-optimization:

- Any prompt change that modifies safety-related instructions.
- Any prompt change where the diff exceeds 30% of the original content.
- Any prompt authored by an AI optimizer (author_type = "ai").
- Any prompt for an agent that handles PII or financial data.

```python
from enum import Enum


class EscalationReason(Enum):
    SAFETY_INSTRUCTIONS_MODIFIED = "safety_instructions_modified"
    LARGE_DIFF = "diff_exceeds_30_percent"
    AI_AUTHORED = "ai_authored_prompt"
    SENSITIVE_DATA_AGENT = "handles_pii_or_financial"
    MANUAL_ESCALATION = "manual_escalation"


async def submit_for_review(
    agent_id: str,
    prompt_id: str,
    version: int,
) -> ReviewRequest:
    """Transition a draft prompt to review state.

    Determines escalation level based on the nature of changes.
    All AI-authored prompts require HITL review (p. 211).
    """
    prompt_version = await prompt_registry.get_version(prompt_id, version)
    parent_version = await prompt_registry.get_version(prompt_id, prompt_version.parent_version)

    escalation_reasons: list[EscalationReason] = []

    # Check: AI-authored (always requires HITL)
    if prompt_version.author_type == "ai":
        escalation_reasons.append(EscalationReason.AI_AUTHORED)

    # Check: Safety instructions modified
    if safety_instructions_changed(parent_version.content, prompt_version.content):
        escalation_reasons.append(EscalationReason.SAFETY_INSTRUCTIONS_MODIFIED)

    # Check: Large diff (>30% change)
    diff = compute_prompt_diff(parent_version.content, prompt_version.content)
    change_ratio = (diff.additions + diff.deletions) / max(
        len(parent_version.content.splitlines()), 1
    )
    if change_ratio > 0.30:
        escalation_reasons.append(EscalationReason.LARGE_DIFF)

    # Check: Sensitive data agent
    agent = await agent_registry.get(agent_id)
    if agent.handles_sensitive_data:
        escalation_reasons.append(EscalationReason.SENSITIVE_DATA_AGENT)

    # Determine reviewer tier
    reviewer_tier = "senior" if len(escalation_reasons) >= 2 else "standard"

    review_request = await review_queue.create(
        agent_id=agent_id,
        prompt_id=prompt_id,
        version=version,
        diff=diff,
        escalation_reasons=escalation_reasons,
        reviewer_tier=reviewer_tier,
        timeout_hours=48,  # Auto-reject if not reviewed within 48h
    )

    # Transition state
    await prompt_registry.update_state(prompt_id, version, "review")

    logger.info(
        "lifecycle.submit_for_review",
        agent_id=agent_id,
        prompt_id=prompt_id,
        version=version,
        escalation_reasons=[r.value for r in escalation_reasons],
        reviewer_tier=reviewer_tier,
    )

    return review_request
```

### 5.4 Emergency Rollback

If a production prompt causes incidents, operators can trigger an emergency rollback:

```python
async def emergency_rollback(
    agent_id: str,
    prompt_id: str,
    reason: str,
    operator_id: str,
) -> int:
    """Immediately revert to the previous production prompt version.

    Creates a new version record (no history rewriting) that copies
    the content of the last known-good production version. This
    maintains the append-only invariant of the versioning system.
    """
    current_prod = await prompt_registry.get_latest(prompt_id, state="production")
    previous_prod = await prompt_registry.get_previous_production(prompt_id, current_prod.version)

    if previous_prod is None:
        raise NoRollbackTargetError(f"No previous production version for {prompt_id}")

    # Create new version with previous content (append-only -- never overwrite)
    rollback_version = await prompt_registry.create_version(
        prompt_id=prompt_id,
        content=previous_prod.content,
        author=f"operator:{operator_id}",
        method="emergency_rollback",
        parent_version=current_prod.version,
        lifecycle_state="production",
        metadata={
            "rollback_reason": reason,
            "rolled_back_from": current_prod.version,
            "rolled_back_to_content_of": previous_prod.version,
        },
    )

    # Demote the problematic version
    await prompt_registry.update_state(prompt_id, current_prod.version, "archived")

    # Emit high-priority alert
    await alerting.emit(
        severity="critical",
        title=f"Emergency prompt rollback: {agent_id}",
        details={
            "agent_id": agent_id,
            "from_version": current_prod.version,
            "to_version": rollback_version,
            "operator": operator_id,
            "reason": reason,
        },
    )

    return rollback_version
```

---

## 6. API Surface

All endpoints are served by the Agent Builder service under the `/api/v1/agent-builder` prefix. Authentication is via OAuth2 bearer token. Authorization is role-based.

### 6.1 Agent CRUD

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/agents` | Create a new agent definition (triggers prompt creation pipeline). | `agent:write` |
| `GET` | `/agents/{agent_id}` | Retrieve an agent definition (latest production version). | `agent:read` |
| `GET` | `/agents` | List all agents with filtering (by team, state, tag). | `agent:read` |
| `PATCH` | `/agents/{agent_id}` | Update agent metadata (description, tags, model_config). Does NOT modify prompts. | `agent:write` |
| `DELETE` | `/agents/{agent_id}` | Archive an agent (soft delete). Requires HITL if agent is in production. | `agent:admin` |

### 6.2 Prompt Versioning

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/agents/{agent_id}/prompts` | Create a new draft prompt version. | `prompt:write` |
| `GET` | `/agents/{agent_id}/prompts/{version}` | Retrieve a specific prompt version. | `prompt:read` |
| `GET` | `/agents/{agent_id}/prompts` | List all prompt versions (paginated). | `prompt:read` |
| `GET` | `/agents/{agent_id}/prompts/diff?from={v1}&to={v2}` | Retrieve diff between two versions. | `prompt:read` |
| `GET` | `/agents/{agent_id}/prompts/lineage/{version}` | Full version ancestry. | `prompt:read` |

### 6.3 Lifecycle Management

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/agents/{agent_id}/prompts/{version}/submit-review` | Transition draft -> review. | `prompt:write` |
| `POST` | `/agents/{agent_id}/prompts/{version}/approve` | HITL approval: review -> staged. | `prompt:review` |
| `POST` | `/agents/{agent_id}/prompts/{version}/reject` | HITL rejection: review -> draft (with feedback). | `prompt:review` |
| `POST` | `/agents/{agent_id}/prompts/{version}/promote` | Staged -> production (requires eval pass + HITL). | `prompt:admin` |
| `POST` | `/agents/{agent_id}/prompts/rollback` | Emergency rollback to previous production version. | `prompt:admin` |

### 6.4 Optimization

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/agents/{agent_id}/optimize` | Trigger an optimization cycle (reflection or evolutionary). | `prompt:optimize` |
| `GET` | `/agents/{agent_id}/optimize/{cycle_id}` | Check status of an optimization cycle. | `prompt:read` |
| `GET` | `/agents/{agent_id}/optimize/history` | List all past optimization cycles with results. | `prompt:read` |
| `POST` | `/agents/{agent_id}/optimize/{cycle_id}/cancel` | Cancel an in-progress optimization cycle. | `prompt:optimize` |

### 6.5 Request/Response Examples

**Create Agent**:

```
POST /api/v1/agent-builder/agents
Content-Type: application/json

{
  "name": "ResearchAgent",
  "description": "Performs web research and produces cited summaries.",
  "capabilities": ["web_search", "summarization", "citation_extraction"],
  "example_inputs": [
    "What are the latest advances in quantum error correction?"
  ],
  "example_outputs": [
    "Summary with 5+ cited sources covering recent breakthroughs..."
  ],
  "tools": ["mcp://search-server/web_search"],
  "team_id": "team-alpha",
  "model_config": {
    "model_tier": "auto",
    "temperature": 0.3
  }
}

Response: 201 Created
{
  "agent_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "ResearchAgent",
  "version": "1.0.0",
  "lifecycle_state": "draft",
  "system_prompt": {
    "prompt_id": "prompt-9f8e7d6c-5b4a-3210-fedc-ba0987654321",
    "version": 1,
    "content_hash": "sha256:a3f2b1c0..."
  },
  "created_at": "2026-02-27T10:00:00Z"
}
```

**Trigger Optimization**:

```
POST /api/v1/agent-builder/agents/a1b2c3d4/optimize
Content-Type: application/json

{
  "strategy": "reflection_loop",
  "max_iterations": 3,
  "min_improvement": 0.02,
  "evalset_id": "evalset-research-v3"
}

Response: 202 Accepted
{
  "cycle_id": "opt-20260227-001",
  "status": "running",
  "strategy": "reflection_loop",
  "started_at": "2026-02-27T10:05:00Z",
  "estimated_duration_seconds": 300
}
```

---

## 7. Failure Modes & Mitigations

Each failure mode is derived from the referenced pattern cards, with specific mitigations tailored to the Agent Builder context.

### 7.1 Optimization Failures

| Failure Mode | Source Pattern | Impact | Mitigation |
|-------------|---------------|--------|------------|
| **Infinite optimization loop** | Reflection (p. 67) | Unbounded cost; no prompt improvement delivered. | Hard `max_iterations` limit on every loop. Default: 3 for reflection, 4 generations for evolutionary. Timer-based circuit breaker at 30 minutes. |
| **Sycophantic critic** | Reflection (p. 68) | Critic always approves; quality degrades silently. | Adversarial framing in critic prompt. Critic is a separate prompt from generator (p. 68). Periodic human audit of critic scores vs. actual production quality. |
| **Prompt regression** | Evaluation & Monitoring (p. 312) | Optimized prompt performs worse than original on some inputs. | Mandatory evalset regression testing before any promotion. Evalset includes historical failure cases. Score must improve overall AND not regress on any individual test case by more than 10%. |
| **Evolutionary convergence to local optimum** | Learning & Adaptation (p. 172) | All candidates become similar; no real improvement. | Diversity pressure in selection (penalize candidates too similar to each other). Periodic injection of random mutations. Crossover between structurally different parents. |
| **Cost explosion during optimization** | Resource-Aware Optimization (p. 258) | Evolutionary search with many candidates and generations burns excessive tokens. | Cheap model for generation; strong model for evaluation (p. 258). Hard token budget per optimization cycle. Early termination when improvement plateaus. |

### 7.2 Versioning Failures

| Failure Mode | Source Pattern | Impact | Mitigation |
|-------------|---------------|--------|------------|
| **Version corruption** | Memory Management (p. 151) | Prompt version content does not match its hash; integrity violation. | SHA-256 content hash computed at write time and verified at read time. Append-only storage prevents in-place modification. |
| **Lost diff chain** | Memory Management (p. 151) | Cannot reconstruct how a prompt evolved; audit trail broken. | Diffs computed and stored at write time. If diff is missing, recompute from the two version contents (both are immutable). |
| **Concurrent version creation** | Memory Management (p. 151) | Two optimizers create conflicting versions simultaneously. | Optimistic locking on version number. Only one writer can create version N+1 for a given prompt. Conflicts return 409; the losing writer must re-read and retry. |

### 7.3 Lifecycle Failures

| Failure Mode | Source Pattern | Impact | Mitigation |
|-------------|---------------|--------|------------|
| **Review bottleneck** | HITL (p. 211) | Prompts stuck in `review` state; optimizations never reach production. | 48-hour timeout on review requests. Auto-escalation to senior reviewer after 24 hours. Dashboard alert when review queue depth exceeds threshold. |
| **Unauthorized promotion** | HITL (p. 211) | Prompt reaches production without proper review. | State transitions enforced at the database level (state machine constraints). Promotion requires both `prompt:admin` role AND a completed review record. All transitions logged to immutable audit log. |
| **Rollback to bad version** | Exception Handling (p. 201) | Emergency rollback targets a version that is itself problematic. | Rollback targets the last version that was in production for at least 24 hours with no incidents. Rollback creates a new version (append-only), so the problematic version is preserved for analysis. |

### 7.4 Pipeline Failures

| Failure Mode | Source Pattern | Impact | Mitigation |
|-------------|---------------|--------|------------|
| **Gate failure in creation pipeline** | Prompt Chaining (p. 3) | Step fails validation; user gets no agent. | Each gate returns structured error messages explaining what failed and how to fix it. User can retry with modified inputs. Partial results from successful steps are cached in `temp:` storage (p. 151) for 1 hour. |
| **Safety review false positive** | Guardrails/Safety (p. 285) | Legitimate prompt blocked by overly aggressive safety review. | Safety review returns specific policy violations, not just pass/fail. User can appeal with justification. Appeal triggers senior human review. Track false positive rate and recalibrate safety review prompt quarterly. |

---

## 8. Instrumentation

### 8.1 Structured Logging

Every operation in the Agent Builder emits structured log entries to the Observability Platform. Log entries follow the platform-wide schema.

```python
# All log entries include these base fields
LOG_SCHEMA = {
    "timestamp": "ISO-8601",
    "service": "agent-builder",
    "trace_id": "UUID",
    "span_id": "UUID",
    "level": "info|warn|error",
    "event": "dot.separated.event.name",
    # Event-specific fields below
}
```

**Key events logged**:

| Event | Level | Fields | Purpose |
|-------|-------|--------|---------|
| `agent.created` | info | `agent_id`, `name`, `author` | Track agent creation rate. |
| `prompt.version_created` | info | `prompt_id`, `version`, `author`, `author_type`, `content_hash` | Full version audit trail. |
| `prompt.state_transition` | info | `prompt_id`, `version`, `from_state`, `to_state`, `actor` | Lifecycle state machine audit. |
| `optimization.started` | info | `cycle_id`, `agent_id`, `strategy`, `config` | Track optimization activity. |
| `optimization.iteration` | info | `cycle_id`, `iteration`, `score`, `delta` | Per-iteration progress. |
| `optimization.completed` | info | `cycle_id`, `result`, `improvement_delta`, `iterations_used` | Optimization outcome. |
| `optimization.failed` | error | `cycle_id`, `error_type`, `error_message` | Optimization failures. |
| `review.submitted` | info | `prompt_id`, `version`, `escalation_reasons` | Review queue tracking. |
| `review.approved` | info | `prompt_id`, `version`, `reviewer_id`, `review_duration_hours` | Review throughput. |
| `review.rejected` | info | `prompt_id`, `version`, `reviewer_id`, `rejection_reason` | Rejection analysis. |
| `rollback.executed` | critical | `agent_id`, `from_version`, `to_version`, `operator`, `reason` | Incident tracking. |

### 8.2 Metrics

Metrics are exported as Prometheus-compatible gauges and counters, scraped by the Observability Platform and visualized in Grafana dashboards.

| Metric | Type | Labels | Alert Threshold |
|--------|------|--------|----------------|
| `agent_builder_agents_total` | gauge | `lifecycle_state`, `team_id` | -- |
| `agent_builder_prompt_versions_total` | counter | `agent_id`, `author_type` | -- |
| `agent_builder_optimization_cycles_total` | counter | `strategy`, `result` | -- |
| `agent_builder_optimization_improvement` | histogram | `strategy` | Alert if median < 0.01 for 7 days (optimization ineffective). |
| `agent_builder_optimization_duration_seconds` | histogram | `strategy` | Alert if P95 > 1800s (30 min). |
| `agent_builder_optimization_cost_tokens` | histogram | `strategy` | Alert if P95 > 500,000 tokens. |
| `agent_builder_review_queue_depth` | gauge | `reviewer_tier` | Alert if > 20 pending reviews. |
| `agent_builder_review_duration_hours` | histogram | `reviewer_tier` | Alert if P95 > 36 hours. |
| `agent_builder_state_transitions_total` | counter | `from_state`, `to_state` | -- |
| `agent_builder_rollbacks_total` | counter | `agent_id` | Alert on any rollback (severity: critical). |
| `agent_builder_evalset_pass_rate` | gauge | `agent_id` | Alert if < 0.95 for any production agent. |
| `agent_builder_critic_score_distribution` | histogram | `dimension` | Alert if mean task_accuracy < 3.0. |

### 8.3 Alerts

| Alert Name | Condition | Severity | Action |
|-----------|-----------|----------|--------|
| `OptimizationIneffective` | Median improvement delta < 0.01 across all cycles in 7-day window. | warning | Review optimization strategy; consider switching from reflection to evolutionary or vice versa. Audit evalset for staleness. |
| `ReviewQueueBacklog` | More than 20 prompts pending review for > 6 hours. | warning | Page on-call reviewer. Consider auto-extending review timeout. |
| `PromptRollback` | Any emergency rollback executed. | critical | Page on-call engineer. Trigger post-incident review. Freeze further promotions for the affected agent until root cause identified. |
| `EvalsetRegression` | Production agent's evalset pass rate drops below 0.95. | critical | Auto-trigger optimization cycle. Page agent owner. If pass rate < 0.80, auto-rollback to previous version. |
| `OptimizationCostSpike` | Single optimization cycle exceeds 500,000 tokens. | warning | Investigate prompt complexity. Consider reducing population size or generation count for evolutionary search. |
| `CriticScoreDrift` | Mean critic scores diverge from human evaluation scores by > 0.5 for 30 days. | warning | Recalibrate critic prompt. Schedule human eval comparison audit. |

### 8.4 Dashboard Panels

The Agent Builder Grafana dashboard contains the following panels:

1. **Agent Inventory** -- Table showing all agents, their current lifecycle state, latest prompt version, and last optimization date.
2. **Prompt Version Velocity** -- Time series of prompt versions created per day, split by `author_type` (human vs. AI).
3. **Optimization Effectiveness** -- Histogram of improvement deltas per optimization cycle, split by strategy.
4. **Review Pipeline** -- Funnel visualization showing drafts -> reviews -> staged -> production conversion rates.
5. **Review Queue Health** -- Real-time gauge of pending reviews by reviewer tier, with SLA lines.
6. **Critic Score Trends** -- Per-dimension score trends over time for each agent, enabling detection of score drift.
7. **Cost per Optimization** -- Token usage per cycle, split by generator vs. critic costs.
8. **Rollback History** -- Timeline of all rollback events with links to incident reports.

---

## Appendix A: Pattern Reference Index

| Pattern | Pages | Usage in Agent Builder |
|---------|-------|----------------------|
| Reflection | p. 61-68 | Generator-Critic optimization loop (Section 4.1). Separate critic (p. 68). Measurable criteria (p. 65). Max iterations (p. 67). |
| Learning & Adaptation | p. 163-172 | RLVR for evalset-based verifiable rewards (p. 168). Evolutionary search / AlphaEvolve (p. 172) for prompt space exploration (Section 4.2). |
| Prompt Chaining | p. 1-7 | Deterministic sequential pipeline for new agent creation (Section 4.3). Gate checks between steps (p. 3). |
| Memory Management | p. 141-155 | State prefix system (`user:`, `app:`, `temp:`) for prompt and draft storage (p. 151). Storage layout (Section 2.2). |
| HITL | p. 207-215 | Human approval gates for prompt promotion (p. 211). Explicit escalation triggers (p. 211). Review and promotion gates (Section 5.3). |
| Evaluation & Monitoring | p. 301-314 | LLM-as-Judge rubric with 5 dimensions (p. 306). Evalset files for regression testing (p. 312). Critic rubric (Section 4.1.2). |
| Resource-Aware Optimization | p. 255-272 | Cheap model for prompt generation, expensive model for quality evaluation (p. 258). Cost controls on optimization (Section 4.1.3, 4.2.2). |

---

## Appendix B: Open Design Questions

1. **Critic calibration frequency**: How often should the critic prompt itself be evaluated against human judgments? Proposal: monthly, using a calibration set of 50 prompt pairs rated by humans.
2. **Cross-agent optimization**: Should the evolutionary search be allowed to share genetic material (prompt fragments) across agents of the same type? This could accelerate convergence but risks prompt contamination.
3. **Evalset generation**: Should evalsets be auto-generated from production traffic, or manually curated? Proposal: hybrid -- auto-generated baseline with human curation for edge cases.
4. **Optimization scheduling**: Should optimization cycles run on a fixed schedule (e.g., weekly) or be purely trigger-based (score drops below threshold)? Proposal: both -- weekly proactive + threshold-based reactive.
5. **Multi-tenant prompt isolation**: In a multi-tenant deployment, can optimization insights from one tenant's agents benefit another tenant's agents? Privacy implications need resolution.
