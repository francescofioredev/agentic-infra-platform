# ADR-001: Agentic Orchestration & Monitoring Platform

**Date**: 2026-02-27
**Status**: `Proposed`
**Deciders**: Platform Architecture Team

---

## Context

We are designing an **Agentic Orchestration & Monitoring Platform** (codename: **AgentForge**) — a system that lets users create, compose, govern, and observe agentic AI systems at scale.

**System**: An orchestration platform for building, managing, and monitoring agentic AI infrastructure.

**Scale**: Multi-tenant SaaS platform supporting hundreds of concurrent agent teams, thousands of tool invocations/minute, sub-second monitoring latency.

**Core Requirements**:

1. **Agent Builder**: Create agents via versioned system prompts, optimizable by AI itself (self-improving prompts).
2. **Team Orchestrator**: Compose agents into teams with explicit communication rules and orchestration topologies.
3. **Tool & MCP Manager**: Manage MCP servers and tools assignable to individual agents or entire teams, following Least Privilege.
4. **Guardrail System**: Dedicated guardrail agents that monitor team/agent behavior in real-time, enforcing policies and emitting alerts.
5. **Observability Platform**: Visibility into interactions, decisions, tool calls, and agent trajectories.
6. **Code Generation Tools**: Specialized tools that enable agents to generate, review, and execute code safely.

**Primary concerns** (from taxonomy.yaml):

- [x] reliability — agents must behave predictably, recover from failures
- [x] safety — guardrail agents, least privilege, defense-in-depth
- [x] memory — versioned prompts, cross-session state, agent knowledge
- [x] tool-use — MCP server management, tool permission scoping
- [x] orchestration — team topologies, communication rules, routing
- [x] observability — trace logging, decision auditing, metrics dashboards
- [x] eval — agent quality assessment, prompt optimization feedback
- [x] cost — resource-aware model routing, token budget management

---

## Decision

**Chosen pattern(s)**:

- Primary: `multi-agent-collaboration` (Hierarchical Supervisor topology, p. 122-132)
- Supporting:
  - `routing` (p. 21) — dispatch tasks to specialized agents
  - `parallelization` (p. 41) — concurrent agent execution within teams
  - `planning` (p. 101) — structured task decomposition by orchestrators
  - `tool-use` (p. 81) — function calling with Least Privilege
  - `mcp` (p. 155) — standardized tool protocol for managed tool servers
  - `a2a-communication` (p. 240) — inter-agent HTTP protocol for distributed teams
  - `guardrails-safety` (p. 285) — six-layer defense model with guardrail agents
  - `memory-management` (p. 141) — session/state/memory trichotomy
  - `reflection` (p. 61) — AI-driven prompt optimization via generator-critic loops
  - `learning-adaptation` (p. 163) — evolutionary prompt improvement
  - `evaluation-monitoring` (p. 301) — LLM-as-Judge, trajectory evaluation, metrics
  - `goal-setting-monitoring` (p. 183) — SMART goals with `goals_met()` checks
  - `exception-handling-recovery` (p. 201) — error triad with checkpoint-rollback
  - `hitl` (p. 207) — human escalation for high-stakes decisions
  - `resource-aware-optimization` (p. 255) — dynamic model switching, cost management
  - `prompt-chaining` (p. 1) — deterministic sequential pipelines for internal workflows

**Decision statement**:
> We will build AgentForge as a hierarchical multi-agent platform using a Supervisor topology (p. 127). Teams communicate via A2A (p. 240), tools are managed through MCP (p. 155), and a dedicated Guardrail Agent layer (p. 285) monitors agent behavior. Observability (p. 301) covers trajectory logging and LLM-as-Judge evaluation.
>
> Agent prompts are versioned in a Prompt Registry and improved through a Reflection-based (p. 61) generator-critic loop with evolutionary adaptation (p. 172).
>
> Eight infrastructure subsystems support the platform: IAM & Access Control (multi-tenancy, RBAC), Agent Deployment Pipeline (CI/CD with canary releases), Event Bus (decoupled inter-subsystem messaging), Testing & Simulation (red-team and chaos testing), Conversation & Session Management (multi-channel interactions), Replay & Debugging (time-travel execution analysis), Scheduling & Background Jobs (automated agent execution), and Multi-Provider LLM Management (provider abstraction with failover).

---

## Pattern Analysis

### Multi-Agent Collaboration (patterns/07-multi-agent-collaboration.md)

**Why this pattern**: The platform fundamentally orchestrates teams of specialized agents. Each team is a multi-agent system requiring coordination, communication, and output validation across agent boundaries (p. 126).

**Variant selected**: **Hierarchical Supervisor** (p. 130) — Three levels:

1. **Platform Orchestrator** (top) — routes user requests, manages global state
2. **Team Supervisors** (mid) — coordinate agents within a team
3. **Worker Agents** (bottom) — execute specialized tasks

**Key configuration decisions**:

- Each agent has a single responsibility (p. 124)
- Sub-agent outputs are treated as untrusted and validated at boundaries (p. 126)
- Supervisor agents handle routing, not business logic (p. 127)
- Maximum hierarchy depth: 3 levels to maintain debuggability (p. 130)
- Explicit input/output contracts between agents using JSON Schema (p. 126)

**Known failure modes addressed**:

- Cascading failure → output validation at every agent boundary
- Context explosion → summarize/filter history before passing downstream (p. 127)
- Coordination deadlock → timeout + escalation on all inter-agent waits
- Goal drift → original goal included in every agent's context

---

### Routing (patterns/02-routing.md)

**Why this pattern**: The Platform Orchestrator and Team Supervisors must dispatch incoming requests to the correct specialized agent. LLM-based routing with confidence thresholds enables dynamic, adaptive dispatch (p. 21).

**Variant selected**: LLM-based routing with fallback (p. 25-28)

**Key configuration decisions**:

- Router uses cheap/fast model (Haiku/Flash) for classification (p. 258)
- Always includes a default fallback handler (p. 27)
- Routing decisions logged with confidence score for observability (p. 26)
- Few-shot examples in router prompt for high-stakes routing (p. 27)

**Known failure modes addressed**:

- Mis-routing → confidence threshold below which request is escalated to human
- No fallback → always define default branch
- Router bottleneck → router runs on cheap/fast model to minimize latency

---

### MCP — Model Context Protocol (patterns/10-mcp.md)

**Why this pattern**: The platform needs a standardized way to manage, discover, and assign tools to agents and teams. MCP provides this with a client-server architecture (p. 158), reusable tool definitions, and composable tool servers.

**Variant selected**: Mixed STDIO (dev) + HTTP+SSE (production) transport (p. 160)

**Key configuration decisions**:

- Tool descriptions are self-contained (p. 162) — consuming agents have no other context
- MCP servers are stateless for horizontal scaling (p. 163)
- Authentication required on all MCP servers (p. 163)
- Tool descriptions versioned alongside server code (prevents tool description drift)
- MCP for agent-to-tool; A2A for agent-to-agent (p. 165)

**Known failure modes addressed**:

- Server unavailability → health checks + fallback tools
- Protocol version mismatch → version negotiation at startup
- Tool description drift → versioned tool descriptions tied to server releases

---

### Guardrails / Safety (patterns/18-guardrails-safety.md)

**Why this pattern**: The platform manages potentially autonomous agent teams, so every layer needs constraints on what agents can do. We implement the six-layer defense model (p. 286) plus dedicated Guardrail Agents that act as behavioral monitors at runtime.

**Variant selected**: Six-layer defense + dedicated Guardrail Agent topology

**Key configuration decisions**:

- Six defense layers: input validation, output filtering, behavioral constraints, tool restrictions, external moderation, HITL (p. 286)
- Principle of Least Privilege applied at tool assignment (p. 288)
- Tool outputs treated as untrusted (prompt injection defense, p. 289)
- Checkpoint & rollback for multi-step tasks with side effects (p. 290)
- Guardrail Agents use `before_tool_callback` pattern (p. 295)
- Jailbreak detection via LLM-as-guardrail (p. 296)
- Every safety intervention logged with context for audit (p. 297)

**Known failure modes addressed**:

- Single-layer bypass → multiple independent defense layers
- Tool injection → treat tool outputs as untrusted; filter before context inclusion
- Prompt injection → structural separation (XML tags) between instructions and data
- Safety theater → mandatory red-team testing before deployment

---

### Evaluation & Monitoring (patterns/19-evaluation-monitoring.md)

**Why this pattern**: Observability is a core requirement. We implement the five-level best practices pyramid (p. 303): Define → Collect → Evaluate → Reward → Coach.

**Variant selected**: Online + offline evaluation with LLM-as-Judge (p. 306)

**Key configuration decisions**:

- Core metrics defined before deployment: accuracy, latency, token usage, tool call accuracy (p. 304)
- LLM-as-Judge rubric: Clarity, Neutrality, Relevance, Completeness, Audience (p. 306)
- Agent trajectory evaluation, not just final outputs (p. 308)
- `LLMInteractionMonitor` class for interaction logging (p. 310)
- Separate evalset files for regression testing (p. 312)
- Alerts on metric degradation >10% from baseline (p. 305)

**Known failure modes addressed**:

- Eval-train contamination → strict train/eval separation
- LLM-Judge bias → judge model different from generator; calibrate against human eval
- Eval set distribution drift → periodic evalset refresh from production samples

---

### Reflection (patterns/04-reflection.md)

**Why this pattern**: Agent prompts must be AI-optimizable. The Reflection pattern provides the generator-critic loop for prompt quality improvement (p. 61). A Prompt Optimizer agent generates prompt variants, a Critic agent evaluates them against quality rubrics, and the best variant is promoted.

**Variant selected**: Generator-Critic with multi-agent critic panel (p. 340)

**Key configuration decisions**:

- Separate critic prompt from generator (p. 68)
- Explicit, measurable quality criteria for the critic (p. 65)
- Maximum 3 iterations per optimization cycle (cost control)
- Quality score tracked across iterations; revert if score drops (p. 47)
- Multi-dimensional critique: task accuracy, prompt clarity, safety, cost efficiency

**Known failure modes addressed**:

- Infinite loop → hard max_iterations limit
- Sycophantic critique → adversarial framing in critic prompt
- Degradation → quality score regression detection

---

### A2A Communication (patterns/15-a2a-communication.md)

**Why this pattern**: Agent teams may be distributed across services. A2A provides the standardized HTTP protocol for inter-agent discovery and communication (p. 240).

**Variant selected**: Async polling + webhook callbacks for long-running tasks (p. 246)

**Key configuration decisions**:

- Every agent publishes an Agent Card at `/.well-known/agent.json` (p. 243)
- Task IDs are globally unique UUIDs (p. 245)
- mTLS + OAuth2 for production deployments (p. 248)
- Idempotent task submission for network retry safety (p. 246)
- Agent Cards version-stamped for capability evolution

**Known failure modes addressed**:

- Agent Card staleness → version cards; validate capabilities at runtime
- Orphaned tasks → TTL on task results + cleanup job
- Polling overload → webhook callbacks + exponential backoff

---

### Resource-Aware Optimization (patterns/16-resource-aware-optimization.md)

**Why this pattern**: Cost management is critical at scale. Dynamic model switching and contextual pruning ensure optimal cost-quality tradeoff (p. 255).

**Variant selected**: Critique-then-escalate (p. 259) + dynamic model switching (p. 257)

**Key configuration decisions**:

- Three model tiers: Flash/Haiku (simple), Pro/Sonnet (complex), Ultra/Opus (critical) (p. 257)
- Routing decision uses cheap model (p. 258)
- Contextual pruning before every LLM call (p. 262)
- Semantic caching with TTL (p. 264)
- Token budgets per agent and per team

**Known failure modes addressed**:

- Under-classification → default to upclassing on ambiguity (p. 259)
- Cache poisoning → TTL + similarity threshold for cache hits

---

### IAM & Access Control

**Why this subsystem**: A multi-tenant platform needs identity management, role-based access control, and audit trails. Without IAM, there is no tenant isolation, no permission enforcement, and no compliance posture.

**Key design decisions**:

- RBAC enforced via OPA (Open Policy Agent) for declarative, auditable policies
- Five role hierarchy: Platform Admin → Tenant Admin → Agent Developer → Operator → Viewer
- Agent-to-agent authentication uses mTLS + OAuth2 (p. 248)
- All access control decisions logged to immutable audit trail (p. 297)
- API keys scoped per-tenant, per-team, per-agent with rotation policies
- IAM integrates with Tool & MCP Manager's Least Privilege model (p. 288)

**Known failure modes addressed**:

- Privilege escalation → OPA policies evaluated on every request; role changes require HITL approval
- Cross-tenant data leakage → tenant ID injected into every query; row-level security in PostgreSQL
- API key compromise → automatic rotation, usage anomaly detection, instant revocation

---

### Agent Deployment Pipeline

**Why this subsystem**: Agents change frequently -- prompts get edited, tools get added, configurations shift. A CI/CD pipeline validates, evaluates, and deploys each change with rollback capability. Without this, prompt changes could degrade production quality undetected.

**Key design decisions**:

- Six-stage pipeline: Build → Validate → Evaluate → Stage → Canary → Production
- Canary deployment with gradual traffic ramp (1% → 5% → 25% → 50% → 100%)
- Auto-rollback triggered by metric degradation >10% from baseline (p. 305)
- HITL gate required before production promotion (p. 211)
- Pre-deployment validation includes evalset regression, safety checks, performance benchmarks
- Integration with Prompt Registry for version-controlled agent artifacts

**Known failure modes addressed**:

- Bad deployment → canary catches regressions before full rollout; instant rollback
- Eval regression → mandatory evalset pass before promotion (p. 312)
- Configuration drift → deployment manifests are version-controlled and immutable

---

### Event Bus

**Why this subsystem**: An event bus decouples the 19 subsystems, giving us async communication, event replay for debugging, and event sourcing for auditability. Without it, subsystems would need point-to-point integrations, creating a fragile dependency graph.

**Key design decisions**:

- NATS JetStream selected for at-least-once delivery, consumer groups, and event replay
- CloudEvents specification for standardized event envelopes with versioning
- Topic hierarchy: `platform.agents.*`, `platform.teams.*`, `platform.tools.*`, etc.
- Dead letter queues for failed event processing with alerting
- Event replay capability integrated with Replay & Debugging subsystem
- Backpressure with flow control to handle event bursts (p. 205)

**Known failure modes addressed**:

- Consumer lag → backpressure signals, consumer group rebalancing
- Event schema evolution → backward-compatible versioning with schema registry
- Message loss → at-least-once delivery with idempotent consumers (p. 246)

---

### Testing & Simulation

**Why this subsystem**: Agentic systems exhibit emergent behavior that is difficult to predict. Simulated users, tool mocking, chaos injection, and automated red-teaming are needed to validate agents before production (p. 298).

**Key design decisions**:

- AI-driven user simulators generate realistic multi-turn interactions
- Mock MCP servers simulate tool behavior without external dependencies
- Chaos testing injects failures (tool timeouts, LLM errors, rate limits) per Error Triad (p. 205)
- Automated red-team testing for prompt injection and jailbreak attempts (p. 298)
- Scenario-based testing with expected trajectory validation (p. 308)
- Coverage metrics: tool usage, conversation paths, error handling branches

**Known failure modes addressed**:

- Untested edge cases → chaos testing systematically explores failure modes
- Safety gaps → red-team automation runs before every deployment
- Mock/reality divergence → mock servers updated from production tool schemas

---

### Conversation & Session Management

**Why this subsystem**: AgentForge serves end users across multiple channels (REST, WebSocket, Slack, Telegram, web widgets). A conversation layer manages session state, handles multi-turn context, routes conversations to agents, and supports agent-to-human handoff (p. 210).

**Key design decisions**:

- Channel adapters abstract platform-specific APIs into a unified interface
- Conversation state machine: active → paused → waiting_human → escalated → terminated
- Agent-to-human handoff with context transfer (p. 210)
- SSE/WebSocket streaming for real-time typing indicators and token streaming
- Multi-turn context management integrates with Memory & Context Management subsystem (p. 148)
- User identity resolution maps external IDs to internal identities across channels

**Known failure modes addressed**:

- Session loss → session state persisted to Redis with PostgreSQL backup
- Handoff context loss → conversation history attached to handoff request
- Channel-specific failures → per-channel circuit breakers with fallback channels

---

### Replay & Debugging

**Why this subsystem**: When an agent produces unexpected behavior, operators need to replay the exact execution, step through decisions, and test alternative inputs. This subsystem provides time-travel debugging and AI-assisted root cause analysis (p. 65).

**Key design decisions**:

- Deterministic replay from recorded OpenTelemetry traces and event logs
- Time-travel: step forward/backward through agent execution steps
- What-if analysis: modify inputs at any step and re-execute
- AI-assisted root cause analysis using Reflection pattern (p. 65)
- Side-by-side comparison mode for pre/post prompt change analysis
- Breakpoints on tool calls, guardrail checks, or routing decisions

**Known failure modes addressed**:

- Non-deterministic replay → capture all random seeds, model responses, and timestamps
- Snapshot storage bloat → tiered retention (7d hot, 30d warm, 90d cold)
- Replay fidelity → mock external tools with recorded responses during replay

---

### Scheduling & Background Jobs

**Why this subsystem**: Many agentic workflows require scheduled execution (daily reports, periodic analysis, data syncs) or event-triggered activation. A job scheduling subsystem enables agents to operate autonomously on defined schedules with priority management (p. 326).

**Key design decisions**:

- Four job types: cron-based, one-shot (delayed), event-triggered, interval-based
- Priority queues with preemption for critical jobs (p. 326)
- DAG-based job dependencies (job B after job A) using Planning pattern (p. 107)
- Distributed locking prevents duplicate execution across workers
- Concurrency control: max concurrent jobs per tenant, per team
- Retry with exponential backoff and dead letter queue (p. 206)

**Known failure modes addressed**:

- Missed schedule → persistent schedule store; job-missed detection and alerting
- Duplicate execution → distributed locks with Redis; idempotent job handlers
- Worker crash → heartbeat monitoring; orphaned job detection and reassignment

---

### Multi-Provider LLM Management

**Why this subsystem**: AgentForge must not be locked into a single LLM provider. An LLM gateway abstracts Anthropic, OpenAI, Google, and open-source models behind a common interface, handling routing, failover, and cost optimization (p. 257).

**Key design decisions**:

- Single `LLMGateway` abstraction over all providers with normalized request/response
- Three-tier model routing: Flash/Haiku (simple) → Pro/Sonnet (complex) → Ultra/Opus (critical) (p. 257)
- Automatic failover to alternative provider on errors or rate limits (p. 208)
- API key pools per provider with rotation, usage tracking, rate limit awareness
- Common streaming interface (SSE) across all providers
- Semantic caching layer to avoid redundant LLM calls (p. 264)
- Per-request cost tracking integrated with Cost & Resource Manager

**Known failure modes addressed**:

- Provider outage → automatic failover chain with health-based routing
- Rate limiting → API key pool rotation; queue-based request smoothing
- Cost spike → budget enforcement with configurable hard/soft limits per tenant

---

## Consequences

### Positive

- **Layered safety**: Six defense layers plus dedicated guardrail agents reduce the chance of any single bypass
- **Observability**: Every interaction, decision, and tool call is traced and auditable
- **Self-improving prompts**: Reflection-based optimization feeds back into prompt quality over time
- **Flexible orchestration**: Hierarchical supervisor topology supports both simple and complex team configurations
- **Standardized tooling**: MCP gives agents reusable, discoverable tool definitions
- **Cost control**: Dynamic model routing avoids using expensive models for simple tasks
- **Interoperability**: A2A protocol allows cross-framework, cross-team agent communication

### Negative / Risks

- **Complexity** (Severity: High) — Hierarchical multi-agent + guardrail layer adds significant system complexity
- **Latency overhead** (Severity: Medium) — Guardrail checks, routing decisions, and validation add per-request latency
- **Cost of observability** (Severity: Medium) — Logging every interaction consumes storage and processing
- **Guardrail false positives** (Severity: Medium) — Overly aggressive guardrails may block legitimate agent actions
- **Prompt optimization risk** (Severity: Low) — AI-optimized prompts may drift from intended behavior

### Mitigations

- Complexity → per-subsystem design docs, modular architecture, independent subsystem testing
- Latency → async guardrail checks where possible, cheap models for routing/classification
- Observability cost → tiered log retention, sampling for low-value events, log compression
- Guardrail FP → calibrate against legitimate request set, track FP rate, human review of blocked actions
- Prompt drift → version control with rollback, human approval gate on prompt promotions

---

## Tool Access Matrix

| Agent | Tools | Justification |
|-------|-------|---------------|
| Platform Orchestrator | `route_request`, `team_registry`, `user_context` | Routes requests; no write tools (p. 288) |
| Team Supervisor | `agent_registry`, `task_dispatcher`, `state_manager` | Coordinates team; no direct tool execution |
| Worker Agent (per-team) | Team-specific MCP tools only | Least Privilege: only tools needed for assigned task (p. 288) |
| Guardrail Agent | `policy_evaluator`, `alert_emitter`, `intervention_gate` | Read-only on agent actions + alert write (p. 288) |
| Prompt Optimizer | `prompt_registry`, `eval_runner`, `quality_scorer` | Read/write prompts, run evaluations |
| Code Generation Agent | `code_executor` (sandboxed), `test_runner`, `linter` | Sandboxed execution only (p. 288) |
| Observability Agent | `log_reader`, `metric_aggregator`, `alert_manager` | Read logs, write alerts (p. 288) |
| Deployment Agent | `prompt_registry` (read), `eval_runner`, `canary_controller`, `rollback_trigger` | Orchestrates deployment pipeline; no direct production writes without HITL (p. 211) |
| IAM Policy Agent | `opa_policy_engine` (read), `audit_logger`, `permission_resolver` | Read-only policy evaluation + audit logging (p. 288) |
| Scheduling Agent | `job_scheduler`, `event_trigger_manager`, `worker_pool` | Manages scheduled agent executions; scoped to tenant jobs (p. 288) |
| Replay Agent | `trace_reader`, `snapshot_store` (read), `what_if_executor` | Read-only on traces/snapshots; write only for what-if sandbox (p. 288) |
| Conversation Router | `channel_adapter`, `session_store`, `handoff_controller` | Routes conversations; no access to agent internal tools (p. 288) |
| LLM Gateway Agent | `provider_registry`, `model_router`, `api_key_pool`, `cost_tracker` | Manages LLM routing; no access to business logic tools (p. 288) |

---

## Memory Design

| Data Type | Scope | Storage | TTL |
|-----------|-------|---------|-----|
| Conversation history | Session | In-memory | Session end |
| Agent state (intermediate results) | `temp:` | Session store | Session end |
| User preferences | `user:` | Persistent DB | 90 days |
| Prompt versions | `app:` | Version-controlled DB | Indefinite |
| Team configurations | `app:` | Persistent DB | Indefinite |
| Tool/MCP registrations | `app:` | Persistent DB | Indefinite |
| Guardrail policies | `app:` | Persistent DB | Indefinite |
| Interaction logs | `app:` | Time-series DB | 30 days hot / 1 year cold |
| Eval results | `app:` | Persistent DB | 1 year |
| Agent knowledge (RAG) | `app:` | Vector store | Varies by source |
| Tenant/user identity | `app:` | PostgreSQL (IAM) | Indefinite |
| RBAC policies | `app:` | OPA policy store | Indefinite |
| Audit trail entries | `app:` | Immutable log (append-only) | 2 years (compliance) |
| API keys | `app:` | Encrypted vault | Until revocation |
| Deployment manifests | `app:` | Version-controlled DB | Indefinite |
| Canary metrics | `temp:` | Time-series DB | 30 days |
| Event bus messages | `app:` | NATS JetStream / Redis Streams | 7 days hot / 90 days cold |
| Dead letter entries | `app:` | Persistent queue | Until resolved |
| Test scenarios & results | `app:` | Persistent DB | 1 year |
| Chaos experiment logs | `app:` | Persistent DB | 90 days |
| Conversation sessions | `user:` | Redis + PostgreSQL | 24h active / 90 days archive |
| Channel adapter state | `temp:` | Redis | Session end |
| Execution snapshots | `app:` | Object store | 7d hot / 30d warm / 90d cold |
| Replay sessions | `temp:` | In-memory + Redis | 24 hours |
| Job schedules | `app:` | PostgreSQL | Indefinite |
| Job execution logs | `app:` | Time-series DB | 30 days |
| LLM provider registry | `app:` | PostgreSQL | Indefinite |
| API key pools | `app:` | Encrypted vault | Until rotation |
| LLM request/response cache | `temp:` | Redis (semantic cache) | TTL by volatility |

---

## Safety Boundaries

**Guardrail layers implemented** (per p. 286):

- [x] Input validation/sanitization — all user inputs validated before agent processing
- [x] Output filtering — agent outputs filtered before returning to users
- [x] Behavioral constraints (system prompt) — each agent has explicit behavioral rules
- [x] Tool use restrictions (Least Privilege) — per-agent tool assignment with justification
- [x] External moderation API — content safety classification on inputs and outputs
- [x] HITL escalation — human review for high-stakes actions

**Escalation triggers** (required per p. 211):

1. Guardrail agent detects policy violation on any team member
2. Agent confidence < 0.6 on critical decisions
3. Any irreversible action (data deletion, external API calls with side effects)
4. Token budget exceeded for a task
5. Agent loop detected (>N iterations without goal progress)
6. Code execution failure or security sandbox violation
7. IAM: Privilege escalation attempt detected (cross-tenant access, role change)
8. Deployment: Canary metrics degrade >10% from baseline during rollout
9. Conversation: Agent-to-human handoff requested by agent or user
10. Scheduling: Critical job fails after max retries exhausted
11. LLM: All providers in failover chain unavailable

**Irreversible actions requiring HITL approval**:

- Deploying agent prompts to production
- Granting new tool access to agents
- Executing generated code outside sandbox
- Modifying guardrail policies
- Deleting agent versions or team configurations
- Tenant creation or deletion (IAM)
- RBAC role hierarchy modifications (IAM)
- Production deployment promotion past canary stage (Deployment Pipeline)
- Event bus topic deletion or schema breaking changes (Event Bus)
- Scheduled job deletion for production agents (Scheduling)

---

## Evaluation Plan

**Metrics** (per p. 303):

- Accuracy target: >90% task completion rate per agent
- Latency target: P95 < 5s for agent response, P95 < 500ms for guardrail check
- Token budget: configurable per agent, per team, and per task
- Guardrail precision: <5% false positive rate on legitimate requests
- Prompt optimization: measurable quality improvement per optimization cycle

**Eval method**:

- [x] Evalset file — per-agent regression test suites
- [x] LLM-as-Judge rubric (dimensions: Clarity, Neutrality, Relevance, Completeness, Audience) (p. 306)
- [x] Trajectory evaluation — action sequence validation (p. 308)
- [x] Human eval — gold standard for guardrail calibration and prompt approval

**Baseline established**: Required before any agent goes to production

---

## Open Questions

1. **Prompt optimization governance**: What is the approval workflow for AI-optimized prompts? Fully automated, or human-in-the-loop approval gate?
2. **Code execution sandbox**: gVisor selected for production; Wasmtime under evaluation as lighter alternative. (Addressed in 21-runtime-deployment-environment.md)
3. **Multi-tenancy isolation**: Three-tier model — Namespace (standard), dedicated Node Pool (professional), dedicated cluster (enterprise). (Addressed in 13-iam-access-control.md and 21-runtime-deployment-environment.md)
4. **A2A vs. internal messaging**: **Resolved** — Intra-team: in-process ADK AgentTool (p. 133). Inter-team: A2A HTTP via Istio mTLS (p. 240). (Addressed in 21-runtime-deployment-environment.md)
5. **Guardrail agent model**: Should guardrail agents use the same model as the agents they monitor, or a different one to reduce bias?
6. **Event bus technology**: **Resolved** — NATS JetStream. (Addressed in 15-event-bus.md)
7. **Canary traffic granularity**: Should canary deployments split at the request level or at the user/session level? (Addressed in 14-agent-deployment-pipeline.md)
8. **Chaos testing in production**: Should chaos experiments be allowed in production environments with safeguards, or strictly limited to staging? (Addressed in 16-testing-simulation.md)
9. **Conversation history retention**: How long should full conversation transcripts be retained vs. summarized versions? (Addressed in 17-conversation-session-management.md)
10. **Replay storage costs**: What is the acceptable storage budget for execution snapshots? Tiered retention mitigates but needs sizing. (Addressed in 18-replay-debugging.md)
11. **LLM provider SLAs**: What minimum SLA should be required from LLM providers to be included in the provider registry? (Addressed in 20-multi-provider-llm-management.md)
12. **Agent framework**: **Resolved** — Google ADK as execution engine, wrapped by AgentForge `AgentRuntime` abstraction layer. (Addressed in 21-runtime-deployment-environment.md)
13. **Container orchestration**: **Resolved** — Kubernetes (EKS/GKE/AKS) with Helm + Argo Rollouts. (Addressed in 21-runtime-deployment-environment.md)
14. **Multi-region deployment**: Single-region in v1. Active-active multi-region deferred to v2.

---

## References

- Multi-Agent Collaboration: `patterns/07-multi-agent-collaboration.md` — p. 121-140
- Routing: `patterns/02-routing.md` — p. 21-40
- MCP: `patterns/10-mcp.md` — p. 155-165
- Guardrails/Safety: `patterns/18-guardrails-safety.md` — p. 285-301
- Evaluation & Monitoring: `patterns/19-evaluation-monitoring.md` — p. 301-320
- A2A Communication: `patterns/15-a2a-communication.md` — p. 240-260
- Tool Use: `patterns/05-tool-use.md` — p. 81-100
- Planning: `patterns/06-planning.md` — p. 101-120
- Memory Management: `patterns/08-memory-management.md` — p. 141-162
- Reflection: `patterns/04-reflection.md` — p. 61-80
- Learning & Adaptation: `patterns/09-learning-adaptation.md` — p. 163-180
- Goal Setting & Monitoring: `patterns/11-goal-setting-monitoring.md` — p. 183-200
- Exception Handling & Recovery: `patterns/12-exception-handling-recovery.md` — p. 201-220
- HITL: `patterns/13-hitl.md` — p. 207-220
- Resource-Aware Optimization: `patterns/16-resource-aware-optimization.md` — p. 255-275
- Prompt Chaining: `patterns/01-prompt-chaining.md` — p. 1-20
- Parallelization: `patterns/03-parallelization.md` — p. 41-60
- RAG: `patterns/14-rag.md` — p. 215-240
- Reasoning Techniques: `patterns/17-reasoning-techniques.md` — p. 265-285
- Prioritization: `patterns/20-prioritization.md` — p. 321-340
- Exploration & Discovery: `patterns/21-exploration-discovery.md` — p. 330-350
- PDF Evidence: "Agentic Design Patterns" (482 pages)

### Subsystem Design Documents

| # | Document | Lines |
|---|----------|-------|
| 00 | System Overview | 00-system-overview.md |
| 01 | Agent Builder | 01-agent-builder.md |
| 02 | Team Orchestrator | 02-team-orchestrator.md |
| 03 | Tool & MCP Manager | 03-tool-mcp-manager.md |
| 04 | Guardrail System | 04-guardrail-system.md |
| 05 | Observability Platform | 05-observability-platform.md |
| 06 | Code Generation Tools | 06-code-generation-tools.md |
| 07 | Prompt Registry | 07-prompt-registry.md |
| 08 | Evaluation Framework | 08-evaluation-framework.md |
| 09 | Cost & Resource Manager | 09-cost-resource-manager.md |
| 10 | Review Checklist Assessment | 10-review-checklist-assessment.md |
| 11 | Memory & Context Management | 11-memory-context-management.md |
| 12 | External Integrations Hub | 12-external-integrations-hub.md |
| 13 | IAM & Access Control | 13-iam-access-control.md |
| 14 | Agent Deployment Pipeline | 14-agent-deployment-pipeline.md |
| 15 | Event Bus | 15-event-bus.md |
| 16 | Testing & Simulation | 16-testing-simulation.md |
| 17 | Conversation & Session Mgmt | 17-conversation-session-management.md |
| 18 | Replay & Debugging | 18-replay-debugging.md |
| 19 | Scheduling & Background Jobs | 19-scheduling-background-jobs.md |
| 20 | Multi-Provider LLM Management | 20-multi-provider-llm-management.md |
| 21 | Runtime & Deployment Environment | 21-runtime-deployment-environment.md |
| 22 | Cost Analysis | 22-cost-analysis.md |
| 23 | Open-Source Technology Map | 23-open-source-technology-map.md |
