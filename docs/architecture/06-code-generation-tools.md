# 06 -- Code Generation Tools

## 1. Overview & Responsibility

The **Code Generation Tools** subsystem provides agents within the AgentForge platform with the ability to produce, execute, review, and iteratively refine code. It is the infrastructure that turns a natural-language specification into tested, reviewed, deployable code -- all within a controlled, observable, and secure environment.

Core responsibilities:

| Capability | Description | Primary Pattern |
|---|---|---|
| **Code Generation** | Transform natural-language specifications into source code | Tool Use (p. 81-100) |
| **Sandboxed Execution** | Run generated code inside a least-privilege isolation boundary | Guardrails/Safety (p. 285-301) |
| **Automated Code Review** | Evaluate generated code for correctness, security, and style | Reflection (p. 61-68) |
| **Test Execution** | Run tests against generated code and interpret results | Learning & Adaptation (p. 163-172) |
| **Iterative Refinement** | Reflection loop: generate, critique, revise until quality threshold is met | Reflection (p. 65), SICA (p. 169) |

This subsystem is classified as **high-risk** because it produces and executes arbitrary code. Every operation is subject to the platform's defense-in-depth security model (see System Overview, Section 3.4), and code execution is always treated as an irreversible tool invocation (p. 91) requiring additional gating.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Code Generation Tools Subsystem                    │
│                                                                      │
│  ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐ │
│  │  Code      │──>│  Code      │──>│  Test      │──>│  Code      │ │
│  │  Generator │   │  Reviewer  │   │  Runner    │   │  Executor  │ │
│  │  (LLM)    │   │  (LLM)    │   │  (Sandbox) │   │  (Sandbox) │ │
│  └─────┬──────┘   └─────┬──────┘   └─────┬──────┘   └─────┬──────┘ │
│        │                │                │                │         │
│        └────────────────┴────────────────┴────────────────┘         │
│                              │                                       │
│                    ┌─────────┴──────────┐                            │
│                    │  Reflection Loop   │                            │
│                    │  Controller        │                            │
│                    └────────────────────┘                            │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  MCP Server (FastMCP)                                        │   │
│  │  Tools: generate_code | execute_code | review_code |         │   │
│  │         run_tests | refine_code                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Sandbox Manager (Firecracker / gVisor)                      │   │
│  │  Resource Limits | Network Isolation | Filesystem Jailing    │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. Code Generation Pipeline

The pipeline follows a linear-then-iterative flow: **Prompt --> Generate --> Review --> Test --> Iterate**. Each stage is a discrete tool invocation, producing structured output that feeds the next stage as an observation (p. 90).

### 2.1 Pipeline Stages

```
 ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
 │  Prompt  │────>│ Generate │────>│  Review  │────>│   Test   │
 │ (User    │     │ (LLM)   │     │ (Critic) │     │ (Sandbox)│
 │  Spec)   │     │         │     │          │     │          │
 └──────────┘     └──────────┘     └────┬─────┘     └────┬─────┘
                                        │                │
                                        │   ┌────────────┘
                                        │   │
                                        ▼   ▼
                                   ┌──────────┐
                                   │  Iterate │  (Reflection loop,
                                   │  / Refine│   max N iterations)
                                   └────┬─────┘
                                        │
                                        ▼
                                   ┌──────────┐
                                   │  Output  │
                                   │ (Approved│
                                   │   Code)  │
                                   └──────────┘
```

**Stage 1 -- Prompt Composition**: The user's natural-language specification is enriched with context: target language, framework constraints, coding style guidelines, and any existing code context. This follows the prompt chaining principle (p. 1) where each stage's output becomes the next stage's input.

**Stage 2 -- Code Generation**: The LLM produces candidate code. The generator tool returns structured output conforming to a JSON Schema (p. 85) containing the code, language metadata, and a confidence self-assessment.

**Stage 3 -- Automated Review**: A critic agent (distinct from the generator) evaluates the code against correctness, security, and style criteria. This is the Generator-Critic pattern (p. 65).

**Stage 4 -- Test Execution**: If the review passes, tests are executed inside the sandbox. Test results are captured as structured observations.

**Stage 5 -- Iterative Refinement**: If tests fail or the review identifies issues, the loop returns to Stage 2 with feedback appended to the prompt context. This continues until either (a) all checks pass, or (b) the maximum iteration count is reached (p. 67).

### 2.2 Pipeline Pseudocode

```python
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from opentelemetry import trace

tracer = trace.get_tracer("agentforge.codegen")


class PipelineStatus(Enum):
    SUCCESS = "success"
    REVIEW_FAILED = "review_failed"
    TESTS_FAILED = "tests_failed"
    MAX_ITERATIONS = "max_iterations_reached"
    EXECUTION_BLOCKED = "execution_blocked"


@dataclass
class CodeSpec:
    """Natural-language code specification from the user."""
    description: str
    language: str
    framework: Optional[str] = None
    constraints: list[str] = field(default_factory=list)
    test_requirements: list[str] = field(default_factory=list)
    existing_context: Optional[str] = None


@dataclass
class GeneratedCode:
    """Structured output from the code generator."""
    code: str
    language: str
    explanation: str
    confidence: float  # 0.0 - 1.0
    imports: list[str] = field(default_factory=list)


@dataclass
class ReviewResult:
    """Structured output from the code reviewer (Critic)."""
    approved: bool
    correctness_score: float  # 0.0 - 1.0
    security_score: float
    style_score: float
    issues: list[dict]  # [{"severity": "high", "description": "...", "line": 12}]
    suggestions: list[str]


@dataclass
class TestResult:
    """Structured output from the test runner."""
    passed: bool
    total_tests: int
    passed_tests: int
    failed_tests: int
    failures: list[dict]  # [{"test_name": "...", "error": "...", "traceback": "..."}]
    execution_time_ms: float
    stdout: str
    stderr: str


@dataclass
class PipelineResult:
    """Final output of the code generation pipeline."""
    status: PipelineStatus
    code: Optional[GeneratedCode]
    review: Optional[ReviewResult]
    test_result: Optional[TestResult]
    iterations: int
    trace_id: str


class CodeGenerationPipeline:
    """
    Orchestrates the full code generation lifecycle:
    Prompt -> Generate -> Review -> Test -> Iterate.

    Implements the Generator-Critic reflection pattern (p. 65)
    with a maximum iteration bound (p. 67).
    """

    def __init__(
        self,
        generator: "CodeGeneratorAgent",
        reviewer: "CodeReviewAgent",
        test_runner: "TestRunner",
        sandbox: "SandboxManager",
        max_iterations: int = 5,
        review_threshold: float = 0.7,
    ):
        self.generator = generator
        self.reviewer = reviewer
        self.test_runner = test_runner
        self.sandbox = sandbox
        self.max_iterations = max_iterations
        self.review_threshold = review_threshold

    async def run(self, spec: CodeSpec) -> PipelineResult:
        """
        Execute the full pipeline with reflection loop.

        The reflection loop (p. 65) alternates between:
          - Generator: produces/refines code
          - Critic: reviews code for correctness, security, style
          - Test runner: validates code against test suite

        Loop terminates when:
          1. Review passes AND tests pass -> SUCCESS
          2. max_iterations reached -> MAX_ITERATIONS (p. 67)
        """
        trace_id = str(uuid.uuid4())
        feedback_history: list[str] = []

        with tracer.start_as_current_span("codegen.pipeline", attributes={
            "trace_id": trace_id,
            "spec.language": spec.language,
            "max_iterations": self.max_iterations,
        }) as span:

            for iteration in range(1, self.max_iterations + 1):
                span.set_attribute("current_iteration", iteration)

                # --- Stage 1-2: Generate code ---
                with tracer.start_as_current_span("codegen.generate"):
                    generated = await self.generator.generate(
                        spec=spec,
                        feedback=feedback_history,
                        iteration=iteration,
                    )

                # --- Stage 3: Review code (Critic, p. 65) ---
                with tracer.start_as_current_span("codegen.review"):
                    review = await self.reviewer.review(
                        code=generated,
                        spec=spec,
                    )

                if not review.approved or review.correctness_score < self.review_threshold:
                    # Critic rejected: feed issues back to generator
                    feedback_history.append(
                        f"[Iteration {iteration}] Review failed: "
                        + "; ".join(issue["description"] for issue in review.issues)
                    )
                    span.add_event("review_rejected", {
                        "iteration": iteration,
                        "correctness_score": review.correctness_score,
                        "issue_count": len(review.issues),
                    })
                    continue  # Loop back to generation

                # --- Stage 4: Run tests in sandbox ---
                with tracer.start_as_current_span("codegen.test"):
                    test_result = await self.test_runner.run(
                        code=generated,
                        spec=spec,
                        sandbox=self.sandbox,
                    )

                if test_result.passed:
                    span.set_attribute("result", "success")
                    return PipelineResult(
                        status=PipelineStatus.SUCCESS,
                        code=generated,
                        review=review,
                        test_result=test_result,
                        iterations=iteration,
                        trace_id=trace_id,
                    )
                else:
                    # Tests failed: feed failures back to generator
                    # (SICA pattern: test-driven feedback, p. 169)
                    feedback_history.append(
                        f"[Iteration {iteration}] Test failures: "
                        + "; ".join(
                            f"{f['test_name']}: {f['error']}"
                            for f in test_result.failures
                        )
                    )
                    span.add_event("tests_failed", {
                        "iteration": iteration,
                        "failed_tests": test_result.failed_tests,
                    })

            # Max iterations reached (p. 67)
            span.set_attribute("result", "max_iterations_reached")
            return PipelineResult(
                status=PipelineStatus.MAX_ITERATIONS,
                code=generated,
                review=review,
                test_result=test_result,
                iterations=self.max_iterations,
                trace_id=trace_id,
            )
```

---

## 3. Sandbox Architecture

All code execution occurs inside a sandbox that enforces the **Least Privilege** principle (p. 288). Generated code is always treated as **untrusted** (p. 289), and the system performs a **checkpoint** before every execution (p. 290).

### 3.1 Isolation Model

```
┌──────────────────────────────────────────────────────────┐
│  Host (AgentForge Platform)                              │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Sandbox Manager                                    │ │
│  │                                                     │ │
│  │  ┌──────────────┐  ┌──────────────┐                │ │
│  │  │ MicroVM A    │  │ MicroVM B    │   ...          │ │
│  │  │ (Firecracker)│  │ (Firecracker)│                │ │
│  │  │              │  │              │                │ │
│  │  │  ┌────────┐  │  │  ┌────────┐  │                │ │
│  │  │  │ User   │  │  │  │ User   │  │                │ │
│  │  │  │ Code   │  │  │  │ Code   │  │                │ │
│  │  │  └────────┘  │  │  └────────┘  │                │ │
│  │  │              │  │              │                │ │
│  │  │  Resources:  │  │  Resources:  │                │ │
│  │  │  CPU: 1 core │  │  CPU: 1 core │                │ │
│  │  │  RAM: 256MB  │  │  RAM: 256MB  │                │ │
│  │  │  Disk: 100MB │  │  Disk: 100MB │                │ │
│  │  │  Net: NONE   │  │  Net: NONE   │                │ │
│  │  │  Time: 30s   │  │  Time: 30s   │                │ │
│  │  └──────────────┘  └──────────────┘                │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

The sandbox uses **Firecracker microVMs** (primary) or **gVisor** (alternative) to provide hardware-level isolation. Each code execution request receives its own ephemeral microVM that is destroyed after execution completes.

### 3.2 Resource Limits

| Resource | Default Limit | Configurable Range | Enforcement |
|---|---|---|---|
| CPU | 1 vCPU | 1-4 vCPU | cgroup / Firecracker config |
| Memory | 256 MB | 64-1024 MB | cgroup OOM killer |
| Disk | 100 MB tmpfs | 50-500 MB | tmpfs mount size |
| Wall-clock time | 30 seconds | 5-120 seconds | SIGKILL after timeout |
| Process count | 32 | 8-128 | cgroup pids.max |
| Network | Disabled | Optional allowlist | netns / iptables |
| Filesystem | Read-only rootfs + tmpfs workdir | -- | mount flags |

### 3.3 Allowed & Denied Operations

**Allowed**:
- Read from pre-installed language runtimes (Python, Node.js, Go, Rust)
- Write to `/tmp/workspace` (tmpfs)
- Import from a curated set of standard library modules
- Import from a pre-approved set of third-party packages

**Denied**:
- Network access (no outbound connections by default)
- Filesystem access outside `/tmp/workspace`
- Process spawning beyond the pids limit
- System calls restricted via seccomp profile (only ~60 allowed syscalls)
- Access to host metadata, environment variables, or secrets

### 3.4 Sandbox Execution Pseudocode

```python
import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from opentelemetry import trace

tracer = trace.get_tracer("agentforge.codegen.sandbox")


class SandboxStatus(Enum):
    READY = "ready"
    RUNNING = "running"
    COMPLETED = "completed"
    TIMEOUT = "timeout"
    OOM_KILLED = "oom_killed"
    ERROR = "error"
    DESTROYED = "destroyed"


@dataclass
class SandboxConfig:
    """Configuration for a sandbox instance. Enforces Least Privilege (p. 288)."""
    cpu_count: int = 1
    memory_mb: int = 256
    disk_mb: int = 100
    timeout_seconds: int = 30
    max_processes: int = 32
    network_enabled: bool = False
    network_allowlist: list[str] = field(default_factory=list)
    allowed_imports: list[str] = field(default_factory=lambda: [
        "json", "math", "datetime", "collections", "itertools",
        "functools", "typing", "dataclasses", "re", "hashlib",
        "base64", "csv", "io", "os.path", "pathlib", "textwrap",
    ])
    allowed_packages: list[str] = field(default_factory=lambda: [
        "numpy", "pandas", "requests",  # requests only if network enabled
    ])


@dataclass
class ExecutionResult:
    """Result of a sandbox execution."""
    status: SandboxStatus
    stdout: str
    stderr: str
    exit_code: int
    execution_time_ms: float
    memory_peak_mb: float
    files_created: list[str] = field(default_factory=list)


class SandboxManager:
    """
    Manages ephemeral sandbox instances for code execution.

    Each execution gets a fresh microVM. Code outputs are
    treated as untrusted (p. 289) and sanitized before
    returning to the calling agent.

    A checkpoint is created before execution (p. 290) so the
    platform can recover if the sandbox misbehaves.
    """

    def __init__(self, config: SandboxConfig):
        self.config = config
        self._pool: asyncio.Queue = asyncio.Queue()

    async def execute(
        self,
        code: str,
        language: str,
        execution_id: str,
    ) -> ExecutionResult:
        """
        Execute code in an isolated sandbox.

        Steps:
          1. Validate code against import allowlist
          2. Create checkpoint (p. 290)
          3. Provision ephemeral microVM
          4. Write code to sandbox workspace
          5. Execute with resource limits and timeout
          6. Capture output and sanitize (untrusted, p. 289)
          7. Destroy sandbox
        """
        with tracer.start_as_current_span("sandbox.execute", attributes={
            "execution_id": execution_id,
            "language": language,
            "timeout_seconds": self.config.timeout_seconds,
        }) as span:

            # Step 1: Pre-execution validation
            # Reject code that imports disallowed modules
            validation_result = self._validate_imports(code, language)
            if not validation_result["valid"]:
                span.set_attribute("blocked_reason", "disallowed_import")
                return ExecutionResult(
                    status=SandboxStatus.ERROR,
                    stdout="",
                    stderr=f"Blocked import: {validation_result['violations']}",
                    exit_code=-1,
                    execution_time_ms=0,
                    memory_peak_mb=0,
                )

            # Step 2: Checkpoint before execution (p. 290)
            checkpoint = await self._create_checkpoint(execution_id)
            span.add_event("checkpoint_created", {"checkpoint_id": checkpoint.id})

            # Step 3: Provision ephemeral sandbox
            sandbox_instance = await self._provision_sandbox(execution_id)

            try:
                # Step 4: Write code to sandbox workspace
                await sandbox_instance.write_file(
                    path="/tmp/workspace/main.py" if language == "python"
                    else f"/tmp/workspace/main.{language}",
                    content=code,
                )

                # Step 5: Execute with timeout enforcement
                start_time = time.monotonic()
                try:
                    raw_result = await asyncio.wait_for(
                        sandbox_instance.run(
                            command=self._build_run_command(language),
                            cwd="/tmp/workspace",
                        ),
                        timeout=self.config.timeout_seconds,
                    )
                    execution_time = (time.monotonic() - start_time) * 1000
                except asyncio.TimeoutError:
                    execution_time = self.config.timeout_seconds * 1000
                    span.set_attribute("result", "timeout")
                    return ExecutionResult(
                        status=SandboxStatus.TIMEOUT,
                        stdout="",
                        stderr=f"Execution exceeded {self.config.timeout_seconds}s timeout",
                        exit_code=-1,
                        execution_time_ms=execution_time,
                        memory_peak_mb=self.config.memory_mb,
                    )

                # Step 6: Sanitize output (untrusted, p. 289)
                sanitized_stdout = self._sanitize_output(raw_result.stdout)
                sanitized_stderr = self._sanitize_output(raw_result.stderr)

                span.set_attribute("result", "completed")
                span.set_attribute("exit_code", raw_result.exit_code)

                return ExecutionResult(
                    status=SandboxStatus.COMPLETED,
                    stdout=sanitized_stdout,
                    stderr=sanitized_stderr,
                    exit_code=raw_result.exit_code,
                    execution_time_ms=execution_time,
                    memory_peak_mb=raw_result.memory_peak_mb,
                    files_created=raw_result.files_created,
                )

            finally:
                # Step 7: Always destroy sandbox after execution
                await self._destroy_sandbox(sandbox_instance)
                span.add_event("sandbox_destroyed")

    def _validate_imports(self, code: str, language: str) -> dict:
        """
        Static analysis: ensure code only imports allowed modules.
        This is a defense-in-depth check; the sandbox also restricts
        available packages at the filesystem level.
        """
        # Implementation: AST-based import extraction for Python,
        # regex-based for other languages.
        ...

    def _sanitize_output(self, output: str) -> str:
        """
        Sanitize sandbox output before returning to the agent.
        Strips ANSI escape codes, truncates to max length,
        removes any leaked filesystem paths or system info.
        """
        ...

    def _build_run_command(self, language: str) -> list[str]:
        commands = {
            "python": ["python3", "-u", "/tmp/workspace/main.py"],
            "javascript": ["node", "/tmp/workspace/main.js"],
            "go": ["go", "run", "/tmp/workspace/main.go"],
            "rust": ["bash", "-c", "cd /tmp/workspace && rustc main.rs -o main && ./main"],
        }
        return commands.get(language, ["python3", "-u", "/tmp/workspace/main.py"])

    async def _create_checkpoint(self, execution_id: str):
        """Create a checkpoint so we can recover if execution causes issues (p. 290)."""
        ...

    async def _provision_sandbox(self, execution_id: str):
        """Spin up a fresh Firecracker microVM or gVisor container."""
        ...

    async def _destroy_sandbox(self, sandbox_instance):
        """Tear down and deallocate the sandbox. Idempotent."""
        ...
```

---

## 4. Code Review Agent

The Code Review Agent implements the **Critic** half of the Generator-Critic reflection pattern (p. 65). It is a separate agent with its own system prompt, distinct from the generator, ensuring independent evaluation.

### 4.1 Review Criteria

The reviewer evaluates generated code along four axes:

| Axis | Weight | Checks |
|---|---|---|
| **Correctness** | 40% | Logic matches spec, edge cases handled, types correct |
| **Security** | 30% | No injection vectors, no unsafe operations, no data leaks |
| **Style** | 15% | Follows language idioms, readable, documented |
| **Efficiency** | 15% | No unnecessary complexity, reasonable time/space characteristics |

### 4.2 Security Checks

The security review is particularly critical for a code generation system. The reviewer checks for:

- **Injection vulnerabilities**: SQL injection, command injection, XSS in generated web code
- **Unsafe operations**: File system access outside workspace, network calls, process spawning
- **Secrets exposure**: Hardcoded credentials, API keys, tokens in generated code
- **Dependency risks**: Import of known-vulnerable packages
- **Denial of service**: Infinite loops, unbounded recursion, memory-intensive allocations
- **Data exfiltration**: Code that attempts to send data to external endpoints

### 4.3 Review Flow

```
┌──────────────┐     ┌─────────────────────────────────────────┐
│  Generated   │────>│  Code Review Agent (Critic, p. 65)      │
│  Code        │     │                                         │
└──────────────┘     │  1. Static analysis (AST-based)         │
                     │  2. LLM-based semantic review            │
                     │  3. Security pattern matching             │
                     │  4. Style/lint check                      │
                     │                                         │
                     │  Output: ReviewResult                    │
                     │    - approved: bool                      │
                     │    - scores: {correctness, security,     │
                     │               style, efficiency}         │
                     │    - issues: [{severity, description,    │
                     │               line, suggestion}]         │
                     └─────────────────────────────────────────┘
```

The reviewer combines two approaches:

1. **Deterministic static analysis**: AST parsing, linting, known vulnerability patterns. These are fast and reliable.
2. **LLM-based semantic review**: The critic LLM evaluates correctness against the original specification and identifies subtle logic errors that static analysis cannot catch.

Both results are merged into the final `ReviewResult`. If the deterministic analysis finds a critical security issue, the code is rejected regardless of the LLM's assessment.

---

## 5. Test Execution Framework

The test execution framework implements the **SICA (Self-Improving Coding Agent)** pattern (p. 169), where test results feed back into the generation loop as structured observations.

### 5.1 Test Sources

Tests can originate from three sources:

1. **Spec-derived tests**: The pipeline automatically generates test cases from the user's natural-language specification.
2. **User-provided tests**: The user supplies explicit test cases in the `CodeSpec.test_requirements` field.
3. **Invariant tests**: Platform-level tests that apply to all generated code (e.g., no side effects outside workspace, terminates within timeout, no uncaught exceptions).

### 5.2 Test Execution Flow

```
┌────────────┐    ┌─────────────────┐    ┌──────────────┐
│ Generated  │    │ Test Generation │    │ Sandbox      │
│ Code       │───>│ (from spec &    │───>│ Execution    │
│            │    │  user tests)    │    │              │
└────────────┘    └─────────────────┘    └──────┬───────┘
                                                │
                                    ┌───────────┴───────────┐
                                    │                       │
                               ┌────┴─────┐          ┌─────┴────┐
                               │  PASS    │          │  FAIL    │
                               │          │          │          │
                               │  -> next │          │  -> feed │
                               │  stage   │          │  back to │
                               │          │          │  generator│
                               └──────────┘          └──────────┘
```

### 5.3 Result Interpretation

Test results are structured as `TestResult` objects (see Section 2.2). The pipeline interprets them as follows:

- **All tests pass**: Code is approved; pipeline completes with `SUCCESS`.
- **Some tests fail**: Failure details are formatted as feedback and appended to the generator's context for the next iteration. This is the SICA test-driven feedback loop (p. 169).
- **Execution error** (e.g., syntax error, import failure): Treated as a total failure; the error message itself becomes feedback.
- **Timeout or OOM**: Indicates the code is too expensive to run; feedback includes resource constraint information.

---

## 6. MCP Tool Definitions

All code generation capabilities are exposed via an **MCP server** (p. 155-165), allowing any agent in the platform to invoke them using standard MCP tool calls. The server is built with **FastMCP** (p. 162).

### 6.1 Tool Catalog

| Tool Name | Description | Irreversible? | HITL Gate? |
|---|---|---|---|
| `generate_code` | Generate code from a natural-language specification | No | No |
| `review_code` | Run automated review on a code snippet | No | No |
| `execute_code` | Execute code in the sandbox | Yes (p. 91) | Conditional |
| `run_tests` | Run tests against code in the sandbox | Yes (p. 91) | No |
| `refine_code` | Run the full generate-review-test-iterate pipeline | Yes (p. 91) | Conditional |

### 6.2 MCP Server Pseudocode

```python
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

# Initialize MCP server for code generation tools (p. 162)
mcp = FastMCP(
    "agentforge-codegen",
    description="Code generation, execution, and review tools for AgentForge agents.",
)


# --- JSON Schema definitions for tool parameters (p. 85) ---

class GenerateCodeParams(BaseModel):
    """Parameters for code generation."""
    description: str = Field(
        ..., description="Natural-language description of the code to generate."
    )
    language: str = Field(
        default="python", description="Target programming language."
    )
    framework: str | None = Field(
        default=None, description="Target framework (e.g., 'fastapi', 'react')."
    )
    constraints: list[str] = Field(
        default_factory=list,
        description="Additional constraints or requirements.",
    )
    existing_context: str | None = Field(
        default=None,
        description="Existing code context the generated code must integrate with.",
    )


class ExecuteCodeParams(BaseModel):
    """Parameters for sandbox code execution. Flagged as irreversible (p. 91)."""
    code: str = Field(..., description="The code to execute.")
    language: str = Field(default="python", description="Programming language.")
    timeout_seconds: int = Field(
        default=30, ge=5, le=120,
        description="Maximum execution time in seconds.",
    )
    network_enabled: bool = Field(
        default=False,
        description="Whether to allow network access. Requires HITL approval (p. 213).",
    )


class ReviewCodeParams(BaseModel):
    """Parameters for automated code review."""
    code: str = Field(..., description="The code to review.")
    language: str = Field(default="python", description="Programming language.")
    spec: str | None = Field(
        default=None,
        description="Original specification to check correctness against.",
    )
    focus: list[str] = Field(
        default_factory=lambda: ["correctness", "security", "style"],
        description="Review focus areas.",
    )


class RunTestsParams(BaseModel):
    """Parameters for test execution."""
    code: str = Field(..., description="The code under test.")
    tests: str = Field(..., description="The test code to run.")
    language: str = Field(default="python", description="Programming language.")
    timeout_seconds: int = Field(default=30, ge=5, le=120)


class RefineCodeParams(BaseModel):
    """Parameters for the full iterative refinement pipeline."""
    description: str = Field(
        ..., description="Natural-language specification."
    )
    language: str = Field(default="python")
    framework: str | None = None
    constraints: list[str] = Field(default_factory=list)
    test_requirements: list[str] = Field(default_factory=list)
    max_iterations: int = Field(default=5, ge=1, le=10)


# --- Tool definitions using FastMCP decorators (p. 162) ---

@mcp.tool()
async def generate_code(params: GenerateCodeParams) -> dict:
    """
    Generate code from a natural-language specification.

    Uses an LLM to produce code matching the given description,
    language, and constraints. Returns structured output with
    the generated code, explanation, and confidence score.

    This tool is NOT irreversible -- it only generates code
    without executing it.
    """
    spec = CodeSpec(
        description=params.description,
        language=params.language,
        framework=params.framework,
        constraints=params.constraints,
        existing_context=params.existing_context,
    )

    generator = CodeGeneratorAgent()
    result = await generator.generate(spec=spec, feedback=[], iteration=1)

    return {
        "code": result.code,
        "language": result.language,
        "explanation": result.explanation,
        "confidence": result.confidence,
        "imports": result.imports,
    }


@mcp.tool()
async def execute_code(params: ExecuteCodeParams) -> dict:
    """
    Execute code in a secure sandbox.

    *** IRREVERSIBLE TOOL (p. 91) ***

    Code is executed inside an isolated Firecracker microVM with:
    - Limited CPU, memory, and disk
    - No network access by default
    - Read-only rootfs
    - Timeout enforcement

    If network_enabled=True, this tool requires human approval
    (HITL gate, p. 213) before execution.

    Code outputs are treated as untrusted (p. 289).
    """
    # HITL gate: network access requires human approval (p. 213)
    if params.network_enabled:
        approval = await request_human_approval(
            action="execute_code_with_network",
            details={
                "code_preview": params.code[:500],
                "language": params.language,
                "timeout": params.timeout_seconds,
            },
            reason="Code execution with network access requires human approval.",
        )
        if not approval.granted:
            return {
                "status": "blocked",
                "reason": "Human approval denied for network-enabled execution.",
            }

    sandbox = SandboxManager(config=SandboxConfig(
        timeout_seconds=params.timeout_seconds,
        network_enabled=params.network_enabled,
    ))

    result = await sandbox.execute(
        code=params.code,
        language=params.language,
        execution_id=str(uuid.uuid4()),
    )

    # Tool error handling: errors returned as observations (p. 90)
    return {
        "status": result.status.value,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "exit_code": result.exit_code,
        "execution_time_ms": result.execution_time_ms,
        "memory_peak_mb": result.memory_peak_mb,
    }


@mcp.tool()
async def review_code(params: ReviewCodeParams) -> dict:
    """
    Run automated code review on a code snippet.

    Combines static analysis (AST-based) and LLM-based semantic
    review to evaluate correctness, security, and style.

    Implements the Critic role from the Generator-Critic
    reflection pattern (p. 65).
    """
    reviewer = CodeReviewAgent()
    generated = GeneratedCode(
        code=params.code,
        language=params.language,
        explanation="",
        confidence=0.0,
    )
    spec = CodeSpec(description=params.spec or "", language=params.language)

    result = await reviewer.review(code=generated, spec=spec)

    return {
        "approved": result.approved,
        "scores": {
            "correctness": result.correctness_score,
            "security": result.security_score,
            "style": result.style_score,
        },
        "issues": result.issues,
        "suggestions": result.suggestions,
    }


@mcp.tool()
async def run_tests(params: RunTestsParams) -> dict:
    """
    Run tests against code in the sandbox.

    *** IRREVERSIBLE TOOL (p. 91) ***

    Both the code under test and the test code are executed
    inside the sandbox. Test results are returned as structured
    observations for the SICA feedback loop (p. 169).
    """
    sandbox = SandboxManager(config=SandboxConfig(
        timeout_seconds=params.timeout_seconds,
    ))
    runner = TestRunner()

    spec = CodeSpec(description="", language=params.language)
    generated = GeneratedCode(
        code=params.code,
        language=params.language,
        explanation="",
        confidence=0.0,
    )

    result = await runner.run(code=generated, spec=spec, sandbox=sandbox)

    return {
        "passed": result.passed,
        "total_tests": result.total_tests,
        "passed_tests": result.passed_tests,
        "failed_tests": result.failed_tests,
        "failures": result.failures,
        "execution_time_ms": result.execution_time_ms,
    }


@mcp.tool()
async def refine_code(params: RefineCodeParams) -> dict:
    """
    Run the full code generation pipeline with iterative refinement.

    *** IRREVERSIBLE TOOL (p. 91) ***

    Executes the complete Generate -> Review -> Test -> Iterate
    loop up to max_iterations times (p. 67). Returns the final
    code, review scores, test results, and iteration count.

    This implements the SICA (Self-Improving Coding Agent)
    pattern (p. 169).
    """
    spec = CodeSpec(
        description=params.description,
        language=params.language,
        framework=params.framework,
        constraints=params.constraints,
        test_requirements=params.test_requirements,
    )

    pipeline = CodeGenerationPipeline(
        generator=CodeGeneratorAgent(),
        reviewer=CodeReviewAgent(),
        test_runner=TestRunner(),
        sandbox=SandboxManager(config=SandboxConfig()),
        max_iterations=params.max_iterations,
    )

    result = await pipeline.run(spec)

    return {
        "status": result.status.value,
        "code": result.code.code if result.code else None,
        "review_scores": {
            "correctness": result.review.correctness_score,
            "security": result.review.security_score,
            "style": result.review.style_score,
        } if result.review else None,
        "test_result": {
            "passed": result.test_result.passed,
            "total": result.test_result.total_tests,
            "failures": result.test_result.failures,
        } if result.test_result else None,
        "iterations": result.iterations,
        "trace_id": result.trace_id,
    }


if __name__ == "__main__":
    mcp.run(transport="stdio")
```

---

## 7. Security Model

The security model for code generation applies **defense-in-depth** (System Overview, Section 3.4), with multiple independent layers that each prevent a distinct class of attack.

### 7.1 Threat Model

| Threat | Attack Vector | Mitigation |
|---|---|---|
| **Sandbox escape** | Kernel exploit, container breakout | Firecracker microVM with seccomp (hardware-level isolation) |
| **Resource exhaustion** | Fork bomb, memory allocation bomb, infinite loop | cgroup limits on pids, memory, CPU; wall-clock timeout |
| **Data exfiltration** | Network call to attacker-controlled endpoint | Network disabled by default; allowlist if enabled |
| **Host filesystem access** | Path traversal, symlink attacks | Read-only rootfs, tmpfs workspace, no mount propagation |
| **Prompt injection via code** | Generated code contains instructions for the reviewing LLM | Reviewer receives code in a structured format with clear delimiters; reviewer system prompt explicitly warns about embedded instructions |
| **Supply chain attack** | Generated code imports a malicious package | Curated package allowlist; no package installation at runtime |
| **Persistent state** | Sandbox retains state from a previous execution | Ephemeral microVMs destroyed after each execution |

### 7.2 Security Layers

```
┌────────────────────────────────────────────────────────────────┐
│  Layer 1: Pre-Execution Validation                             │
│  - AST-based import analysis                                   │
│  - Static security scan (bandit, semgrep)                      │
│  - Known vulnerability pattern matching                         │
│  - Reject code before it ever reaches the sandbox              │
├────────────────────────────────────────────────────────────────┤
│  Layer 2: Sandbox Isolation (Least Privilege, p. 288)          │
│  - Firecracker microVM or gVisor                               │
│  - Seccomp profile: ~60 allowed syscalls                       │
│  - Read-only rootfs + tmpfs workspace                          │
│  - No host PID/network/IPC namespace sharing                   │
├────────────────────────────────────────────────────────────────┤
│  Layer 3: Resource Limits                                       │
│  - cgroup CPU, memory, pids limits                             │
│  - Wall-clock timeout with SIGKILL                             │
│  - tmpfs disk quota                                            │
├────────────────────────────────────────────────────────────────┤
│  Layer 4: Network Isolation                                     │
│  - Network disabled by default (no veth)                       │
│  - Optional allowlist-only egress via proxy                    │
│  - Network access requires HITL approval (p. 213)             │
├────────────────────────────────────────────────────────────────┤
│  Layer 5: Output Sanitization (Untrusted, p. 289)             │
│  - Strip ANSI escape codes                                     │
│  - Truncate to maximum output size                             │
│  - Remove filesystem paths, system metadata                    │
│  - PII/secret detection on output                              │
├────────────────────────────────────────────────────────────────┤
│  Layer 6: Checkpoint & Recovery (p. 290)                       │
│  - Checkpoint before every execution                           │
│  - Sandbox destruction is idempotent                           │
│  - Execution result recorded regardless of outcome             │
└────────────────────────────────────────────────────────────────┘
```

### 7.3 Network Access Policy

Network access is the most sensitive capability because it enables data exfiltration. The policy enforces a strict escalation:

1. **Default**: No network access. The sandbox has no virtual network interface.
2. **Allowlisted**: If the code specification requires HTTP access (e.g., API client code), a proxy is configured to permit only specific domains. Requires configuration-level approval.
3. **Open network**: Full egress. Requires explicit **HITL approval** (p. 213) and is logged with full packet capture.

---

## 8. HITL Gates

Human-in-the-loop gates (p. 207-215) are placed at decision points where the risk of automated action is unacceptable.

### 8.1 HITL Trigger Conditions

| Trigger | Condition | Default Action if Timeout |
|---|---|---|
| **Network-enabled execution** | `execute_code` called with `network_enabled=True` | Block execution |
| **Execution outside sandbox** | Request to run code on the host (e.g., deployment) | Block execution |
| **Large-scale file operations** | Generated code writes >10 files or >1MB total | Block execution |
| **Repeated sandbox failures** | 3+ consecutive timeout/OOM in a single pipeline run | Abort pipeline |
| **Security review critical** | Reviewer flags a `critical` severity security issue | Block and alert |
| **Unfamiliar language/runtime** | Code targets a language not in the pre-approved list | Block execution |

### 8.2 Approval Flow

```
┌──────────────┐     ┌────────────────────┐     ┌──────────────────┐
│  Agent       │────>│  HITL Gate         │────>│  Human Reviewer  │
│  requests    │     │                    │     │                  │
│  execution   │     │  - Formats context │     │  - Sees code     │
│              │     │  - Sets timeout    │     │  - Sees risk     │
│              │     │  - Queues request  │     │  - Approves or   │
│              │     │                    │     │    denies         │
└──────────────┘     └────────┬───────────┘     └────────┬─────────┘
                              │                          │
                              │  ┌──────────────────┐    │
                              └─>│  Decision         │<──┘
                                 │                    │
                                 │  approved -> exec  │
                                 │  denied -> block   │
                                 │  timeout -> block  │
                                 └────────────────────┘
```

The HITL request includes:
- A preview of the code (first 500 characters, with the full code available on click)
- The risk assessment from the reviewer
- The triggering condition
- A recommended action (approve/deny)

The human reviewer can:
- **Approve**: Execution proceeds.
- **Deny**: Execution is blocked; the agent receives a denial observation (p. 90).
- **Modify**: The reviewer can edit the code or constraints before approving.
- **Timeout** (configurable, default 5 minutes): Treated as denial.

---

## 9. API Surface

### 9.1 REST API

All pipeline operations are available via a FastAPI REST surface in addition to the MCP tools.

```
POST /api/v1/codegen/generate
  Body: GenerateCodeParams
  Response: { code, language, explanation, confidence, imports }

POST /api/v1/codegen/execute
  Body: ExecuteCodeParams
  Response: { status, stdout, stderr, exit_code, execution_time_ms, memory_peak_mb }

POST /api/v1/codegen/review
  Body: ReviewCodeParams
  Response: { approved, scores, issues, suggestions }

POST /api/v1/codegen/test
  Body: RunTestsParams
  Response: { passed, total_tests, passed_tests, failed_tests, failures, execution_time_ms }

POST /api/v1/codegen/refine
  Body: RefineCodeParams
  Response: { status, code, review_scores, test_result, iterations, trace_id }

GET  /api/v1/codegen/executions/{execution_id}
  Response: { execution_id, status, result, created_at, completed_at }

GET  /api/v1/codegen/executions/{execution_id}/trace
  Response: { trace_id, spans }

GET  /api/v1/codegen/sandbox/config
  Response: { default_config, limits }

POST /api/v1/codegen/sandbox/config
  Body: SandboxConfig overrides (requires admin role)
  Response: { updated_config }
```

### 9.2 Authentication & Authorization

| Endpoint | Required Role | Notes |
|---|---|---|
| `generate`, `review` | `agent`, `user` | Read-only operations, no execution |
| `execute`, `test`, `refine` | `agent`, `user` | Execution operations, subject to HITL gates |
| `sandbox/config` (POST) | `admin` | Modifying sandbox limits is a privileged operation |
| `executions/{id}` | `agent`, `user`, `admin` | Scoped to own executions unless admin |

### 9.3 MCP Transport

The MCP server supports two transports (p. 160):

- **STDIO**: For local agents running on the same host. Low latency, no network overhead.
- **HTTP+SSE**: For remote agents. Authenticated via OAuth2 bearer tokens (p. 248).

---

## 10. Failure Modes & Mitigations

| Failure Mode | Detection | Impact | Mitigation |
|---|---|---|---|
| **LLM generates invalid code** | Review stage rejects; test stage fails | Pipeline iterates | Reflection loop with max iterations (p. 67); feedback accumulates context |
| **Sandbox timeout** | `asyncio.TimeoutError` | Single execution lost | Return `TIMEOUT` status; feed constraint info back to generator |
| **Sandbox OOM** | cgroup OOM killer fires | Single execution lost | Return `OOM_KILLED` status; reduce memory allocation in next iteration |
| **Sandbox escape attempt** | Seccomp violation (SIGSYS), anomalous syscall log | Blocked by kernel | Log incident, alert security team, quarantine the agent |
| **LLM hallucinated imports** | Import validation rejects before execution | Generation blocked | Feed allowlist to generator prompt; iterate |
| **Pipeline max iterations** | Iteration counter reaches limit | No valid code produced | Return `MAX_ITERATIONS` status with best attempt; escalate to HITL |
| **MCP server crash** | Health check failure, connection timeout | Tools unavailable | Auto-restart with backoff; circuit breaker pattern |
| **Reviewer disagrees with tests** | Review approves but tests fail, or vice versa | Inconsistent signals | Tests are authoritative; review is advisory |
| **Network partition during HITL** | Approval request timeout | Execution blocked | Default-deny; agent receives timeout observation |
| **Concurrent sandbox exhaustion** | Pool empty, provision timeout | Queued requests delayed | Sandbox pool with backpressure; queue with priority |

### 10.1 Error Classification (p. 205)

Errors from the code generation subsystem follow the platform's Error Triad:

- **Transient errors**: Sandbox provisioning failure, LLM rate limit -> Retry with exponential backoff.
- **Logic errors**: Code fails review or tests -> Re-prompt the generator with feedback (reflection loop).
- **Unrecoverable errors**: Sandbox escape attempt, repeated security violations -> Abort, log, escalate to HITL.

---

## 11. Instrumentation

The subsystem emits traces, metrics, and logs to the Observability Platform (see Subsystem 05).

### 11.1 Trace Structure

Every pipeline invocation produces a hierarchical trace:

```
Trace: codegen.pipeline (trace_id)
├── Span: codegen.generate (iteration 1)
│   ├── attribute: spec.language = "python"
│   ├── attribute: model = "claude-sonnet"
│   ├── attribute: tokens.input = 1200
│   ├── attribute: tokens.output = 850
│   └── attribute: confidence = 0.82
│
├── Span: codegen.review (iteration 1)
│   ├── attribute: correctness_score = 0.6
│   ├── attribute: security_score = 0.9
│   ├── attribute: approved = false
│   └── event: review_rejected { issue_count: 2 }
│
├── Span: codegen.generate (iteration 2)
│   ├── attribute: feedback_items = 1
│   ├── attribute: confidence = 0.88
│   └── ...
│
├── Span: codegen.review (iteration 2)
│   ├── attribute: correctness_score = 0.85
│   ├── attribute: approved = true
│   └── ...
│
├── Span: codegen.test (iteration 2)
│   ├── Span: sandbox.execute
│   │   ├── attribute: execution_id = "..."
│   │   ├── attribute: timeout_seconds = 30
│   │   ├── attribute: exit_code = 0
│   │   ├── attribute: execution_time_ms = 1240
│   │   └── event: sandbox_destroyed
│   │
│   ├── attribute: total_tests = 8
│   ├── attribute: passed_tests = 8
│   └── attribute: passed = true
│
└── Metadata
    ├── total_iterations = 2
    ├── total_tokens = 4100
    ├── total_latency_ms = 8500
    ├── result = "success"
    └── cost_usd = 0.0062
```

### 11.2 Metrics

All metrics are exported as OpenTelemetry metrics and are available in Grafana dashboards.

| Metric | Type | Labels | Description |
|---|---|---|---|
| `codegen.pipeline.duration_ms` | Histogram | `language`, `status` | End-to-end pipeline latency |
| `codegen.pipeline.iterations` | Histogram | `language`, `status` | Number of reflection iterations per pipeline run |
| `codegen.pipeline.status` | Counter | `status` | Pipeline outcome counts (success, max_iterations, blocked) |
| `codegen.generate.duration_ms` | Histogram | `language`, `model` | Code generation latency per iteration |
| `codegen.generate.tokens` | Counter | `language`, `model`, `direction` | Tokens consumed (input/output) |
| `codegen.generate.confidence` | Histogram | `language` | Self-assessed confidence distribution |
| `codegen.review.scores` | Histogram | `language`, `axis` | Review scores by axis (correctness, security, style) |
| `codegen.review.approved_ratio` | Gauge | `language` | Rolling ratio of approved reviews |
| `codegen.review.issues` | Counter | `language`, `severity` | Count of issues found by severity |
| `codegen.test.pass_rate` | Gauge | `language` | Rolling test pass rate (p. 301-314) |
| `codegen.test.duration_ms` | Histogram | `language` | Test execution latency |
| `codegen.sandbox.status` | Counter | `status` | Sandbox execution outcome counts |
| `codegen.sandbox.duration_ms` | Histogram | `language` | Sandbox wall-clock execution time |
| `codegen.sandbox.memory_peak_mb` | Histogram | `language` | Peak memory usage per execution |
| `codegen.sandbox.pool_utilization` | Gauge | -- | Fraction of sandbox pool in use |
| `codegen.hitl.requests` | Counter | `trigger`, `outcome` | HITL approval requests and outcomes |
| `codegen.hitl.latency_ms` | Histogram | `trigger` | Time to human decision |
| `codegen.security.violations` | Counter | `type` | Security violations by type (import, syscall, network) |

### 11.3 Alerts

| Alert | Condition | Severity | Action |
|---|---|---|---|
| `CodeGenHighFailRate` | `pipeline.status{status="max_iterations"}` > 30% over 15 min | Warning | Investigate generator prompt quality |
| `SandboxEscapeAttempt` | `security.violations{type="syscall"}` > 0 | Critical | Quarantine agent, page security on-call |
| `SandboxPoolExhausted` | `sandbox.pool_utilization` > 90% for 5 min | Warning | Scale sandbox pool, check for runaway pipelines |
| `ReviewPassRateDrop` | `review.approved_ratio` < 40% over 30 min | Warning | Check for degraded LLM quality or specification drift |
| `TestPassRateDrop` | `test.pass_rate` < 50% over 30 min | Warning | Investigate test framework or generator regression |
| `HITLApprovalBacklog` | `hitl.requests` pending > 10 for 10 min | Warning | Alert human reviewers; consider scaling review team |
| `SandboxOOMSpike` | `sandbox.status{status="oom_killed"}` > 5 in 5 min | Warning | Investigate generated code memory patterns |

### 11.4 Logging

All subsystem logs follow structured JSON format and are shipped to the Observability Platform:

```json
{
  "timestamp": "2026-02-27T14:32:01.123Z",
  "level": "INFO",
  "service": "agentforge.codegen",
  "trace_id": "abc-123-def",
  "span_id": "span-456",
  "event": "pipeline.iteration_complete",
  "attributes": {
    "iteration": 2,
    "review_approved": true,
    "tests_passed": true,
    "language": "python",
    "execution_time_ms": 1240
  }
}
```

Security-relevant events (sandbox violations, HITL decisions, blocked executions) are additionally forwarded to the security audit log, which is append-only and immutable.

---

*This document describes Subsystem #6 of the AgentForge Agentic Orchestration Platform. For related subsystems, see: 03 (Tool & MCP Manager) for tool registration and discovery, 04 (Guardrail System) for policy enforcement, and 05 (Observability Platform) for tracing and monitoring infrastructure.*
