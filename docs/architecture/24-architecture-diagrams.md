# AgentForge — Architecture Diagrams

> Visual reference for the AgentForge Agentic Orchestration & Monitoring Platform.
> These diagrams complement the detailed subsystem design documents (01–21) and the master ADR (ADR-001).
>
> Each diagram is rendered natively by mkdocs-material. Click on any diagram to open it in a zoomable fullscreen view.

## Table of Contents

1. [High-Level Platform Overview](#1-high-level-platform-overview)
2. [Subsystem Architecture Map](#2-subsystem-architecture-map)
3. [Hierarchical Supervisor Topology](#3-hierarchical-supervisor-topology)
4. [Request Processing Flow](#4-request-processing-flow)
5. [Communication Protocols](#5-communication-protocols)
6. [Core Subsystems Detail](#6-core-subsystems-detail)
7. [Infrastructure Layer Detail](#7-infrastructure-layer-detail)
8. [User-Facing Layer Detail](#8-user-facing-layer-detail)
9. [Security Defense-in-Depth](#9-security-defense-in-depth)
10. [K8s Deployment Topology](#10-k8s-deployment-topology)
11. [Data Flow & Storage](#11-data-flow--storage)
12. [CI/CD Pipeline](#12-cicd-pipeline)
13. [Multi-Tenancy Isolation](#13-multi-tenancy-isolation)
14. [Prompt Lifecycle](#14-prompt-lifecycle)
15. [LLM Routing & Model Selection](#15-llm-routing--model-selection)

---

## 1. High-Level Platform Overview

External actors, the AgentForge platform boundary, and external systems it depends on.
```mermaid
graph TD
    subgraph Actors["External Actors"]
        U["👤 End Users<br/><small>REST · WebSocket · Slack · Telegram</small>"]
        AD["👤 Agent Developers<br/><small>Build & configure agents</small>"]
        PA["👤 Platform Admins<br/><small>Tenant & infra management</small>"]
        HR["👤 HITL Reviewers<br/><small>Approve prompts, deploys, escalations</small>"]
    end

    subgraph AgentForge["AgentForge Platform"]
        direction TB
        GW["API Gateway"]
        PO["Platform Orchestrator<br/><small>Level 0 — LLM Routing</small>"]
        TS["Team Supervisors<br/><small>Level 1 — Task Decomposition</small>"]
        WA["Worker Agents<br/><small>Level 2 — Tool Execution</small>"]
        GR["Guardrail Agents<br/><small>Cross-cutting — Policy Enforcement</small>"]
        OBS["Observability Platform<br/><small>OpenTelemetry Traces & Metrics</small>"]
        EB["Event Bus<br/><small>NATS JetStream</small>"]
    end

    subgraph External["External Systems"]
        LLM["LLM Providers<br/><small>Anthropic · OpenAI · Google</small>"]
        TOOLS["External APIs & Tools<br/><small>via MCP Protocol</small>"]
        CLOUD["Cloud Infrastructure<br/><small>AWS / GCP / Azure · K8s</small>"]
        VAULT["Secret Management<br/><small>HashiCorp Vault</small>"]
        DATA["Data Stores<br/><small>PostgreSQL · Redis · Qdrant</small>"]
    end

    U -->|"Requests"| GW
    AD -->|"Agent configs"| GW
    PA -->|"Admin ops"| GW
    HR -->|"Approvals"| GW
    GW --> PO
    PO --> TS
    TS --> WA
    GR -.->|"monitors"| PO
    GR -.->|"monitors"| TS
    GR -.->|"monitors"| WA
    WA -->|"LLM calls"| LLM
    WA -->|"Tool calls (MCP)"| TOOLS
    AgentForge -->|"Runs on"| CLOUD
    AgentForge -->|"Secrets"| VAULT
    AgentForge -->|"Persists"| DATA
    OBS -->|"Dashboards"| PA

    classDef actor fill:#3498DB,stroke:#2471A3,color:#fff
    classDef platform fill:#1ABC9C,stroke:#148F77,color:#fff
    classDef external fill:#95A5A6,stroke:#7F8C8D,color:#fff
    classDef guardrail fill:#E74C3C,stroke:#C0392B,color:#fff

    class U,AD,PA,HR actor
    class GW,PO,TS,WA,OBS,EB platform
    class GR guardrail
    class LLM,TOOLS,CLOUD,VAULT,DATA external
```
---

## 2. Subsystem Architecture Map

All 20 subsystems grouped by category. Foundational services (zero inter-dependencies) are started first; all other subsystems depend on them.
```mermaid
graph LR
    subgraph Foundational["Foundational Services<br/><small>Zero inter-dependencies · Started first</small>"]
        direction TB
        S05["#5 Observability<br/>Platform"]
        S13["#13 IAM &<br/>Access Control"]
        S15["#15 Event Bus"]
        S20["#20 Multi-Provider<br/>LLM Mgmt"]
    end

    subgraph Core["Core Subsystems"]
        direction TB
        S01["#1 Agent<br/>Builder"]
        S02["#2 Team<br/>Orchestrator"]
        S03["#3 Tool &<br/>MCP Manager"]
        S04["#4 Guardrail<br/>System"]
        S06["#6 Code Gen<br/>Tools"]
        S07["#7 Prompt<br/>Registry"]
        S08["#8 Evaluation<br/>Framework"]
        S09["#9 Cost &<br/>Resource Mgr"]
    end

    subgraph Infra["Infrastructure"]
        direction TB
        S11["#11 Memory &<br/>Context Mgmt"]
        S12["#12 External<br/>Integrations"]
        S14["#14 Deployment<br/>Pipeline"]
        S16["#16 Testing &<br/>Simulation"]
    end

    subgraph UserFacing["User-Facing"]
        direction TB
        S17["#17 Conversation<br/>& Session"]
        S18["#18 Replay &<br/>Debugging"]
        S19["#19 Scheduling<br/>& Jobs"]
    end

    subgraph Runtime["Runtime"]
        S21["#21 Runtime &<br/>Deployment Env<br/><small>ADK · K8s · Istio</small>"]
    end

    %% Core internal dependencies
    S01 --> S07
    S01 --> S08
    S02 --> S01
    S02 --> S03
    S02 --> S04
    S07 --> S08
    S14 --> S07
    S14 --> S08

    %% Cross-group dependencies
    S17 --> S02
    S18 --> S05
    S19 --> S15
    S06 --> S04
    S11 --> S03
    S12 --> S03
    S16 --> S08

    %% All depend on foundational
    Core -.-> Foundational
    Infra -.-> Foundational
    UserFacing -.-> Foundational

    classDef core fill:#4A90D9,stroke:#2C5F8A,color:#fff
    classDef infra fill:#7B68EE,stroke:#5A4FCF,color:#fff
    classDef userFacing fill:#2ECC71,stroke:#1FA855,color:#fff
    classDef foundational fill:#F39C12,stroke:#D68910,color:#fff
    classDef runtime fill:#E67E22,stroke:#CA6F1E,color:#fff

    class S01,S02,S03,S04,S06,S07,S08,S09 core
    class S11,S12,S14,S16 infra
    class S17,S18,S19 userFacing
    class S05,S13,S15,S20 foundational
    class S21 runtime
```
---

## 3. Hierarchical Supervisor Topology

Three-level agent hierarchy (p. 133) with Guardrail Agents monitoring every level via `before_tool_callback`.

- **Solid thick arrows** = inter-team A2A HTTP (~100ms, mTLS)
- **Solid thin arrows** = intra-team AgentTool (~10ms, in-process)
- **Dotted arrows** = guardrail observation
```mermaid
graph TD
    subgraph Level0["Level 0 — Platform Orchestrator"]
        PO["Platform Orchestrator<br/><small>LlmAgent · Flash/Haiku model<br/>Routes to teams</small>"]
    end

    subgraph Level1["Level 1 — Team Supervisors"]
        TA["Team Alpha Supervisor<br/><small>LoopAgent · Task decomposition</small>"]
        TB["Team Beta Supervisor<br/><small>LoopAgent · Task decomposition</small>"]
        TC["Team Gamma Supervisor<br/><small>LoopAgent · Task decomposition</small>"]
    end

    subgraph Level2A["Team Alpha Workers"]
        A1["Worker A1<br/><small>LlmAgent + MCPToolset</small>"]
        A2["Worker A2<br/><small>LlmAgent + MCPToolset</small>"]
        A3["Worker A3<br/><small>LlmAgent + MCPToolset</small>"]
    end

    subgraph Level2B["Team Beta Workers"]
        B1["Worker B1<br/><small>LlmAgent + MCPToolset</small>"]
        B2["Worker B2<br/><small>LlmAgent + MCPToolset</small>"]
    end

    subgraph Level2C["Team Gamma Workers"]
        C1["Worker C1<br/><small>LlmAgent + MCPToolset</small>"]
        C2["Worker C2<br/><small>LlmAgent + MCPToolset</small>"]
        C3["Worker C3<br/><small>LlmAgent + MCPToolset</small>"]
    end

    subgraph Guardrails["Guardrail Agents"]
        GG["Global Guardrail<br/><small>Observes Level 0</small>"]
        GA["Team-A Guardrail<br/><small>Observes Level 1+2</small>"]
        GB["Team-B Guardrail<br/><small>Observes Level 1+2</small>"]
        GC["Team-C Guardrail<br/><small>Observes Level 1+2</small>"]
    end

    PO ==>|"A2A HTTP<br/>mTLS ~100ms"| TA
    PO ==>|"A2A HTTP<br/>mTLS ~100ms"| TB
    PO ==>|"A2A HTTP<br/>mTLS ~100ms"| TC

    TA -->|"AgentTool<br/>in-process ~10ms"| A1
    TA -->|"AgentTool"| A2
    TA -->|"AgentTool"| A3

    TB -->|"AgentTool"| B1
    TB -->|"AgentTool"| B2

    TC -->|"AgentTool"| C1
    TC -->|"AgentTool"| C2
    TC -->|"AgentTool"| C3

    GG -.->|"before_tool_callback"| PO
    GA -.->|"before_tool_callback"| TA
    GA -.->|"before_tool_callback"| A1
    GA -.->|"before_tool_callback"| A2
    GA -.->|"before_tool_callback"| A3
    GB -.-> TB
    GB -.-> B1
    GB -.-> B2
    GC -.-> TC
    GC -.-> C1
    GC -.-> C2
    GC -.-> C3

    classDef orchestrator fill:#1A5276,stroke:#154360,color:#fff
    classDef supervisor fill:#2874A6,stroke:#1B4F72,color:#fff
    classDef worker fill:#3498DB,stroke:#2471A3,color:#fff
    classDef guardrail fill:#E74C3C,stroke:#C0392B,color:#fff

    class PO orchestrator
    class TA,TB,TC supervisor
    class A1,A2,A3,B1,B2,C1,C2,C3 worker
    class GG,GA,GB,GC guardrail
```
---

## 4. Request Processing Flow

End-to-end sequence from user request to response, including guardrail checks, tool calls, and async telemetry.
```mermaid
sequenceDiagram
    autonumber
    actor User
    participant GW as API Gateway
    participant IV as Input Validator
    participant PO as Platform Orchestrator<br/>Level 0
    participant TS as Team Supervisor<br/>Level 1
    participant WA as Worker Agent<br/>Level 2
    participant GR as Guardrail Agent
    participant MCP as MCP Server
    participant OF as Output Filter
    participant OBS as Observability
    participant EF as Eval Framework

    User->>GW: HTTP / WebSocket request
    GW->>IV: Validate & sanitize
    IV->>PO: Cleaned request

    Note over PO: LLM routing<br/>(Flash/Haiku model)

    PO->>TS: Dispatch to team (A2A HTTP + mTLS)

    Note over TS: Task decomposition<br/>via Planning pattern

    loop For each plan step
        TS->>WA: Delegate subtask (AgentTool in-process)
        WA->>GR: before_tool_callback
        alt Compliant
            GR-->>WA: Allow
            WA->>MCP: Tool call (HTTP+SSE)
            MCP-->>WA: Tool result
        else Violation
            GR-->>WA: Block
            WA-->>TS: Blocked — escalate
        end
        WA-->>TS: Subtask result
    end

    Note over TS: Aggregate &<br/>validate results

    TS-->>PO: Team result (A2A HTTP)
    PO->>OF: Sanitize output (PII redaction)
    OF-->>GW: Clean response
    GW-->>User: Final response

    par Async telemetry
        OBS--)OBS: Log all spans & metrics
    and Async evaluation
        EF--)EF: Score interaction quality
    end
```
---

## 5. Communication Protocols

Three communication patterns used by the platform: intra-team (in-process), inter-team (A2A HTTP), and agent-to-tool (MCP).
```mermaid
graph LR
    subgraph IntraTeam["Intra-Team Communication<br/><small>In-process · ~10ms · No serialization</small>"]
        direction TB
        SUP["Team Supervisor<br/><small>ADK LoopAgent</small>"]
        W1["Worker A1<br/><small>LlmAgent</small>"]
        W2["Worker A2<br/><small>LlmAgent</small>"]
        W3["Worker A3<br/><small>LlmAgent</small>"]
        SUP -->|"AgentTool<br/>function call"| W1
        SUP -->|"AgentTool<br/>function call"| W2
        SUP -->|"AgentTool<br/>function call"| W3
        MEM["Shared Memory<br/><small>temp: · agent: · team:</small>"]
        W1 <--> MEM
        W2 <--> MEM
        W3 <--> MEM
    end

    subgraph InterTeam["Inter-Team Communication<br/><small>A2A HTTP · ~100ms · mTLS + OAuth2</small>"]
        direction TB
        POD_A["Team Alpha Pod<br/><small>/.well-known/agent.json</small>"]
        POD_B["Team Beta Pod<br/><small>/.well-known/agent.json</small>"]
        POD_C["Team Gamma Pod<br/><small>/.well-known/agent.json</small>"]
        ISTIO["Istio Service Mesh<br/><small>mTLS · Traffic Splitting</small>"]
        POD_A <-->|"A2A HTTP/2"| ISTIO
        POD_B <-->|"A2A HTTP/2"| ISTIO
        POD_C <-->|"A2A HTTP/2"| ISTIO
        STATES["Task States<br/><small>submitted → working →<br/>completed / failed</small>"]
    end

    subgraph AgentTool["Agent-to-Tool Communication<br/><small>MCP Protocol · Least Privilege</small>"]
        direction TB
        AGENT["Worker Agent"]
        DEV_MCP["Dev: STDIO subprocess<br/><small>In Team Pod · No network</small>"]
        PROD_MCP["Prod: HTTP+SSE<br/><small>K8s Deployment · HPA-scaled</small>"]
        AGENT -->|"MCP request"| DEV_MCP
        AGENT -->|"MCP request"| PROD_MCP
        PROD_MCP --> HPA["HPA 2-10 replicas"]
    end

    classDef comm fill:#3498DB,stroke:#2471A3,color:#fff
    classDef mesh fill:#9B59B6,stroke:#7D3C98,color:#fff
    classDef mcp fill:#2ECC71,stroke:#1FA855,color:#fff

    class SUP,W1,W2,W3,MEM comm
    class POD_A,POD_B,POD_C,ISTIO,STATES mesh
    class AGENT,DEV_MCP,PROD_MCP,HPA mcp
```
---

## 6. Core Subsystems Detail

Internal components and cross-dependencies of the five most critical core subsystems.
```mermaid
graph TD
    subgraph AB["#1 Agent Builder"]
        AB1["Agent Definition Store<br/><small>Immutable versioned records</small>"]
        AB2["Prompt Optimizer<br/><small>Reflection loop: Generator + Critic</small>"]
        AB3["Lifecycle State Machine<br/><small>draft → review → staged → production</small>"]
        AB1 --> AB2
        AB2 --> AB3
    end

    subgraph TO["#2 Team Orchestrator"]
        TO1["Team Definition Store<br/><small>Topology · Agent roster · Rules</small>"]
        TO2["Planning Engine<br/><small>LLM-driven task decomposition</small>"]
        TO3["Parallel Executor<br/><small>asyncio.gather for subtasks</small>"]
        TO4["Result Aggregator<br/><small>Merge · Validate · Format</small>"]
        TO1 --> TO2 --> TO3 --> TO4
    end

    subgraph TM["#3 Tool & MCP Manager"]
        TM1["MCP Server Registry<br/><small>STDIO + HTTP+SSE transports</small>"]
        TM2["Tool Catalog<br/><small>Discovery · Descriptions · Schemas</small>"]
        TM3["Permission Resolver<br/><small>Least Privilege enforcement</small>"]
        TM4["Health Monitor<br/><small>Probes · Circuit breaker</small>"]
        TM1 --> TM2 --> TM3
        TM1 --> TM4
    end

    subgraph GS["#4 Guardrail System"]
        GS1["Policy Registry<br/><small>Declarative safety rules</small>"]
        GS2["Guardrail Agents<br/><small>Global · Team · Worker level</small>"]
        GS3["Monitoring Pipeline<br/><small>before_tool_callback</small>"]
        GS4["HITL Escalation<br/><small>Async human review queue</small>"]
        GS1 --> GS2 --> GS3
        GS3 -->|"violation"| GS4
    end

    subgraph OB["#5 Observability Platform"]
        OB1["OTel Collector<br/><small>Non-blocking telemetry</small>"]
        OB2["Trace Store<br/><small>Jaeger / Tempo</small>"]
        OB3["Metrics Store<br/><small>Prometheus</small>"]
        OB4["Dashboards<br/><small>Grafana</small>"]
        OB5["Alerting System<br/><small>Threshold · Anomaly · Composite</small>"]
        OB1 --> OB2
        OB1 --> OB3
        OB2 --> OB4
        OB3 --> OB4
        OB3 --> OB5
    end

    %% Cross-subsystem dependencies
    AB -->|"prompt refs"| PR["#7 Prompt Registry"]
    AB -->|"eval signal"| EF["#8 Evaluation Framework"]
    TO -->|"tool requests"| TM
    TO -->|"policy checks"| GS
    GS -->|"alerts"| OB
    TM -->|"tool metrics"| OB

    classDef core fill:#4A90D9,stroke:#2C5F8A,color:#fff
    classDef dep fill:#85C1E9,stroke:#5DADE2,color:#333

    class AB1,AB2,AB3,TO1,TO2,TO3,TO4,TM1,TM2,TM3,TM4,GS1,GS2,GS3,GS4,OB1,OB2,OB3,OB4,OB5 core
    class PR,EF dep
```
---

## 7. Infrastructure Layer Detail

Memory model (4 layers), IAM, Event Bus (NATS JetStream), and 6-stage Deployment Pipeline.
```mermaid
graph TD
    subgraph MEM["#11 Memory & Context Management"]
        M1["Layer 1: Session Memory<br/><small>temp: · In-process · Per-turn</small>"]
        M2["Layer 2: Working Memory<br/><small>agent: team: · Redis · Cross-turn</small>"]
        M3["Layer 3: Long-Term Memory<br/><small>user: app: · PostgreSQL · Cross-session</small>"]
        M4["Layer 4: Knowledge Memory<br/><small>knowledge: · Vector Store · RAG</small>"]
        M5["Context Optimizer<br/><small>Pruning · Summarization · Windowing</small>"]
        M6["RAG Engine<br/><small>Embedding · Retrieval · Hybrid Search</small>"]
        M1 --> M2 --> M3 --> M4
        M5 -.-> M2
        M5 -.-> M3
        M6 -.-> M4
    end

    subgraph IAM["#13 IAM & Access Control"]
        I1["Tenant Manager<br/><small>3-tier isolation provisioning</small>"]
        I2["RBAC / OPA Engine<br/><small>6 roles · Policy evaluation</small>"]
        I3["API Key Manager<br/><small>Generation · Rotation · Scoping</small>"]
        I4["Auth & Session Layer<br/><small>JWT · mTLS · OAuth2</small>"]
        I5["Audit Trail<br/><small>Immutable · Append-only · Hash-chained</small>"]
        I1 --> I2 --> I3
        I2 --> I4
        I4 --> I5
    end

    subgraph EVT["#15 Event Bus"]
        E1["NATS JetStream Cluster<br/><small>3 nodes · At-least-once</small>"]
        E2["Topic Hierarchy<br/><small>agent.* · team.* · guardrail.*<br/>tool.* · deployment.* · eval.*</small>"]
        E3["Consumer Groups<br/><small>Partition ordering · Backpressure</small>"]
        E4["Schema Registry<br/><small>CloudEvents · Versioned schemas</small>"]
        E5["Dead Letter Queue<br/><small>Failed events · Reprocessing</small>"]
        E6["Event Replay<br/><small>Time-range · Type · Consumer replay</small>"]
        E1 --> E2 --> E3
        E1 --> E4
        E3 --> E5
        E1 --> E6
    end

    subgraph DEP["#14 Deployment Pipeline"]
        D1["Artifact Builder<br/><small>Immutable snapshot assembly</small>"]
        D2["Validate<br/><small>Schema · Refs · Deps</small>"]
        D3["Evaluate<br/><small>Evalset regression · Red-team</small>"]
        D4["Stage<br/><small>Blue-green · Smoke tests</small>"]
        D5["Canary<br/><small>1% → 5% → 25% → 50% → 100%</small>"]
        D6["Production<br/><small>Full rollout</small>"]
        D7["Rollback Controller<br/><small>less than 60s recovery SLA</small>"]
        D1 --> D2 --> D3 --> D4 --> D5 --> D6
        D5 -->|"degradation >10%"| D7
        D7 -->|"revert"| D4
    end

    classDef mem fill:#2ECC71,stroke:#1FA855,color:#fff
    classDef iam fill:#9B59B6,stroke:#7D3C98,color:#fff
    classDef evt fill:#E67E22,stroke:#CA6F1E,color:#fff
    classDef pipeline fill:#3498DB,stroke:#2471A3,color:#fff

    class M1,M2,M3,M4,M5,M6 mem
    class I1,I2,I3,I4,I5 iam
    class E1,E2,E3,E4,E5,E6 evt
    class D1,D2,D3,D4,D5,D6,D7 pipeline
```
---

## 8. User-Facing Layer Detail

Conversation & Session Management, Replay & Debugging, and Scheduling & Background Jobs.
```mermaid
graph TD
    subgraph CONV["#17 Conversation & Session Management"]
        C1["Channel Adapters<br/><small>REST · WebSocket · Slack · Telegram · Widget</small>"]
        C2["Message Normalizer<br/><small>Canonical message model</small>"]
        C3["Session Manager<br/><small>Create · Active · Paused · Closed</small>"]
        C4["Conversation Router<br/><small>LLM-based intent classification</small>"]
        C5["Handoff Controller<br/><small>Agent → Human escalation</small>"]
        C6["Stream Emitter<br/><small>SSE / WebSocket token streaming</small>"]
        C1 --> C2 --> C3
        C3 --> C4
        C3 --> C5
        C4 --> C6
    end

    subgraph REPLAY["#18 Replay & Debugging"]
        R1["Execution Record Store<br/><small>OTel traces · State snapshots</small>"]
        R2["Replay Engine<br/><small>Deterministic step playback</small>"]
        R3["Time-Travel Debugger<br/><small>Rewind · Forward · State inspect</small>"]
        R4["What-If Analyzer<br/><small>Fork · Mutate · Re-execute · Compare</small>"]
        R5["Breakpoint System<br/><small>Conditional breakpoints</small>"]
        R6["Root Cause Analyzer<br/><small>Critic agent · Fault localization</small>"]
        R1 --> R2 --> R3
        R2 --> R4
        R3 --> R5
        R2 --> R6
    end

    subgraph SCHED["#19 Scheduling & Background Jobs"]
        S1["Schedule Manager<br/><small>Cron · One-shot · Interval</small>"]
        S2["Event Trigger Manager<br/><small>Event Bus subscriptions</small>"]
        S3["Priority Job Queue<br/><small>P0-P3 · Consumer groups</small>"]
        S4["Job Execution Engine<br/><small>Worker pools · Concurrency control</small>"]
        S5["DAG Executor<br/><small>Dependencies · Fan-out · Fan-in</small>"]
        S6["Distributed Lock Manager<br/><small>Redis/etcd · Leader election</small>"]
        S7["Dead Letter Queue<br/><small>Failed jobs · Reprocessing</small>"]
        S1 --> S3
        S2 --> S3
        S3 --> S4 --> S5
        S4 --> S6
        S4 -->|"max retries exceeded"| S7
    end

    %% Cross-subsystem links
    CONV -->|"routes to"| TEAM["Team Orchestrator"]
    REPLAY -->|"reads from"| OBS["Observability Platform"]
    SCHED -->|"subscribes"| EVTBUS["Event Bus"]

    classDef conv fill:#2ECC71,stroke:#1FA855,color:#fff
    classDef replay fill:#1ABC9C,stroke:#148F77,color:#fff
    classDef sched fill:#16A085,stroke:#117A65,color:#fff
    classDef ext fill:#85C1E9,stroke:#5DADE2,color:#333

    class C1,C2,C3,C4,C5,C6 conv
    class R1,R2,R3,R4,R5,R6 replay
    class S1,S2,S3,S4,S5,S6,S7 sched
    class TEAM,OBS,EVTBUS ext
```
---

## 9. Security Defense-in-Depth

Seven-layer security model — each layer can independently block a request. Violations are logged and alerted at every layer.
```mermaid
graph TD
    IN["User Input"]

    subgraph L1["Layer 1 — Input Validation"]
        L1A["Sanitization<br/><small>XSS · SQL injection · encoding</small>"]
        L1B["PII Detection<br/><small>Regex + ML classifiers</small>"]
        L1C["Prompt Injection Detection<br/><small>Pattern matching · heuristics</small>"]
    end

    subgraph L2["Layer 2 — Behavioral Constraints"]
        L2A["System Prompt Rules<br/><small>Role boundaries · Forbidden actions</small>"]
        L2B["Agent Scope Limits<br/><small>max_iterations · timeout · model_tier</small>"]
    end

    subgraph L3["Layer 3 — Tool Restrictions"]
        L3A["Least Privilege Assignment<br/><small>Only required MCP tools</small>"]
        L3B["before_tool_callback<br/><small>Intercept every tool call</small>"]
        L3C["Input/Output Validation<br/><small>JSON Schema enforcement</small>"]
    end

    subgraph L4["Layer 4 — Guardrail Agents"]
        L4A["LLM Policy Evaluator<br/><small>Fast model for real-time check</small>"]
        L4B["Behavioral Analysis<br/><small>Pattern detection · Anomaly scoring</small>"]
        L4C["Jailbreak Detection<br/><small>Multi-turn attack tracking</small>"]
    end

    subgraph L5["Layer 5 — External Moderation"]
        L5A["Content Safety APIs<br/><small>Anthropic · OpenAI moderation</small>"]
        L5B["Custom Classifiers<br/><small>Domain-specific safety models</small>"]
    end

    subgraph L6["Layer 6 — Output Filtering"]
        L6A["PII Redaction<br/><small>SSN · credit card · email · phone</small>"]
        L6B["Format Validation<br/><small>Output schema compliance</small>"]
        L6C["Safety Check<br/><small>Final content safety scan</small>"]
    end

    subgraph L7["Layer 7 — HITL Escalation"]
        L7A["Human Review Queue<br/><small>High-stakes decision approval</small>"]
        L7B["24h Timeout<br/><small>Default-deny on expiry</small>"]
    end

    OUT["User Output"]

    BLOCK["Block / Alert / Log"]

    IN --> L1
    L1 --> L2
    L2 --> L3
    L3 --> L4
    L4 --> L5
    L5 --> L6
    L6 --> L7
    L7 --> OUT

    L1 -->|"violation"| BLOCK
    L2 -->|"violation"| BLOCK
    L3 -->|"violation"| BLOCK
    L4 -->|"violation"| BLOCK
    L5 -->|"violation"| BLOCK
    L6 -->|"violation"| BLOCK

    classDef input fill:#2ECC71,stroke:#1FA855,color:#fff
    classDef layer fill:#3498DB,stroke:#2471A3,color:#fff
    classDef guardrail fill:#E74C3C,stroke:#C0392B,color:#fff
    classDef hitl fill:#8E44AD,stroke:#6C3483,color:#fff
    classDef output fill:#2ECC71,stroke:#1FA855,color:#fff
    classDef block fill:#C0392B,stroke:#922B21,color:#fff

    class IN input
    class L1A,L1B,L1C,L2A,L2B,L3A,L3B,L3C,L5A,L5B,L6A,L6B,L6C layer
    class L4A,L4B,L4C guardrail
    class L7A,L7B hitl
    class OUT output
    class BLOCK block
```
---

## 10. K8s Deployment Topology

Full Kubernetes cluster layout showing platform namespace, per-tenant namespaces, shared infrastructure, and data layer.
```mermaid
graph TD
    subgraph CLOUD["Cloud Provider — AWS EKS / GKE / Azure AKS"]
        INGRESS["Ingress / Istio Gateway<br/><small>TLS termination · Rate limiting</small>"]

        subgraph PLATFORM["Namespace: agentforge-platform"]
            APIGW["API Gateway<br/><small>FastAPI · 3 pods · HPA</small>"]
            PLORCH["Platform Orchestrator<br/><small>LlmAgent · 2 pods</small>"]
            IAMSVC["IAM Service<br/><small>OPA sidecar</small>"]
            LLMGW["LLM Gateway<br/><small>Multi-provider · 2-15 pods</small>"]
            PREG["Prompt Registry<br/><small>Git-backed · 2 pods</small>"]
        end

        subgraph TENANT["Namespace: tenant-{id}"]
            subgraph TEAMPOD["Team Pod — Supervisor + Workers in-process"]
                TSUP["Team Supervisor<br/><small>ADK LoopAgent</small>"]
                TW1["Worker 1<br/><small>LlmAgent + MCPToolset</small>"]
                TW2["Worker 2<br/><small>LlmAgent + MCPToolset</small>"]
            end
            GRPOD["Guardrail Pod<br/><small>Sidecar or dedicated</small>"]
            subgraph MCPPODS["MCP Server Pods"]
                MCP1["mcp-search<br/><small>Shared · HPA 2-10</small>"]
                MCP2["mcp-code<br/><small>Sandboxed · gVisor</small>"]
                MCP3["mcp-data<br/><small>Per-tenant · HPA 1-5</small>"]
                MCP4["mcp-comms<br/><small>Shared · HPA 2-10</small>"]
            end
        end

        subgraph SHARED["Shared Infrastructure"]
            NATS["NATS JetStream<br/><small>3-node cluster</small>"]
            PROM["Prometheus"]
            JAEGER["Jaeger / Tempo"]
            GRAFANA["Grafana"]
        end

        subgraph DATALAYER["Data Layer"]
            PG["PostgreSQL<br/><small>RDS / CloudSQL</small>"]
            REDIS["Redis Cluster"]
            CH["ClickHouse<br/><small>Time-series</small>"]
            QDRANT["Qdrant / pgvector<br/><small>Vector store</small>"]
            S3["S3 / GCS<br/><small>Object storage</small>"]
            VAULT["HashiCorp Vault<br/><small>Secrets</small>"]
        end
    end

    INGRESS --> APIGW
    APIGW --> PLORCH
    APIGW --> IAMSVC
    PLORCH ==>|"A2A HTTP<br/>mTLS"| TSUP
    TSUP --> TW1
    TSUP --> TW2
    GRPOD -.->|"monitors"| TEAMPOD
    TW1 --> MCP1
    TW1 --> MCP2
    TW2 --> MCP3
    PLORCH --> LLMGW
    PLORCH --> PREG

    TEAMPOD --> NATS
    TEAMPOD --> PG
    TEAMPOD --> REDIS
    LLMGW --> VAULT

    classDef platform fill:#1A5276,stroke:#154360,color:#fff
    classDef tenant fill:#2874A6,stroke:#1B4F72,color:#fff
    classDef shared fill:#7D3C98,stroke:#6C3483,color:#fff
    classDef data fill:#F39C12,stroke:#D68910,color:#fff
    classDef guardrail fill:#E74C3C,stroke:#C0392B,color:#fff

    class APIGW,PLORCH,IAMSVC,LLMGW,PREG platform
    class TSUP,TW1,TW2,MCP1,MCP2,MCP3,MCP4 tenant
    class NATS,PROM,JAEGER,GRAFANA shared
    class PG,REDIS,CH,QDRANT,S3,VAULT data
    class GRPOD guardrail
```
---

## 11. Data Flow & Storage

Data sources, storage systems (with what each stores), and downstream consumers.
```mermaid
graph LR
    subgraph Sources["Data Sources"]
        SRC1["User Requests"]
        SRC2["Agent Executions"]
        SRC3["Tool Calls"]
        SRC4["Guardrail Checks"]
        SRC5["Deployment Events"]
        SRC6["LLM Calls"]
        SRC7["Scheduled Jobs"]
    end

    subgraph Stores["Data Stores"]
        PG["PostgreSQL<br/><small>Agent defs · Team configs<br/>Prompt versions · RBAC<br/>Evalsets · Audit trail<br/>Job schedules · Tenant registry</small>"]
        REDIS["Redis Cluster<br/><small>Session state - temp:<br/>Working memory - agent: team:<br/>Semantic cache · Dist. locks<br/>WebSocket pub/sub</small>"]
        CH["ClickHouse<br/><small>Interaction logs<br/>Canary metrics<br/>Job execution logs<br/>Time-series metrics</small>"]
        VS["Vector Store<br/><small>RAG embeddings<br/>Semantic search indices<br/>Knowledge base</small>"]
        S3["Object Store S3/GCS<br/><small>Execution snapshots<br/>7d hot / 30d warm / 90d cold<br/>Large artifacts</small>"]
        NATS["NATS JetStream<br/><small>33 event types<br/>11 namespaces<br/>7d hot / 90d cold</small>"]
        VAULT["HashiCorp Vault<br/><small>API keys · LLM credentials<br/>mTLS certificates</small>"]
        OPA["OPA Policy Store<br/><small>RBAC policies - Rego<br/>Guardrail policies</small>"]
    end

    subgraph Consumers["Consumers"]
        GRAF["Grafana Dashboards"]
        REPLAY["Replay Engine"]
        EVAL["Evaluation Framework"]
        COST["Cost Tracker"]
        ALERT["Alerting System"]
    end

    SRC1 --> PG
    SRC1 --> REDIS
    SRC2 --> CH
    SRC2 --> S3
    SRC2 --> NATS
    SRC3 --> CH
    SRC3 --> NATS
    SRC4 --> PG
    SRC4 --> NATS
    SRC5 --> NATS
    SRC5 --> PG
    SRC6 --> CH
    SRC6 --> REDIS
    SRC7 --> PG
    SRC7 --> NATS

    PG --> EVAL
    PG --> COST
    CH --> GRAF
    CH --> ALERT
    S3 --> REPLAY
    NATS --> GRAF
    NATS --> ALERT
    VS --> EVAL
    REDIS --> GRAF

    classDef source fill:#3498DB,stroke:#2471A3,color:#fff
    classDef store fill:#F39C12,stroke:#D68910,color:#fff
    classDef consumer fill:#2ECC71,stroke:#1FA855,color:#fff

    class SRC1,SRC2,SRC3,SRC4,SRC5,SRC6,SRC7 source
    class PG,REDIS,CH,VS,S3,NATS,VAULT,OPA store
    class GRAF,REPLAY,EVAL,COST,ALERT consumer
```
---

## 12. CI/CD Pipeline

Six-stage agent deployment pipeline with validation gates, HITL approval, canary rollout, and auto-rollback.
```mermaid
graph LR
    SRC["Source<br/><small>Agent config + prompt<br/>+ tools + guardrails</small>"]

    subgraph Pipeline["Six-Stage Pipeline"]
        direction LR
        BUILD["1. Build<br/><small>Assemble immutable<br/>agent artifact</small>"]
        VALIDATE["2. Validate<br/><small>Schema conformance<br/>Ref resolution · Deps</small>"]
        EVALUATE["3. Evaluate<br/><small>Evalset regression<br/>Red-team suite<br/>LLM-as-Judge</small>"]
        STAGE["4. Stage<br/><small>Blue-green deploy<br/>Integration tests</small>"]
        CANARY["5. Canary<br/><small>1% → 5% → 25%<br/>→ 50% → 100%</small>"]
        PROD["6. Production<br/><small>Full traffic<br/>Monitoring active</small>"]
    end

    HITL{"HITL<br/>Approval"}
    ROLLBACK["Rollback<br/><small>less than 60s<br/>to known-good</small>"]
    REJECT["Reject"]

    SRC --> BUILD
    BUILD -->|"pass"| VALIDATE
    VALIDATE -->|"pass"| EVALUATE
    EVALUATE -->|"pass"| STAGE
    STAGE -->|"pass"| CANARY
    CANARY -->|"metrics OK"| HITL
    HITL -->|"approved"| PROD
    HITL -->|"denied"| REJECT

    VALIDATE -->|"fail"| REJECT
    EVALUATE -->|"fail"| REJECT
    STAGE -->|"fail"| REJECT
    CANARY -->|"degradation >10%"| ROLLBACK
    ROLLBACK --> STAGE

    %% Subsystem integrations
    PR["Prompt Registry"] -.-> BUILD
    EF["Eval Framework"] -.-> EVALUATE
    OBS["Observability"] -.-> CANARY

    classDef stage fill:#3498DB,stroke:#2471A3,color:#fff
    classDef gate fill:#F39C12,stroke:#D68910,color:#fff
    classDef fail fill:#E74C3C,stroke:#C0392B,color:#fff
    classDef ext fill:#85C1E9,stroke:#5DADE2,color:#333

    class BUILD,VALIDATE,EVALUATE,STAGE,CANARY,PROD stage
    class HITL gate
    class ROLLBACK,REJECT fail
    class PR,EF,OBS,SRC ext
```
---

## 13. Multi-Tenancy Isolation

Three isolation tiers with increasing security guarantees, plus four cross-tenant prevention layers.
```mermaid
graph TD
    subgraph Standard["Tier 1 — Standard"]
        ST1["Shared K8s Nodes"]
        ST2["Separate Namespace<br/><small>per tenant</small>"]
        ST3["ResourceQuota<br/><small>CPU / Memory limits</small>"]
        ST4["NetworkPolicy<br/><small>Deny-default ingress</small>"]
        ST5["Row-Level Security<br/><small>PostgreSQL tenant_id filter</small>"]
        ST1 --> ST2 --> ST3 --> ST4 --> ST5
    end

    subgraph Professional["Tier 2 — Professional"]
        PR1["Dedicated Node Pool<br/><small>per tenant</small>"]
        PR2["Separate Namespace"]
        PR3["Node Affinity<br/><small>Tenant workloads pinned</small>"]
        PR4["NetworkPolicy<br/><small>+ Node-level isolation</small>"]
        PR5["Data Isolation<br/><small>Separate Redis keyspace</small>"]
        PR1 --> PR2 --> PR3 --> PR4 --> PR5
    end

    subgraph Enterprise["Tier 3 — Enterprise"]
        EN1["Dedicated K8s Cluster<br/><small>per tenant</small>"]
        EN2["Full Process Isolation"]
        EN3["Separate Data Stores<br/><small>Dedicated PostgreSQL / Redis</small>"]
        EN4["Custom Compliance<br/><small>SOC2 · HIPAA · GDPR</small>"]
        EN5["Dedicated Vault Namespace"]
        EN1 --> EN2 --> EN3 --> EN4 --> EN5
    end

    subgraph Prevention["Cross-Tenant Prevention Layers"]
        direction LR
        P1["API Gateway<br/><small>Tenant ID extraction<br/>from credential</small>"]
        P2["Middleware<br/><small>TenantContextMiddleware<br/>Status validation</small>"]
        P3["Data Layer<br/><small>TenantScopedRepository<br/>WHERE tenant_id = ?</small>"]
        P4["Event Bus<br/><small>Namespaced channels<br/>events.tenant_id.*</small>"]
        P1 --> P2 --> P3 --> P4
    end

    classDef standard fill:#2ECC71,stroke:#1FA855,color:#fff
    classDef professional fill:#F39C12,stroke:#D68910,color:#fff
    classDef enterprise fill:#E74C3C,stroke:#C0392B,color:#fff
    classDef prevention fill:#3498DB,stroke:#2471A3,color:#fff

    class ST1,ST2,ST3,ST4,ST5 standard
    class PR1,PR2,PR3,PR4,PR5 professional
    class EN1,EN2,EN3,EN4,EN5 enterprise
    class P1,P2,P3,P4 prevention
```
---

## 14. Prompt Lifecycle

Version lifecycle from Draft to Production with AI-driven optimization loop (Reflection pattern, p. 61).
```mermaid
stateDiagram-v2
    [*] --> Draft: New prompt created

    Draft --> Review: Submit for review
    Review --> Draft: Rejected — revise

    Review --> Staged: Human approved (HITL)

    Staged --> Draft: Eval failed — revise
    Staged --> Production: Eval passed + HITL final approval

    Production --> RolledBack: Metric degradation >10%
    RolledBack --> Draft: Analyze and fix

    Production --> Deprecated: Newer version promoted
    Production --> Draft: AI Optimization Loop (Reflection)

    note right of Review
        HITL gate required.
        24h timeout = default-deny.
    end note

    note right of Staged
        Must pass evalset thresholds.
        Red-team suite mandatory.
    end note

    note left of Production
        Prompt Optimizer Agent
        proposes improvements via
        Reflection pattern (p. 61).
    end note
```
---

## 15. LLM Routing & Model Selection

Three-tier model routing with critique-then-escalate pattern, provider failover via circuit breaker, and semantic caching.
```mermaid
graph TD
    REQ["Incoming LLM Request"]
    CACHE{"Semantic<br/>Cache Hit?"}
    ROUTER["Complexity Router<br/><small>Tier-1 model classifies task</small>"]

    subgraph Tier1["Tier 1 — Fast/Cheap<br/><small>~$0.10-0.25/M input · less than 500ms</small>"]
        T1A["Claude Haiku"]
        T1B["Gemini Flash"]
        T1C["GPT-4o-mini"]
    end

    subgraph Tier2["Tier 2 — Balanced<br/><small>~$1-3/M input · less than 2s</small>"]
        T2A["Claude Sonnet"]
        T2B["Gemini Pro"]
        T2C["GPT-4o"]
    end

    subgraph Tier3["Tier 3 — Max Capability<br/><small>~$10-15/M input · less than 5s</small>"]
        T3A["Claude Opus"]
        T3B["Gemini Ultra"]
        T3C["GPT-o3"]
    end

    CRIT1{"Confidence<br/>≥ 0.8?"}
    CRIT2{"Confidence<br/>≥ 0.8?"}

    CB["Circuit Breaker<br/><small>Open → Fallback provider</small>"]
    KEYS["API Key Pool<br/><small>Multi-key rotation · Rate tracking</small>"]
    COST["Cost Tracker<br/><small>Per-request token accounting</small>"]
    RESULT["LLM Response"]

    REQ --> CACHE
    CACHE -->|"hit"| RESULT
    CACHE -->|"miss"| ROUTER
    ROUTER -->|"simple"| Tier1
    ROUTER -->|"complex"| Tier2
    ROUTER -->|"critical"| Tier3

    Tier1 --> CRIT1
    CRIT1 -->|"yes"| RESULT
    CRIT1 -->|"no — escalate"| Tier2

    Tier2 --> CRIT2
    CRIT2 -->|"yes"| RESULT
    CRIT2 -->|"no — escalate"| Tier3

    Tier3 --> RESULT

    Tier1 -.-> CB
    Tier2 -.-> CB
    Tier3 -.-> CB
    CB -.->|"failover"| KEYS

    RESULT --> COST

    classDef tier1 fill:#2ECC71,stroke:#1FA855,color:#fff
    classDef tier2 fill:#F39C12,stroke:#D68910,color:#fff
    classDef tier3 fill:#E74C3C,stroke:#C0392B,color:#fff
    classDef infra fill:#7B68EE,stroke:#5A4FCF,color:#fff
    classDef decision fill:#85C1E9,stroke:#5DADE2,color:#333

    class T1A,T1B,T1C tier1
    class T2A,T2B,T2C tier2
    class T3A,T3B,T3C tier3
    class CB,KEYS,COST infra
    class CACHE,CRIT1,CRIT2,ROUTER decision
```
