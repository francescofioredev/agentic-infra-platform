# 08 — Evaluation Framework

## 1. Overview & Responsibility

The Evaluation Framework is the quality backbone of the AgentForge platform. It provides automated, reproducible, and statistically rigorous assessment of every agent, prompt, and team configuration before and after production deployment. Its scope covers the full evaluation lifecycle: creating and managing evalsets, running LLM-as-Judge assessments, validating multi-step trajectories, orchestrating A/B experiments between agent versions, and maintaining a benchmark leaderboard for continuous improvement.

The framework implements the **Five-Level Evaluation Pyramid** (p. 303):

```
                    ┌───────────────────┐
                    │  Level 5: Human   │  Gold-standard annotation
                    │  Expert Review    │  (slowest, highest signal)
                    ├───────────────────┤
                    │  Level 4: A/B     │  Live traffic experiments
                    │  Testing          │  with statistical gates
                    ├───────────────────┤
                    │  Level 3: LLM-as- │  Rubric-based automated
                    │  Judge            │  quality scoring
                    ├───────────────────┤
                    │  Level 2: Evalset │  Regression testing against
                    │  Regression       │  curated input-output pairs
                    ├───────────────────┤
                    │  Level 1: Core    │  Accuracy, Latency, Token
                    │  Metrics          │  usage, Tool Accuracy (p. 304)
                    └───────────────────┘
```

**Core Metrics** tracked at Level 1 (p. 304):

| Metric | Description | Source |
|--------|-------------|--------|
| **Accuracy** | Correctness of agent final output against ground truth | Evalset comparisons |
| **Latency** | End-to-end and per-step response times | OpenTelemetry spans |
| **Token Usage** | Input/output/total tokens per interaction | LLMInteractionMonitor (p. 310) |
| **Tool Accuracy** | Correct tool selected AND correct parameters provided | Trajectory evaluator |
| **Cost** | Monetary cost per interaction | Cost & Resource Manager |

**Architectural Principle**: Establish a **baseline before deployment** (p. 305). No agent version is promoted to production without passing all five pyramid levels that are configured for its evaluation policy.

**Relationship to Other Subsystems**:

```
                    ┌──────────────────┐
                    │  Prompt Registry  │◄──── Eval gates control
                    │  (Subsystem 7)   │      prompt promotion
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
    Traces ────────►│   Evaluation     │◄──── Agent Builder
    (Observability) │   Framework      │      (evalset from
                    │   (Subsystem 8)  │       production logs)
                    └──┬──────┬────┬───┘
                       │      │    │
              ┌────────┘      │    └──────────┐
              ▼               ▼               ▼
     ┌────────────┐  ┌──────────────┐  ┌───────────┐
     │  Learning  │  │  Guardrail   │  │  Cost &   │
     │  & Adapt.  │  │  System      │  │  Resource  │
     │ (reward    │  │ (safety eval │  │  Manager   │
     │  signal)   │  │  integration)│  │ (budget)   │
     └────────────┘  └──────────────┘  └───────────┘
```

Eval metrics serve as the **reward signal** for the Learning & Adaptation subsystem (p. 165). When an agent's eval scores improve, the prompt or configuration change that caused the improvement is reinforced. When scores regress, the change is rolled back or flagged for review.

---

## 2. Evalset Management

An **evalset** is a versioned collection of input-expected output pairs that define the contract an agent must satisfy (p. 312). Evalsets are the foundation of regression testing (Level 2 of the pyramid).

### 2.1 Evalset Structure

??? example "View JSON example"

    ```json
    {
      "evalset_id": "es-uuid-v4",
      "name": "research-agent-core",
      "version": "3.1.0",
      "agent_ref": "agent://research-agent",
      "created_at": "2026-02-15T10:00:00Z",
      "tags": ["research", "summarization", "citation"],
      "schema_version": "1.0",
      "entries": [
        {
          "entry_id": "entry-001",
          "input": {
            "query": "Summarize recent advances in quantum error correction"
          },
          "expected_output": {
            "summary_contains": ["surface codes", "logical qubits"],
            "sources_min_count": 3,
            "format": "structured_summary"
          },
          "expected_trajectory": [
            {"tool": "web_search", "args_contain": {"query": "quantum error correction"}},
            {"tool": "scholar_search", "args_contain": {"query": "surface codes"}},
            {"tool": "summarize", "args_contain": {}}
          ],
          "tags": ["multi-tool", "research"],
          "difficulty": "medium",
          "weight": 1.0
        }
      ],
      "passing_criteria": {
        "min_accuracy": 0.85,
        "min_tool_accuracy": 0.90,
        "max_p95_latency_ms": 8000,
        "max_avg_tokens": 5000
      }
    }
    ```

### 2.2 Evalset Versioning

Evalsets are stored in a Git-backed database, following the same version-control philosophy as the Prompt Registry (Subsystem 7). Every modification creates a new version with a full diff trail.

```
evalsets/
├── research-agent-core/
│   ├── v3.1.0.json
│   ├── v3.0.0.json
│   └── metadata.json        # lineage, owner, refresh schedule
├── customer-support-agent/
│   ├── v2.0.0.json
│   └── metadata.json
└── index.json                # global evalset registry
```

**Versioning rules**:
- **Patch** (3.1.0 -> 3.1.1): Fix typos or clarify expected outputs without changing intent.
- **Minor** (3.1.0 -> 3.2.0): Add new entries or adjust weights.
- **Major** (3.1.0 -> 4.0.0): Change passing criteria, remove entries, or restructure the schema.

### 2.3 Refresh from Production

Evalsets must evolve with the real-world distribution of inputs. The framework supports automatic refresh:

1. **Sampling Pipeline**: The Observability Platform streams production traces. A sampler selects diverse, representative interactions based on input clustering.
2. **Human Annotation Queue**: Sampled interactions are sent to a human review queue where annotators label the expected output and trajectory. This respects the HITL pattern (p. 207).
3. **Merge & Version**: Annotated entries are proposed as additions to the evalset. A review gate (configurable as auto-approve for low-risk additions or HITL for high-risk) controls merging.
4. **Staleness Detection**: Entries that no longer reflect production distribution (measured by input embedding drift) are flagged for retirement.

### 2.4 ADK Eval Methods Integration

The framework supports the evaluation methods from the ADK ecosystem (p. 314):

| ADK Method | AgentForge Mapping |
|---|---|
| `evaluate_response()` | Evalset entry-level output comparison |
| `evaluate_trajectory()` | Trajectory Evaluation Engine (Section 4) |
| `evaluate_with_llm()` | LLM-as-Judge pipeline (Section 3) |
| `evaluate_metric()` | Core metric extraction at Level 1 |

---

## 3. LLM-as-Judge Implementation

LLM-as-Judge provides automated qualitative assessment (Level 3 of the pyramid). A judge LLM evaluates agent outputs against a structured rubric, producing both numeric scores and natural-language rationale (p. 306).

### 3.1 Rubric Definition

The default rubric implements the five evaluation dimensions from the reference architecture (p. 306):

| Dimension | Description | Weight |
|-----------|-------------|--------|
| **Clarity** | Is the output clear, well-structured, and easy to understand? | 0.20 |
| **Neutrality** | Is the output balanced and free from unjustified bias? | 0.15 |
| **Relevance** | Does the output directly address the user's request? | 0.25 |
| **Completeness** | Does the output cover all aspects of the request? | 0.25 |
| **Audience** | Is the output appropriately tailored to the target audience? | 0.15 |

This rubric shares the critique structure with the **Reflection** pattern (p. 61-68). The same dimensions used by a Generator-Critic reflection loop to self-improve are reused here for external evaluation, ensuring consistency between self-assessment and independent assessment.

Custom rubrics can extend or replace the default. For example, a code-generation agent might add **Correctness**, **Security**, and **Efficiency** dimensions while removing **Neutrality**.

### 3.2 Pseudocode: LLM-as-Judge Rubric Evaluator

??? example "View Python pseudocode"

    ```python
    from dataclasses import dataclass, field
    from enum import Enum
    from typing import Optional


    class RubricDimension(Enum):
        """Default rubric dimensions from the Evaluation & Monitoring pattern (p. 306)."""
        CLARITY = "clarity"
        NEUTRALITY = "neutrality"
        RELEVANCE = "relevance"
        COMPLETENESS = "completeness"
        AUDIENCE = "audience"


    @dataclass
    class DimensionSpec:
        """Specification for a single rubric dimension."""
        name: RubricDimension | str
        description: str
        weight: float  # 0.0 to 1.0, all weights must sum to 1.0
        score_range: tuple[int, int] = (1, 5)  # min, max
        examples: dict[int, str] = field(default_factory=dict)  # score -> example rationale


    @dataclass
    class DimensionResult:
        """Result of evaluating one dimension."""
        dimension: str
        score: int
        rationale: str
        confidence: float  # 0.0 to 1.0, judge's self-assessed confidence


    @dataclass
    class JudgeVerdict:
        """Complete judge verdict for one evaluation."""
        eval_id: str
        agent_id: str
        entry_id: str
        dimension_results: list[DimensionResult]
        weighted_score: float  # computed from dimension scores and weights
        overall_rationale: str
        judge_model: str
        judge_latency_ms: int
        judge_tokens: int


    class LLMJudge:
        """
        LLM-as-Judge evaluator implementing rubric-based assessment (p. 306).

        The judge model evaluates agent outputs against a structured rubric,
        producing per-dimension scores with rationale. This is Level 3 of the
        Five-Level Evaluation Pyramid (p. 303).
        """

        def __init__(
            self,
            judge_model: str = "claude-sonnet",  # default judge model
            rubric: list[DimensionSpec] | None = None,
            temperature: float = 0.0,  # deterministic judging
            max_retries: int = 2,
        ):
            self.judge_model = judge_model
            self.rubric = rubric or self._default_rubric()
            self.temperature = temperature
            self.max_retries = max_retries
            self._validate_rubric()

        def _default_rubric(self) -> list[DimensionSpec]:
            """Build the default five-dimension rubric (p. 306)."""
            return [
                DimensionSpec(
                    name=RubricDimension.CLARITY,
                    description="Is the output clear, well-structured, and easy to understand?",
                    weight=0.20,
                    examples={
                        1: "Incoherent, disorganized, impossible to follow.",
                        3: "Mostly clear with some confusing sections.",
                        5: "Exceptionally clear, logically structured, easy to follow.",
                    },
                ),
                DimensionSpec(
                    name=RubricDimension.NEUTRALITY,
                    description="Is the output balanced and free from unjustified bias?",
                    weight=0.15,
                    examples={
                        1: "Strongly biased, presents only one perspective.",
                        3: "Generally balanced with minor bias.",
                        5: "Fully neutral, acknowledges multiple perspectives where appropriate.",
                    },
                ),
                DimensionSpec(
                    name=RubricDimension.RELEVANCE,
                    description="Does the output directly address the user's request?",
                    weight=0.25,
                    examples={
                        1: "Completely off-topic or ignores the request.",
                        3: "Partially relevant but includes significant tangents.",
                        5: "Directly and precisely addresses every aspect of the request.",
                    },
                ),
                DimensionSpec(
                    name=RubricDimension.COMPLETENESS,
                    description="Does the output cover all aspects of the request?",
                    weight=0.25,
                    examples={
                        1: "Missing most requested information.",
                        3: "Covers main points but misses important details.",
                        5: "Comprehensive coverage of all requested aspects.",
                    },
                ),
                DimensionSpec(
                    name=RubricDimension.AUDIENCE,
                    description="Is the output appropriately tailored to the target audience?",
                    weight=0.15,
                    examples={
                        1: "Completely inappropriate tone/complexity for the audience.",
                        3: "Mostly appropriate with occasional mismatches.",
                        5: "Perfectly calibrated for the target audience.",
                    },
                ),
            ]

        def _validate_rubric(self):
            total_weight = sum(d.weight for d in self.rubric)
            assert abs(total_weight - 1.0) < 1e-6, f"Rubric weights must sum to 1.0, got {total_weight}"

        def _build_judge_prompt(
            self,
            user_input: str,
            agent_output: str,
            context: Optional[str] = None,
        ) -> str:
            """
            Construct the structured prompt sent to the judge model.

            The prompt instructs the judge to evaluate each dimension independently,
            provide a score and rationale, then synthesize an overall assessment.
            """
            dimensions_block = ""
            for dim in self.rubric:
                name = dim.name.value if isinstance(dim.name, RubricDimension) else dim.name
                examples_text = "\n".join(
                    f"        Score {score}: {text}" for score, text in sorted(dim.examples.items())
                )
                dimensions_block += f"""
        - **{name}** (weight: {dim.weight}): {dim.description}
          Score range: {dim.score_range[0]}-{dim.score_range[1]}
          Anchor examples:
    {examples_text}
    """

            return f"""You are an expert evaluation judge. Your task is to evaluate the quality
    of an AI agent's output against a structured rubric.

    ## User Input
    {user_input}

    {f"## Additional Context\n{context}" if context else ""}

    ## Agent Output
    {agent_output}

    ## Evaluation Rubric
    Evaluate the agent output on each of the following dimensions:{dimensions_block}

    ## Instructions
    1. Evaluate each dimension INDEPENDENTLY. Do not let one dimension influence another.
    2. For each dimension, provide:
       - A numeric score within the specified range
       - A concise rationale (1-3 sentences) justifying the score
       - A confidence level (0.0 to 1.0) for your assessment
    3. After all dimensions, provide a brief overall summary.

    Respond in the following JSON format:
    {{
      "dimensions": [
        {{"dimension": "<name>", "score": <int>, "rationale": "<text>", "confidence": <float>}},
        ...
      ],
      "overall_rationale": "<summary text>"
    }}"""

        async def evaluate(
            self,
            user_input: str,
            agent_output: str,
            agent_id: str,
            entry_id: str,
            context: Optional[str] = None,
        ) -> JudgeVerdict:
            """
            Run the LLM-as-Judge evaluation for a single agent output.

            Returns a JudgeVerdict with per-dimension scores and an overall
            weighted score.
            """
            prompt = self._build_judge_prompt(user_input, agent_output, context)

            # Call the judge model with structured output parsing
            response = await llm_client.generate(
                model=self.judge_model,
                prompt=prompt,
                temperature=self.temperature,
                response_format="json",
            )

            parsed = json.loads(response.text)

            dimension_results = []
            for dim_result in parsed["dimensions"]:
                dimension_results.append(DimensionResult(
                    dimension=dim_result["dimension"],
                    score=dim_result["score"],
                    rationale=dim_result["rationale"],
                    confidence=dim_result["confidence"],
                ))

            # Compute weighted score
            weighted_score = 0.0
            for dr in dimension_results:
                spec = next(
                    d for d in self.rubric
                    if (d.name.value if isinstance(d.name, RubricDimension) else d.name) == dr.dimension
                )
                normalized = (dr.score - spec.score_range[0]) / (spec.score_range[1] - spec.score_range[0])
                weighted_score += normalized * spec.weight

            return JudgeVerdict(
                eval_id=generate_uuid(),
                agent_id=agent_id,
                entry_id=entry_id,
                dimension_results=dimension_results,
                weighted_score=weighted_score,
                overall_rationale=parsed["overall_rationale"],
                judge_model=self.judge_model,
                judge_latency_ms=response.latency_ms,
                judge_tokens=response.total_tokens,
            )
    ```

### 3.3 Judge Model Selection

The judge model must be **at least as capable** as the agent being evaluated, but should ideally be **more capable** to provide reliable signal. Selection guidelines:

| Agent Model Tier | Recommended Judge Model | Rationale |
|---|---|---|
| Fast (Haiku-class) | Sonnet-class | Strong enough to judge simple outputs reliably |
| Balanced (Sonnet-class) | Opus-class | Needs a more capable evaluator for nuanced outputs |
| Frontier (Opus-class) | Opus-class + multi-judge | Consensus of multiple judge calls reduces error |

For frontier-class agents, employ **multi-judge consensus**: run the evaluation 3 times (or with 3 different judge models) and take the median score per dimension. This is analogous to the **Tripartite Review** from the Exploration & Discovery pattern (p. 330-355).

### 3.4 Bias Mitigation

LLM judges are susceptible to known biases:

| Bias | Description | Mitigation |
|---|---|---|
| **Position bias** | Preference for responses shown first in comparisons | Randomize presentation order; run each comparison twice with swapped order |
| **Verbosity bias** | Preference for longer outputs | Include rubric instruction: "Brevity is not a flaw. Evaluate substance, not length." |
| **Self-preference** | LLM prefers outputs from same model family | Use cross-family judges when possible (e.g., Claude judging GPT outputs and vice versa) |
| **Anchoring** | Judge anchors on the first dimension evaluated | Randomize dimension evaluation order across runs |
| **Leniency/Severity** | Consistently too generous or too harsh | Calibrate with a set of pre-scored gold-standard examples; measure and correct systematic offset |

The framework stores raw judge outputs alongside bias-correction metadata, enabling post-hoc recalibration when new gold-standard labels become available.

---

## 4. Trajectory Evaluation Engine

Trajectory evaluation validates the **sequence of actions** an agent takes, not just the final output. This is essential for multi-step agents where the path matters as much as the destination (p. 308).

### 4.1 Evaluation Types

The framework implements all four trajectory evaluation types from the reference architecture (p. 308):

| Type | Description | Use Case |
|---|---|---|
| **Exact-Order** | Agent must call the exact tools in the exact sequence | Strict workflow compliance (e.g., regulatory processes) |
| **In-Order** | Agent must call the expected tools in order, but may have additional steps between them | Semi-structured workflows |
| **Any-Order** | All expected tools must be called, but in any order | Flexible exploration tasks |
| **Single-Tool** | A specific tool must be called at least once | Minimum capability validation |

### 4.2 Trajectory Representation

A trajectory is the ordered list of actions (tool calls) an agent took during execution:

??? example "View JSON example"

    ```json
    {
      "trajectory_id": "traj-uuid-v4",
      "agent_id": "agent-research-v2.3",
      "session_id": "session-uuid",
      "steps": [
        {
          "step_index": 0,
          "tool_name": "web_search",
          "tool_args": {"query": "quantum error correction 2026"},
          "tool_result_summary": "5 results returned",
          "latency_ms": 820,
          "tokens": {"input": 150, "output": 480}
        },
        {
          "step_index": 1,
          "tool_name": "scholar_search",
          "tool_args": {"query": "surface code logical qubit"},
          "tool_result_summary": "3 papers found",
          "latency_ms": 1100,
          "tokens": {"input": 200, "output": 620}
        },
        {
          "step_index": 2,
          "tool_name": "summarize",
          "tool_args": {"sources": ["..."], "format": "structured"},
          "tool_result_summary": "Summary generated",
          "latency_ms": 2200,
          "tokens": {"input": 1800, "output": 950}
        }
      ]
    }
    ```

### 4.3 Pseudocode: Trajectory Evaluator

??? example "View Python pseudocode"

    ```python
    from dataclasses import dataclass
    from enum import Enum
    from typing import Optional


    class TrajectoryMatchType(Enum):
        """
        Four trajectory evaluation types from the reference architecture (p. 308).
        """
        EXACT_ORDER = "exact_order"  # Exact tools in exact sequence
        IN_ORDER = "in_order"        # Expected tools in order, extras allowed between
        ANY_ORDER = "any_order"      # All expected tools called, any sequence
        SINGLE_TOOL = "single_tool"  # At least one specific tool called


    @dataclass
    class ExpectedStep:
        """One expected step in a trajectory."""
        tool_name: str
        args_contain: Optional[dict] = None  # partial match on tool arguments
        args_exact: Optional[dict] = None    # exact match on tool arguments


    @dataclass
    class ActualStep:
        """One actual step taken by the agent."""
        step_index: int
        tool_name: str
        tool_args: dict
        tool_result_summary: str
        latency_ms: int


    @dataclass
    class TrajectoryResult:
        """Result of trajectory evaluation."""
        match_type: TrajectoryMatchType
        passed: bool
        expected_steps: list[ExpectedStep]
        actual_steps: list[ActualStep]
        matched_indices: list[tuple[int, int]]  # (expected_idx, actual_idx) pairs
        missing_steps: list[ExpectedStep]       # expected but not found
        extra_steps: list[ActualStep]           # not in expected (informational)
        tool_accuracy: float                    # fraction of expected steps matched
        args_accuracy: float                    # fraction of matched steps with correct args
        explanation: str


    class TrajectoryEvaluator:
        """
        Evaluates agent action sequences against expected trajectories (p. 308).

        Supports four match types reflecting different levels of strictness,
        from exact-order (most strict) to single-tool (most lenient).
        Tool accuracy is a core metric at Level 1 of the evaluation pyramid (p. 304).
        """

        def evaluate(
            self,
            expected: list[ExpectedStep],
            actual: list[ActualStep],
            match_type: TrajectoryMatchType,
        ) -> TrajectoryResult:
            """Dispatch to the appropriate matching strategy."""
            if match_type == TrajectoryMatchType.EXACT_ORDER:
                return self._eval_exact_order(expected, actual)
            elif match_type == TrajectoryMatchType.IN_ORDER:
                return self._eval_in_order(expected, actual)
            elif match_type == TrajectoryMatchType.ANY_ORDER:
                return self._eval_any_order(expected, actual)
            elif match_type == TrajectoryMatchType.SINGLE_TOOL:
                return self._eval_single_tool(expected, actual)
            else:
                raise ValueError(f"Unknown match type: {match_type}")

        def _step_matches(self, expected: ExpectedStep, actual: ActualStep) -> bool:
            """Check if an actual step matches an expected step."""
            if expected.tool_name != actual.tool_name:
                return False
            if expected.args_exact is not None:
                if actual.tool_args != expected.args_exact:
                    return False
            if expected.args_contain is not None:
                for key, value in expected.args_contain.items():
                    if key not in actual.tool_args:
                        return False
                    if isinstance(value, str) and isinstance(actual.tool_args[key], str):
                        if value.lower() not in actual.tool_args[key].lower():
                            return False
                    elif actual.tool_args[key] != value:
                        return False
            return True

        def _eval_exact_order(
            self, expected: list[ExpectedStep], actual: list[ActualStep]
        ) -> TrajectoryResult:
            """
            Exact-order matching (p. 308): the agent must call exactly the
            expected tools in exactly the expected sequence, with no extra steps.
            """
            matched = []
            missing = []

            if len(actual) != len(expected):
                # Length mismatch is an automatic failure for exact-order
                for i, exp in enumerate(expected):
                    if i < len(actual) and self._step_matches(exp, actual[i]):
                        matched.append((i, i))
                    else:
                        missing.append(exp)
            else:
                for i, (exp, act) in enumerate(zip(expected, actual)):
                    if self._step_matches(exp, act):
                        matched.append((i, i))
                    else:
                        missing.append(exp)

            extra = [a for i, a in enumerate(actual) if i not in {m[1] for m in matched}]
            tool_acc = len(matched) / len(expected) if expected else 1.0
            args_acc = self._compute_args_accuracy(expected, actual, matched)
            passed = len(matched) == len(expected) and len(extra) == 0

            return TrajectoryResult(
                match_type=TrajectoryMatchType.EXACT_ORDER,
                passed=passed,
                expected_steps=expected,
                actual_steps=actual,
                matched_indices=matched,
                missing_steps=missing,
                extra_steps=extra,
                tool_accuracy=tool_acc,
                args_accuracy=args_acc,
                explanation=self._build_explanation("exact_order", passed, matched, missing, extra),
            )

        def _eval_in_order(
            self, expected: list[ExpectedStep], actual: list[ActualStep]
        ) -> TrajectoryResult:
            """
            In-order matching (p. 308): expected tools must appear in sequence
            within the actual steps, but additional steps may appear between them.
            Uses a two-pointer scan.
            """
            matched = []
            exp_idx = 0

            for act_idx, act in enumerate(actual):
                if exp_idx < len(expected) and self._step_matches(expected[exp_idx], act):
                    matched.append((exp_idx, act_idx))
                    exp_idx += 1

            missing = [expected[i] for i in range(len(expected)) if i not in {m[0] for m in matched}]
            extra = [actual[i] for i in range(len(actual)) if i not in {m[1] for m in matched}]
            tool_acc = len(matched) / len(expected) if expected else 1.0
            args_acc = self._compute_args_accuracy(expected, actual, matched)
            passed = len(matched) == len(expected)

            return TrajectoryResult(
                match_type=TrajectoryMatchType.IN_ORDER,
                passed=passed,
                expected_steps=expected,
                actual_steps=actual,
                matched_indices=matched,
                missing_steps=missing,
                extra_steps=extra,
                tool_accuracy=tool_acc,
                args_accuracy=args_acc,
                explanation=self._build_explanation("in_order", passed, matched, missing, extra),
            )

        def _eval_any_order(
            self, expected: list[ExpectedStep], actual: list[ActualStep]
        ) -> TrajectoryResult:
            """
            Any-order matching (p. 308): all expected tools must appear in the
            actual steps, but in any order. Uses greedy matching to maximize
            the number of matched pairs.
            """
            matched = []
            used_actual = set()

            for exp_idx, exp in enumerate(expected):
                for act_idx, act in enumerate(actual):
                    if act_idx not in used_actual and self._step_matches(exp, act):
                        matched.append((exp_idx, act_idx))
                        used_actual.add(act_idx)
                        break

            missing = [expected[i] for i in range(len(expected)) if i not in {m[0] for m in matched}]
            extra = [actual[i] for i in range(len(actual)) if i not in used_actual]
            tool_acc = len(matched) / len(expected) if expected else 1.0
            args_acc = self._compute_args_accuracy(expected, actual, matched)
            passed = len(matched) == len(expected)

            return TrajectoryResult(
                match_type=TrajectoryMatchType.ANY_ORDER,
                passed=passed,
                expected_steps=expected,
                actual_steps=actual,
                matched_indices=matched,
                missing_steps=missing,
                extra_steps=extra,
                tool_accuracy=tool_acc,
                args_accuracy=args_acc,
                explanation=self._build_explanation("any_order", passed, matched, missing, extra),
            )

        def _eval_single_tool(
            self, expected: list[ExpectedStep], actual: list[ActualStep]
        ) -> TrajectoryResult:
            """
            Single-tool matching (p. 308): at least one expected tool must be
            called at least once. This is the most lenient trajectory check.
            """
            matched = []
            used_actual = set()

            for exp_idx, exp in enumerate(expected):
                for act_idx, act in enumerate(actual):
                    if act_idx not in used_actual and self._step_matches(exp, act):
                        matched.append((exp_idx, act_idx))
                        used_actual.add(act_idx)
                        break  # only need one match per expected tool

            missing = [expected[i] for i in range(len(expected)) if i not in {m[0] for m in matched}]
            extra = [actual[i] for i in range(len(actual)) if i not in used_actual]
            # For single-tool, passing requires at least one match
            passed = len(matched) >= 1
            tool_acc = len(matched) / len(expected) if expected else 1.0
            args_acc = self._compute_args_accuracy(expected, actual, matched)

            return TrajectoryResult(
                match_type=TrajectoryMatchType.SINGLE_TOOL,
                passed=passed,
                expected_steps=expected,
                actual_steps=actual,
                matched_indices=matched,
                missing_steps=missing,
                extra_steps=extra,
                tool_accuracy=tool_acc,
                args_accuracy=args_acc,
                explanation=self._build_explanation("single_tool", passed, matched, missing, extra),
            )

        def _compute_args_accuracy(
            self,
            expected: list[ExpectedStep],
            actual: list[ActualStep],
            matched: list[tuple[int, int]],
        ) -> float:
            """Compute what fraction of matched steps had fully correct arguments."""
            if not matched:
                return 0.0
            correct = 0
            for exp_idx, act_idx in matched:
                exp = expected[exp_idx]
                act = actual[act_idx]
                if exp.args_exact is not None and act.tool_args == exp.args_exact:
                    correct += 1
                elif exp.args_contain is not None:
                    all_match = all(
                        k in act.tool_args and (
                            v.lower() in act.tool_args[k].lower()
                            if isinstance(v, str) and isinstance(act.tool_args.get(k), str)
                            else act.tool_args.get(k) == v
                        )
                        for k, v in exp.args_contain.items()
                    )
                    if all_match:
                        correct += 1
                else:
                    correct += 1  # no args constraint means auto-pass
            return correct / len(matched)

        def _build_explanation(
            self, match_type: str, passed: bool, matched, missing, extra
        ) -> str:
            status = "PASSED" if passed else "FAILED"
            return (
                f"Trajectory evaluation ({match_type}): {status}. "
                f"Matched {len(matched)} expected steps. "
                f"Missing: {len(missing)}. Extra: {len(extra)}."
            )
    ```

### 4.4 Trajectory Evaluation in Context

Trajectory evaluation is tightly coupled with the **Observability Platform** (Subsystem 5). Every agent execution produces a trace with spans for each tool call. The Trajectory Evaluator consumes these spans to reconstruct the actual trajectory, then compares against the expected trajectory from the evalset.

For agents that use **Planning** (p. 101), the trajectory also validates that the plan was followed. If the agent deviated from its stated plan, this is flagged even if the final output is correct -- because plan adherence is a safety property monitored by the Guardrail System (Subsystem 4).

---

## 5. A/B Testing Framework

A/B testing (Level 4 of the pyramid) provides the definitive evidence that one agent version outperforms another under real production conditions. The framework implements experiment lifecycle management, traffic splitting, and statistical analysis.

### 5.1 Experiment Design

An experiment compares two or more agent **variants** across a set of metrics:

??? example "View JSON example"

    ```json
    {
      "experiment_id": "exp-uuid-v4",
      "name": "research-agent-v2.3-vs-v2.4",
      "status": "running",
      "created_at": "2026-02-20T14:00:00Z",
      "hypothesis": "v2.4 improves Completeness score by >= 5% without increasing latency by more than 10%",
      "variants": [
        {
          "variant_id": "control",
          "agent_version": "research-agent@2.3.1",
          "traffic_weight": 0.50
        },
        {
          "variant_id": "treatment",
          "agent_version": "research-agent@2.4.0",
          "traffic_weight": 0.50
        }
      ],
      "primary_metric": "judge_weighted_score",
      "secondary_metrics": ["latency_p95_ms", "token_usage_avg", "tool_accuracy"],
      "guardrails": {
        "max_latency_p95_ms": 10000,
        "min_safety_score": 0.95,
        "auto_stop_on_regression": true
      },
      "sample_size": {
        "min_per_variant": 500,
        "max_per_variant": 5000,
        "confidence_level": 0.95,
        "minimum_detectable_effect": 0.05
      },
      "duration": {
        "min_hours": 24,
        "max_hours": 168
      }
    }
    ```

### 5.2 Traffic Splitting

Traffic is split at the **Platform Orchestrator** (Level 0 of the hierarchy). When an experiment is active, the orchestrator assigns each incoming request to a variant using consistent hashing on the user/session ID. This ensures that a single user sees a consistent variant throughout the experiment.

```
User Request ──► Platform Orchestrator
                       │
                       ├── Hash(user_id) % 100 < 50? ──► Control (v2.3.1)
                       │
                       └── else ──────────────────────► Treatment (v2.4.0)
```

**Multi-arm experiments**: For more than two variants, the framework supports **Elo-based ranking** from the Exploration & Discovery pattern (p. 330-355). Each pairwise comparison updates Elo ratings, and the system converges on a ranking across all variants.

### 5.3 Statistical Analysis

The framework uses sequential testing to allow early stopping without inflating false-positive rates:

1. **Sequential Probability Ratio Test (SPRT)**: Checks after each batch whether the evidence is sufficient to declare a winner or loser, or whether more data is needed.
2. **Benjamini-Hochberg correction**: When multiple metrics are tested simultaneously, corrects for multiple comparisons.
3. **Practical significance**: Beyond statistical significance (p-value < 0.05), the framework also checks for practical significance (effect size > minimum detectable effect).

### 5.4 Pseudocode: A/B Test Framework

??? example "View Python pseudocode"

    ```python
    import math
    from dataclasses import dataclass
    from enum import Enum
    from typing import Optional


    class ExperimentStatus(Enum):
        DRAFT = "draft"
        RUNNING = "running"
        STOPPED_EARLY = "stopped_early"   # guardrail triggered
        COMPLETED = "completed"
        WINNER_DECLARED = "winner_declared"


    class VariantDecision(Enum):
        WINNING = "winning"
        LOSING = "losing"
        INCONCLUSIVE = "inconclusive"


    @dataclass
    class VariantMetrics:
        """Aggregated metrics for one variant in an experiment."""
        variant_id: str
        sample_count: int
        mean_score: float
        std_score: float
        p95_latency_ms: float
        mean_tokens: float
        tool_accuracy: float
        safety_score: float


    @dataclass
    class ExperimentResult:
        """Result of analyzing an experiment."""
        experiment_id: str
        status: ExperimentStatus
        variant_metrics: dict[str, VariantMetrics]
        primary_metric_p_value: Optional[float]
        primary_metric_effect_size: Optional[float]
        decision: VariantDecision
        recommended_variant: Optional[str]
        explanation: str
        elo_ratings: Optional[dict[str, float]]  # for multi-arm experiments (p. 330-355)


    class ABTestFramework:
        """
        A/B testing framework for comparing agent versions (p. 303, Level 4).

        Implements sequential testing with early stopping, guardrail-based
        automatic halt, and Elo-based ranking for multi-variant experiments.
        Integrates with the Goal Setting pattern (p. 185) to verify that
        SMART goal alignment is maintained across variants.
        """

        def __init__(
            self,
            confidence_level: float = 0.95,
            min_detectable_effect: float = 0.05,
            max_false_positive_rate: float = 0.05,
        ):
            self.confidence_level = confidence_level
            self.min_detectable_effect = min_detectable_effect
            self.alpha = max_false_positive_rate

        async def assign_variant(
            self,
            experiment_id: str,
            user_id: str,
        ) -> str:
            """
            Deterministically assign a user to a variant using consistent hashing.
            Ensures the same user always sees the same variant within an experiment.
            """
            experiment = await self._load_experiment(experiment_id)
            hash_value = consistent_hash(f"{experiment_id}:{user_id}")
            cumulative = 0.0
            for variant in experiment["variants"]:
                cumulative += variant["traffic_weight"]
                if hash_value < cumulative:
                    return variant["variant_id"]
            return experiment["variants"][-1]["variant_id"]

        async def record_observation(
            self,
            experiment_id: str,
            variant_id: str,
            metrics: dict[str, float],
        ):
            """
            Record a single observation (one request processed by one variant).
            After recording, check guardrails and sequential test boundaries.
            """
            await self._store_observation(experiment_id, variant_id, metrics)

            # Check safety guardrails -- auto-stop if violated
            experiment = await self._load_experiment(experiment_id)
            guardrails = experiment["guardrails"]

            if guardrails.get("auto_stop_on_regression"):
                variant_metrics = await self._aggregate_metrics(experiment_id, variant_id)
                if variant_metrics.safety_score < guardrails.get("min_safety_score", 0.0):
                    await self._stop_experiment(
                        experiment_id,
                        reason=f"Safety score {variant_metrics.safety_score:.3f} "
                               f"below threshold {guardrails['min_safety_score']}",
                    )
                    return
                if variant_metrics.p95_latency_ms > guardrails.get("max_latency_p95_ms", float("inf")):
                    await self._stop_experiment(
                        experiment_id,
                        reason=f"P95 latency {variant_metrics.p95_latency_ms:.0f}ms "
                               f"exceeds threshold {guardrails['max_latency_p95_ms']}ms",
                    )
                    return

        async def analyze(self, experiment_id: str) -> ExperimentResult:
            """
            Analyze current experiment state. Uses sequential probability ratio
            test (SPRT) to determine if a winner can be declared.
            """
            experiment = await self._load_experiment(experiment_id)
            variants = experiment["variants"]
            all_metrics = {}

            for variant in variants:
                vid = variant["variant_id"]
                all_metrics[vid] = await self._aggregate_metrics(experiment_id, vid)

            # For two-variant experiments: Welch's t-test with SPRT wrapper
            if len(variants) == 2:
                control = all_metrics[variants[0]["variant_id"]]
                treatment = all_metrics[variants[1]["variant_id"]]

                p_value, effect_size = self._welch_t_test(control, treatment)

                if (
                    control.sample_count >= experiment["sample_size"]["min_per_variant"]
                    and treatment.sample_count >= experiment["sample_size"]["min_per_variant"]
                ):
                    if p_value < self.alpha and effect_size > self.min_detectable_effect:
                        winner = (
                            variants[1]["variant_id"]
                            if treatment.mean_score > control.mean_score
                            else variants[0]["variant_id"]
                        )
                        decision = VariantDecision.WINNING
                    elif p_value < self.alpha and effect_size <= self.min_detectable_effect:
                        decision = VariantDecision.INCONCLUSIVE
                        winner = None
                    else:
                        decision = VariantDecision.INCONCLUSIVE
                        winner = None
                else:
                    decision = VariantDecision.INCONCLUSIVE
                    winner = None
                    p_value = None
                    effect_size = None

                return ExperimentResult(
                    experiment_id=experiment_id,
                    status=ExperimentStatus.RUNNING if decision == VariantDecision.INCONCLUSIVE
                           else ExperimentStatus.WINNER_DECLARED,
                    variant_metrics=all_metrics,
                    primary_metric_p_value=p_value,
                    primary_metric_effect_size=effect_size,
                    decision=decision,
                    recommended_variant=winner,
                    explanation=self._build_analysis_explanation(
                        control, treatment, p_value, effect_size, decision
                    ),
                    elo_ratings=None,
                )

            # For multi-variant experiments: Elo-based ranking (p. 330-355)
            else:
                elo_ratings = await self._compute_elo_ratings(experiment_id, all_metrics)
                best_variant = max(elo_ratings, key=elo_ratings.get)

                return ExperimentResult(
                    experiment_id=experiment_id,
                    status=ExperimentStatus.RUNNING,
                    variant_metrics=all_metrics,
                    primary_metric_p_value=None,
                    primary_metric_effect_size=None,
                    decision=VariantDecision.INCONCLUSIVE,
                    recommended_variant=best_variant,
                    explanation=f"Elo rankings: {elo_ratings}. Leading variant: {best_variant}.",
                    elo_ratings=elo_ratings,
                )

        def _welch_t_test(
            self,
            control: VariantMetrics,
            treatment: VariantMetrics,
        ) -> tuple[float, float]:
            """Welch's t-test for unequal variances."""
            n1, n2 = control.sample_count, treatment.sample_count
            m1, m2 = control.mean_score, treatment.mean_score
            s1, s2 = control.std_score, treatment.std_score

            if n1 < 2 or n2 < 2:
                return 1.0, 0.0

            se = math.sqrt((s1**2 / n1) + (s2**2 / n2))
            if se == 0:
                return 1.0, 0.0

            t_stat = (m2 - m1) / se
            # Welch-Satterthwaite degrees of freedom
            df_num = ((s1**2 / n1) + (s2**2 / n2)) ** 2
            df_den = ((s1**2 / n1)**2 / (n1 - 1)) + ((s2**2 / n2)**2 / (n2 - 1))
            df = df_num / df_den if df_den > 0 else 1

            p_value = t_distribution_two_tailed_p(t_stat, df)  # scipy.stats.t.sf
            effect_size = abs(m2 - m1) / math.sqrt((s1**2 + s2**2) / 2)  # Cohen's d

            return p_value, effect_size

        async def _compute_elo_ratings(
            self,
            experiment_id: str,
            all_metrics: dict[str, VariantMetrics],
        ) -> dict[str, float]:
            """
            Compute Elo ratings from pairwise comparisons (p. 330-355).

            Each observation is compared pairwise between variants that served
            similar inputs. The Elo update follows the standard formula with
            K=32 for initial convergence speed.
            """
            K = 32
            ratings = {vid: 1500.0 for vid in all_metrics}

            comparisons = await self._load_pairwise_comparisons(experiment_id)
            for comp in comparisons:
                ra = ratings[comp["variant_a"]]
                rb = ratings[comp["variant_b"]]
                ea = 1.0 / (1.0 + 10 ** ((rb - ra) / 400))
                eb = 1.0 / (1.0 + 10 ** ((ra - rb) / 400))

                # sa = 1 if a won, 0 if b won, 0.5 if tie
                sa = comp["score_a_wins"]
                sb = 1.0 - sa

                ratings[comp["variant_a"]] = ra + K * (sa - ea)
                ratings[comp["variant_b"]] = rb + K * (sb - eb)

            return ratings

        def _build_analysis_explanation(
            self, control, treatment, p_value, effect_size, decision
        ) -> str:
            return (
                f"Control: n={control.sample_count}, mean={control.mean_score:.4f}, "
                f"std={control.std_score:.4f}. "
                f"Treatment: n={treatment.sample_count}, mean={treatment.mean_score:.4f}, "
                f"std={treatment.std_score:.4f}. "
                f"p-value={p_value}, effect_size={effect_size}, decision={decision.value}."
            )
    ```

### 5.5 Guardrail Integration

Experiments have safety guardrails that can halt them automatically:

- **Safety floor**: If any variant's safety score drops below a threshold, the experiment is stopped and the offending variant is disabled. This integrates with the Guardrail System (Subsystem 4).
- **Latency ceiling**: If p95 latency exceeds the configured maximum, the experiment is paused for investigation.
- **Cost cap**: If cumulative experiment cost exceeds budget, the experiment is stopped. This integrates with Cost & Resource Manager (Subsystem 9).
- **Regression detection**: If the treatment variant is statistically significantly _worse_ than control on the primary metric, early stopping is triggered.

---

## 6. Benchmark Suite

The Benchmark Suite provides standardized and custom benchmarks for comparing agents against industry baselines and across versions.

### 6.1 Standard Benchmarks

The framework ships with adapters for widely-used benchmarks:

| Benchmark | Domain | Metrics |
|---|---|---|
| **HumanEval / MBPP** | Code generation | pass@k, functional correctness |
| **MMLU** | General knowledge | Accuracy per subject |
| **GSM8K** | Mathematical reasoning | Exact-match accuracy |
| **TruthfulQA** | Hallucination resistance | Truthfulness + informativeness |
| **ToolBench** | Tool use | Tool selection accuracy, task completion |
| **AgentBench** | Multi-step agent tasks | Success rate, efficiency |
| **MT-Bench** | Multi-turn conversation | LLM-as-Judge score |

### 6.2 Custom Benchmarks

Teams can define domain-specific benchmarks that follow the evalset format but are designated as benchmarks (immutable reference sets):

??? example "View JSON example"

    ```json
    {
      "benchmark_id": "bench-uuid",
      "name": "financial-research-benchmark-v1",
      "type": "custom",
      "immutable": true,
      "entries": [ "..." ],
      "baseline_results": {
        "research-agent@2.0.0": {
          "accuracy": 0.78,
          "latency_p95_ms": 5200,
          "judge_weighted_score": 0.72
        }
      }
    }
    ```

### 6.3 Leaderboard

The leaderboard tracks agent performance over time, across benchmarks:

```
┌──────────────────────────────────────────────────────────────────────┐
│                  AgentForge Leaderboard                              │
├──────┬───────────────────┬──────────┬──────────┬─────────┬──────────┤
│ Rank │ Agent Version     │ Accuracy │ Judge    │ Latency │ Cost/req │
│      │                   │          │ Score    │ P95 (s) │ (USD)    │
├──────┼───────────────────┼──────────┼──────────┼─────────┼──────────┤
│  1   │ research@2.4.0    │  0.91    │  0.88    │  3.2    │  0.0052  │
│  2   │ research@2.3.1    │  0.87    │  0.84    │  2.9    │  0.0048  │
│  3   │ research@2.2.0    │  0.83    │  0.81    │  3.5    │  0.0061  │
│  4   │ research@2.1.0    │  0.80    │  0.78    │  4.1    │  0.0070  │
└──────┴───────────────────┴──────────┴──────────┴─────────┴──────────┘
```

Leaderboard rankings use **Elo-based scoring** (p. 330-355) when comparing agents that were evaluated on different subsets or different benchmarks, enabling fair cross-benchmark comparison.

---

## 7. Evaluation Pipeline

### 7.1 Pipeline Architecture

The evaluation pipeline is the orchestrator that ties together all evaluation components. It is triggered by events and runs evaluations as asynchronous jobs.

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Evaluation Pipeline                             │
│                                                                      │
│  Triggers:                                                           │
│  ┌───────────────┐  ┌──────────────┐  ┌───────────────────────┐     │
│  │ Prompt version │  │ Scheduled    │  │ Production trace      │     │
│  │ promotion      │  │ cron (nightly│  │ sampled for async     │     │
│  │ (eval gate)    │  │  benchmarks) │  │ quality check         │     │
│  └───────┬───────┘  └──────┬───────┘  └───────────┬───────────┘     │
│          │                 │                      │                  │
│          └─────────────────┼──────────────────────┘                  │
│                            ▼                                         │
│                  ┌─────────────────┐                                 │
│                  │  Eval Job Queue │  (Redis Streams / NATS)         │
│                  │  (prioritized)  │                                 │
│                  └────────┬────────┘                                 │
│                           ▼                                          │
│              ┌────────────────────────┐                              │
│              │   Eval Worker Pool     │                              │
│              │                        │                              │
│              │  ┌──────────────────┐  │                              │
│              │  │ Level 1: Metrics │  │  Always runs first           │
│              │  │ (fast, cheap)    │  │                              │
│              │  └────────┬─────────┘  │                              │
│              │           ▼            │                              │
│              │  ┌──────────────────┐  │                              │
│              │  │ Level 2: Evalset │  │  Regression check            │
│              │  │ (deterministic)  │  │                              │
│              │  └────────┬─────────┘  │                              │
│              │           ▼            │                              │
│              │  ┌──────────────────┐  │                              │
│              │  │ Level 3: Judge   │  │  LLM-as-Judge scoring        │
│              │  │ (LLM calls)     │  │                              │
│              │  └────────┬─────────┘  │                              │
│              │           ▼            │                              │
│              │  ┌──────────────────┐  │                              │
│              │  │ Level 4: A/B     │  │  Only for running            │
│              │  │ (experiment)     │  │  experiments                  │
│              │  └──────────────────┘  │                              │
│              └────────────────────────┘                              │
│                           │                                          │
│                           ▼                                          │
│              ┌────────────────────────┐                              │
│              │  Results Store         │  (PostgreSQL + ClickHouse)   │
│              │  + Event Emission      │  → Observability Platform    │
│              └────────────────────────┘                              │
└──────────────────────────────────────────────────────────────────────┘
```

### 7.2 Trigger Types

| Trigger | Description | Pipeline Levels |
|---|---|---|
| **Prompt Promotion** | A new prompt version moves to `Staged` in the Prompt Registry | Levels 1-3 (must all pass for promotion to `Production`) |
| **Scheduled Benchmark** | Nightly or weekly full benchmark run | Levels 1-3 against benchmark suite |
| **Production Sampling** | Random sample of production traces for ongoing quality monitoring | Levels 1, 3 (lightweight) |
| **A/B Experiment** | Active experiment routing traffic to variants | Levels 1-4 |
| **Manual Trigger** | Developer or QA initiates an evaluation run | Configurable (any combination of levels) |

### 7.3 Execution Semantics

- **Fail-fast**: If Level 1 metrics show a catastrophic regression (e.g., accuracy below 50%), higher levels are skipped and the evaluation is marked as `FAILED`.
- **Parallelism**: Evalset entries within a level are evaluated in parallel (configurable concurrency limit to respect rate limits and cost budgets).
- **Idempotency**: Each eval run has a unique ID. Re-running the same evalset + agent version + configuration produces a new run (not overwriting the old one), but results are expected to be deterministic at Levels 1-2.
- **Result immutability**: Once an eval run completes, its results are immutable. They can be annotated (e.g., "false positive") but never modified.

### 7.4 Result Storage Schema

??? example "View SQL schema"

    ```sql
    -- Core evaluation runs
    CREATE TABLE eval_runs (
        run_id          UUID PRIMARY KEY,
        experiment_id   UUID REFERENCES experiments(experiment_id),
        agent_id        VARCHAR NOT NULL,
        agent_version   VARCHAR NOT NULL,
        evalset_id      UUID NOT NULL,
        evalset_version VARCHAR NOT NULL,
        trigger_type    VARCHAR NOT NULL,  -- 'promotion', 'scheduled', 'sampling', 'ab_test', 'manual'
        status          VARCHAR NOT NULL,  -- 'pending', 'running', 'completed', 'failed'
        started_at      TIMESTAMPTZ NOT NULL,
        completed_at    TIMESTAMPTZ,
        created_by      VARCHAR NOT NULL
    );

    -- Per-entry results
    CREATE TABLE eval_entry_results (
        result_id       UUID PRIMARY KEY,
        run_id          UUID REFERENCES eval_runs(run_id),
        entry_id        VARCHAR NOT NULL,
        -- Level 1: Core metrics
        accuracy_score  FLOAT,
        latency_ms      INT,
        token_count     INT,
        tool_accuracy   FLOAT,
        cost_usd        FLOAT,
        -- Level 2: Evalset regression
        output_match    BOOLEAN,
        trajectory_match BOOLEAN,
        trajectory_type VARCHAR,  -- 'exact_order', 'in_order', 'any_order', 'single_tool'
        -- Level 3: LLM-as-Judge
        judge_verdict   JSONB,  -- full JudgeVerdict serialized
        judge_weighted_score FLOAT,
        -- Metadata
        raw_output      TEXT,
        raw_trajectory  JSONB,
        evaluated_at    TIMESTAMPTZ NOT NULL
    );

    -- Aggregate run summaries
    CREATE TABLE eval_run_summaries (
        run_id              UUID PRIMARY KEY REFERENCES eval_runs(run_id),
        total_entries       INT NOT NULL,
        passed_entries      INT NOT NULL,
        accuracy_mean       FLOAT,
        accuracy_std        FLOAT,
        judge_score_mean    FLOAT,
        judge_score_std     FLOAT,
        latency_p50_ms      INT,
        latency_p95_ms      INT,
        latency_p99_ms      INT,
        token_usage_mean    FLOAT,
        tool_accuracy_mean  FLOAT,
        cost_total_usd      FLOAT,
        pass_rate           FLOAT,  -- passed_entries / total_entries
        overall_verdict     VARCHAR NOT NULL  -- 'pass', 'fail', 'warning'
    );
    ```

---

## 8. Integration with Prompt Registry

The Evaluation Framework serves as the **quality gate** in the Prompt Registry's promotion lifecycle (Section 3.6 of the System Overview). No prompt version moves from `Staged` to `Production` without passing all configured evaluation levels.

### 8.1 Eval Gate Protocol

```
Prompt Registry                    Evaluation Framework
     │                                     │
     │  1. promote(prompt_id, version,     │
     │     stage="staged")                 │
     │ ──────────────────────────────────► │
     │                                     │
     │  2. Create eval_run for             │
     │     agent + evalset                 │
     │                                     │
     │  3. Run Levels 1-3                  │
     │     (metrics, evalset, judge)       │
     │                                     │
     │  4. Return EvalGateResult           │
     │ ◄─────────────────────────────────  │
     │                                     │
     │  If passed:                         │
     │    promote to "production"          │
     │  If failed:                         │
     │    reject with detailed report      │
     │  If warning:                        │
     │    queue for human review (HITL)    │
```

### 8.2 Gate Configuration

Each agent can configure its eval gate policy:

??? example "View JSON example"

    ```json
    {
      "agent_id": "research-agent",
      "eval_gate_policy": {
        "required_levels": [1, 2, 3],
        "level_1_criteria": {
          "min_accuracy": 0.85,
          "max_latency_p95_ms": 8000,
          "max_regression_pct": 5.0
        },
        "level_2_criteria": {
          "min_pass_rate": 0.90,
          "min_tool_accuracy": 0.85
        },
        "level_3_criteria": {
          "min_judge_weighted_score": 0.75,
          "max_regression_pct": 3.0
        },
        "on_warning": "hitl_review",
        "on_failure": "reject_and_notify"
      }
    }
    ```

The `max_regression_pct` fields compare the new version against the **currently-deployed version** on the same evalset, ensuring that improvements are always relative to the established baseline (p. 305).

### 8.3 Promotion with RLVR Feedback

When a prompt version passes the eval gate and is promoted, the evaluation scores are fed back to the Learning & Adaptation subsystem as a **verifiable reward** signal (RLVR, p. 168). This closes the optimization loop:

```
Prompt Optimizer ──► New Prompt Draft ──► Eval Gate ──► Score ──┐
      ▲                                                          │
      └──── Learning signal (RLVR reward = eval score) ◄────────┘
```

This enables the system to learn which types of prompt modifications lead to improved evaluation scores, aligning with the SMART goals framework (p. 185) where eval criteria serve as the "Measurable" component.

---

## 9. API Surface

### 9.1 Evalset Management

??? example "View API example"

    ```
    POST   /api/v1/evalsets                          Create a new evalset
    GET    /api/v1/evalsets                          List all evalsets (filterable)
    GET    /api/v1/evalsets/{evalset_id}             Get evalset by ID
    GET    /api/v1/evalsets/{evalset_id}/versions    List all versions
    PUT    /api/v1/evalsets/{evalset_id}/entries      Add/update entries (creates new version)
    DELETE /api/v1/evalsets/{evalset_id}/entries/{id} Remove an entry (creates new version)
    POST   /api/v1/evalsets/{evalset_id}/refresh     Trigger production-based refresh
    ```

### 9.2 Evaluation Runs

??? example "View API example"

    ```
    POST   /api/v1/eval-runs                         Trigger a new evaluation run
    GET    /api/v1/eval-runs                         List evaluation runs (filterable)
    GET    /api/v1/eval-runs/{run_id}                Get run details and summary
    GET    /api/v1/eval-runs/{run_id}/entries         Get per-entry results (paginated)
    GET    /api/v1/eval-runs/{run_id}/entries/{id}    Get single entry result with full detail
    POST   /api/v1/eval-runs/{run_id}/cancel         Cancel a running evaluation
    ```

### 9.3 LLM-as-Judge

??? example "View API example"

    ```
    POST   /api/v1/judge/evaluate                    Run a single judge evaluation
    POST   /api/v1/judge/evaluate-batch               Run judge evaluation over a batch
    GET    /api/v1/judge/rubrics                      List available rubrics
    POST   /api/v1/judge/rubrics                      Create a custom rubric
    GET    /api/v1/judge/rubrics/{rubric_id}          Get rubric details
    PUT    /api/v1/judge/rubrics/{rubric_id}          Update a rubric
    ```

### 9.4 Experiments (A/B Testing)

??? example "View API example"

    ```
    POST   /api/v1/experiments                       Create a new experiment
    GET    /api/v1/experiments                       List experiments (filterable by status)
    GET    /api/v1/experiments/{exp_id}              Get experiment details
    PUT    /api/v1/experiments/{exp_id}/status        Update experiment status (start/stop)
    GET    /api/v1/experiments/{exp_id}/analysis      Get current statistical analysis
    GET    /api/v1/experiments/{exp_id}/variants      Get per-variant metrics
    POST   /api/v1/experiments/{exp_id}/declare-winner Manually declare a winner
    ```

### 9.5 Benchmarks & Leaderboard

??? example "View API example"

    ```
    GET    /api/v1/benchmarks                        List available benchmarks
    POST   /api/v1/benchmarks                        Register a custom benchmark
    POST   /api/v1/benchmarks/{bench_id}/run          Trigger a benchmark run
    GET    /api/v1/benchmarks/{bench_id}/results       Get results for a benchmark
    GET    /api/v1/leaderboard                       Get global leaderboard
    GET    /api/v1/leaderboard/{agent_id}            Get leaderboard history for an agent
    ```

### 9.6 Eval Gates (Prompt Registry Integration)

```
POST   /api/v1/eval-gates/check                  Run eval gate check for a prompt version
GET    /api/v1/eval-gates/{gate_id}              Get gate result
GET    /api/v1/eval-gates/policies/{agent_id}     Get eval gate policy for an agent
PUT    /api/v1/eval-gates/policies/{agent_id}     Update eval gate policy
```

---

## 10. Failure Modes & Mitigations

| # | Failure Mode | Impact | Probability | Mitigation |
|---|---|---|---|---|
| F1 | **Judge model unavailable** | Level 3 evaluations cannot run | Medium | Fallback judge model list; retry with exponential backoff; cache recent judge results for comparison baseline |
| F2 | **Judge model produces invalid JSON** | Single evaluation entry fails | Low | Structured output enforcement; retry up to `max_retries`; fallback to regex-based score extraction |
| F3 | **Evalset drift from production** | Eval results no longer representative of real quality | High (over time) | Automated staleness detection; scheduled refresh from production sampling; alert on distribution drift |
| F4 | **A/B experiment bias** | Traffic split not truly random | Low | Consistent hashing verified with chi-squared uniformity test; monitor variant assignment distribution |
| F5 | **Eval pipeline backpressure** | Eval jobs queue grows unboundedly | Medium | Priority queue with TTL; shed low-priority sampling jobs when queue depth exceeds threshold; scale worker pool horizontally |
| F6 | **False positive eval gate** | Bad prompt promoted to production | Low | Multi-level pyramid redundancy; require passing at all configured levels; HITL review for borderline cases |
| F7 | **False negative eval gate** | Good prompt blocked from promotion | Medium | Warning mode with HITL override; detailed failure reports for human review; allow manual promotion with audit trail |
| F8 | **Cost overrun from judge calls** | Evaluation budget exhausted | Medium | Per-run cost budget; judge call sampling for large evalsets; cheaper judge model for pre-screening |
| F9 | **Determinism failure** | Same evalset + agent produces different results | Medium | Fix temperature to 0.0 for eval runs; seed random number generators; log and flag non-deterministic entries |
| F10 | **Circular dependency** | Eval framework depends on subsystems it evaluates | Low | Eval framework has its own dedicated LLM client and tool access, independent of the agents it evaluates |

### Cascading Failure Protection

```
Judge Model Down (F1)
    │
    ├── Level 3 skipped, eval continues at Levels 1-2
    │   (degraded mode, not blocked)
    │
    ├── Alert emitted to Observability Platform
    │
    └── If eval gate requires Level 3:
        └── Gate returns "pending" (not "fail")
            └── Retry scheduled with backoff
            └── After 3 retries: escalate to HITL (p. 207)
```

---

## 11. Instrumentation

The Evaluation Framework instruments itself using the same Observability Platform it helps assess. All instrumentation follows the OpenTelemetry standard.

### 11.1 Traces

Every evaluation run produces a trace with the following span hierarchy:

```
Trace: eval_run:{run_id}
├── Span: eval_pipeline
│   ├── attributes:
│   │   ├── run_id, agent_id, agent_version
│   │   ├── evalset_id, evalset_version
│   │   ├── trigger_type, levels_configured
│   │   └── entry_count
│   │
│   ├── Span: level_1_metrics (per entry, parallelized)
│   │   ├── Span: entry:{entry_id}:metrics
│   │   │   └── accuracy, latency, tokens, tool_accuracy, cost
│   │   └── ...
│   │
│   ├── Span: level_2_evalset (per entry, parallelized)
│   │   ├── Span: entry:{entry_id}:output_match
│   │   ├── Span: entry:{entry_id}:trajectory_eval
│   │   │   └── match_type, passed, tool_accuracy, args_accuracy
│   │   └── ...
│   │
│   ├── Span: level_3_judge (per entry, parallelized with concurrency limit)
│   │   ├── Span: entry:{entry_id}:judge_call
│   │   │   ├── judge_model, judge_latency_ms, judge_tokens
│   │   │   └── dimension_scores, weighted_score
│   │   └── ...
│   │
│   └── Span: aggregation
│       └── pass_rate, overall_verdict, cost_total
│
└── Span: eval_gate_decision (if triggered by promotion)
    └── gate_result: pass | fail | warning
```

### 11.2 Metrics

The following metrics are exported to the Observability Platform, implementing the LLMInteractionMonitor pattern (p. 310):

| Metric | Type | Labels | Description |
|---|---|---|---|
| `eval.runs.total` | Counter | `agent_id`, `trigger_type`, `status` | Total evaluation runs |
| `eval.runs.duration_seconds` | Histogram | `agent_id`, `trigger_type` | Eval run duration |
| `eval.entries.processed` | Counter | `agent_id`, `level` | Entries processed per level |
| `eval.entries.pass_rate` | Gauge | `agent_id`, `evalset_id` | Current pass rate |
| `eval.judge.calls.total` | Counter | `judge_model`, `agent_id` | Judge LLM calls |
| `eval.judge.latency_seconds` | Histogram | `judge_model` | Judge call latency |
| `eval.judge.tokens.total` | Counter | `judge_model`, `direction` | Judge token usage |
| `eval.judge.weighted_score` | Histogram | `agent_id`, `rubric_id` | Judge weighted score distribution |
| `eval.trajectory.accuracy` | Histogram | `agent_id`, `match_type` | Trajectory accuracy distribution |
| `eval.gate.decisions` | Counter | `agent_id`, `decision` | Eval gate decisions (pass/fail/warning) |
| `eval.experiments.active` | Gauge | | Number of active A/B experiments |
| `eval.experiments.observations` | Counter | `experiment_id`, `variant_id` | Observations per variant |
| `eval.pipeline.queue_depth` | Gauge | `priority` | Eval job queue depth |
| `eval.pipeline.cost_usd` | Counter | `agent_id`, `level` | Cumulative evaluation cost |

### 11.3 Alerts

| Alert | Condition | Severity | Action |
|---|---|---|---|
| `EvalPassRateDrop` | Pass rate drops > 10% from 7-day moving average | Critical | Page on-call; auto-rollback if enabled |
| `EvalJudgeScoreDrift` | Mean judge score drifts > 0.1 from baseline | Warning | Notify agent owner |
| `EvalPipelineBacklog` | Queue depth > 1000 for > 15 minutes | Warning | Scale eval workers |
| `EvalGateTimeout` | Gate check not completed within 30 minutes | Critical | Escalate to HITL |
| `ExperimentSafetyViolation` | Variant safety score below threshold | Critical | Auto-stop experiment |
| `EvalCostBudgetExhausted` | Monthly eval cost exceeds budget | Warning | Switch to cheaper judge model; reduce sampling rate |

### 11.4 Dashboards

The framework provides pre-built Grafana dashboards:

1. **Eval Overview**: Run counts, pass rates, queue depth, cost over time.
2. **Agent Quality Trends**: Per-agent accuracy, judge scores, and trajectory accuracy over time. Regression alerts highlighted.
3. **LLM-as-Judge Analytics**: Judge score distributions, per-dimension breakdowns, inter-judge agreement, bias indicators.
4. **A/B Experiment Monitor**: Active experiments, variant metrics comparison, statistical significance progression, Elo rankings.
5. **Leaderboard**: Cross-agent benchmark comparison with historical trend lines.

---

*This document covers Subsystem #8 of the AgentForge platform. For the system-wide architecture and subsystem dependencies, see [00-system-overview.md](./00-system-overview.md).*
