# Subsystem 15: Event Bus

## Contents

| # | Section | Description |
|---|---------|-------------|
| 1 | [Overview & Responsibility](#1-overview--responsibility) | Nervous-system mandate: decoupled async event routing across all subsystems |
| 2 | [Event Schema](#2-event-schema) | CloudEvents-based envelope with payload, routing, and tracing fields |
| 3 | [Event Catalog](#3-event-catalog) | Canonical registry of all platform event types and their producers/consumers |
| 4 | [Event Bus Architecture](#4-event-bus-architecture) | NATS JetStream topology, streams, and consumer groups |
| 5 | [Publishing API](#5-publishing-api) | Typed publish interface with schema validation and idempotency keys |
| 6 | [Subscription API](#6-subscription-api) | Consumer-group subscriptions with filtering, backpressure, and acknowledgement |
| 7 | [Delivery Guarantees](#7-delivery-guarantees) | At-least-once semantics, idempotency support, and ordering guarantees |
| 8 | [Dead Letter Queue](#8-dead-letter-queue) | DLQ capture, alerting, and reprocessing workflow for failed events |
| 9 | [Event Replay](#9-event-replay) | Replay historical events from any offset for recovery or debugging |
| 10 | [Event Schema Registry](#10-event-schema-registry) | Version-controlled schema store with backward-compatibility validation |
| 11 | [API Surface](#11-api-surface) | Management REST endpoints for streams, consumers, DLQ, and replay |
| 12 | [Failure Modes & Mitigations](#12-failure-modes--mitigations) | Broker unavailability, consumer lag, and DLQ overflow handling |
| 13 | [Instrumentation](#13-instrumentation) | Publish/consume latency, lag, DLQ depth, and replay metrics |
| 14 | [Cross-Subsystem Event Flow Examples](#14-cross-subsystem-event-flow-examples) | Concrete end-to-end event flows for key platform scenarios |

---

## 1. Overview & Responsibility

The Event Bus is the **nervous system** of the AgentForge Agentic Orchestration Platform. It provides a centralized, event-driven communication backbone that decouples all subsystems from direct point-to-point dependencies, enabling asynchronous, reliable, and auditable information flow across the entire platform.

Without the Event Bus, subsystems would need to know about each other's APIs, maintain client connections to every service they interact with, and handle failure propagation manually. With it, any subsystem can announce what happened (publish) and any interested subsystem can react (subscribe) -- without either side knowing about the other. This is the architectural pattern that transforms a collection of services into a cohesive, reactive platform.

The design follows the principle from Multi-Agent Collaboration (p. 127): avoid context explosion by using events instead of direct calls. Rather than agents and subsystems passing increasingly large payloads through synchronous chains, they emit compact, typed events that interested parties consume independently.

### Core Responsibilities

| # | Responsibility | Pattern Reference |
|---|---------------|-------------------|
| 1 | **Centralized Event Routing**: Route events from publishers to subscribers based on topic and filter criteria | A2A Communication (p. 240-246), Multi-Agent Collaboration (p. 127) |
| 2 | **Event Publishing API**: Provide a uniform interface for all subsystems to emit structured events | A2A Communication (p. 245 -- task state transitions as events) |
| 3 | **Event Subscription API**: Enable subsystems to consume events with filtering, consumer groups, and backpressure | A2A Communication (p. 246 -- webhook callbacks as delivery) |
| 4 | **Event Schema Registry**: Version, validate, and evolve event schemas with backward compatibility guarantees | Evaluation & Monitoring (p. 310 -- structured telemetry) |
| 5 | **Guaranteed Delivery**: At-least-once delivery semantics with idempotency support | Exception Handling (p. 205 -- error recovery strategies) |
| 6 | **Dead Letter Queue**: Capture and manage events that fail processing after all retry attempts | Exception Handling (p. 205 -- unrecoverable error handling) |
| 7 | **Event Replay**: Re-deliver historical events for debugging, recovery, and state reconstruction | Evaluation & Monitoring (p. 301 -- post-hoc analysis) |

### Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            Event Bus Subsystem                               │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                       Event Router (Core)                              │  │
│  │                                                                        │  │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐               │  │
│  │  │  Topic:       │  │  Topic:       │  │  Topic:       │    ...        │  │
│  │  │  agent.*      │  │  team.*       │  │  guardrail.*  │               │  │
│  │  │  (partitioned │  │  (partitioned │  │  (partitioned │               │  │
│  │  │   by agent_id)│  │   by team_id) │  │   by policy)  │               │  │
│  │  └──────┬────────┘  └──────┬────────┘  └──────┬────────┘               │  │
│  │         │                  │                  │                        │  │
│  │  ┌──────┴──────────────────┴──────────────────┴──────────────────────┐ │  │
│  │  │              Stream Engine (Redis Streams / NATS JetStream)       │ │  │
│  │  │  - Persistent message log    - Consumer group management          │ │  │
│  │  │  - At-least-once delivery    - Partition-ordered processing       │ │  │
│  │  │  - Configurable retention    - Backpressure handling              │ │  │
│  │  └───────────────────────────────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌──────────────────┐  ┌────────────────────┐  ┌───────────────────────┐     │
│  │ Schema Registry  │  │ Dead Letter Queue  │  │ Event Replay Engine   │     │
│  │                  │  │                    │  │                       │     │
│  │ - Schema store   │  │ - Failed events    │  │ - Time-range replay   │     │
│  │ - Version mgmt   │  │ - Retry scheduler  │  │ - Event-type replay   │     │
│  │ - Compatibility  │  │ - Manual review UI │  │ - Consumer replay     │     │
│  │ - Validation     │  │ - Alerting         │  │ - Idempotency guard   │     │
│  └──────────────────┘  └────────────────────┘  └───────────────────────┘     │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                    Instrumentation Layer                             │    │
│  │  - Publish latency    - Consumer lag    - DLQ depth                  │    │
│  │  - Event throughput   - Schema errors   - Replay operations          │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
         │                         │                         │
    ┌────┴─────────┐         ┌─────┴────────┐          ┌─────┴───────┐
    │  Publishers  │         │  Subscribers │          │  Admin API  │
    │  (all 14     │         │  (all 14     │          │  (ops team) │
    │  subsystems) │         │  subsystems) │          │             │
    └──────────────┘         └──────────────┘          └─────────────┘
```

### Relationship to Other Subsystems

| Subsystem | Integration Point |
|-----------|------------------|
| Agent Builder (01) | Publishes `agent.created`, `agent.deployed`, `agent.failed`; subscribes to `eval.regression_detected` for auto-rollback |
| Team Orchestrator (02) | Publishes `team.task.submitted`, `team.task.completed`; subscribes to `agent.failed` for re-planning |
| Tool & MCP Manager (03) | Publishes `tool.invoked`, `tool.failed`, `tool.result`; subscribes to `guardrail.intervention` to revoke tools |
| Guardrail System (04) | Publishes `guardrail.violation`, `guardrail.alert`; subscribes to all event types for policy enforcement (p. 297) |
| Observability Platform (05) | Subscribes to **all** events as a universal consumer for metric computation (p. 310) |
| Code Generation Tools (06) | Publishes `tool.invoked` for code execution; subscribes to `guardrail.intervention` for sandbox kill signals |
| Prompt Registry (07) | Publishes `prompt.created`, `prompt.promoted`, `prompt.rollback` |
| Evaluation Framework (08) | Publishes `eval.started`, `eval.completed`, `eval.regression_detected`; subscribes to `deployment.*` |
| Cost & Resource Manager (09) | Publishes `budget.warning`, `budget.exceeded`, `budget.degradation_triggered`; subscribes to `tool.invoked` for cost tracking |
| Review Checklist Assessment (10) | Subscribes to `eval.completed`, `deployment.*` for assessment triggers |
| Memory & Context Management (11) | Publishes `memory.write`, `memory.invalidated`, `memory.gc_completed` (p. 154); subscribes to `agent.deployed` for cache invalidation |
| External Integrations Hub (12) | Publishes `integration.call`, `integration.error`, `integration.webhook_received`; subscribes to `budget.exceeded` for rate limit enforcement |

---

## 2. Event Schema

### 2.1 Standard Event Envelope

Every event in the platform follows a single, uniform envelope structure. This is non-negotiable -- no subsystem may publish a raw payload without the envelope. The envelope design draws from the A2A task state model (p. 245), where every state transition carries a standardized structure containing the task identifier, new state, and associated data.

```json
{
  "$schema": "https://agentforge.io/schemas/event-envelope/v1.json",
  "id": "evt-550e8400-e29b-41d4-a716-446655440000",
  "type": "agent.deployed",
  "source": "subsystem:agent-builder",
  "subject": "agent:research-agent-v2.3.1",
  "timestamp": "2026-02-27T14:32:10.847Z",
  "spec_version": "1.0",
  "data_content_type": "application/json",
  "data": {
    "agent_id": "agent-research-001",
    "agent_version": "2.3.1",
    "deployment_target": "production",
    "previous_version": "2.3.0"
  },
  "metadata": {
    "trace_id": "tr-8f3a2b4c",
    "span_id": "sp-001",
    "correlation_id": "req-7890abcd",
    "causation_id": "evt-prev-1234",
    "tenant_id": "tenant-acme",
    "environment": "production",
    "schema_version": "1.0.0",
    "idempotency_key": "deploy-research-agent-2.3.1-1709044330"
  }
}
```

### 2.2 Envelope Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string (UUID) | Yes | Globally unique event identifier. Generated by the publisher. |
| `type` | string | Yes | Dot-delimited event type (e.g., `agent.deployed`). Must match a registered schema. |
| `source` | string | Yes | URI identifying the subsystem that produced the event (e.g., `subsystem:agent-builder`). |
| `subject` | string | No | The entity this event concerns (e.g., `agent:research-agent-v2.3.1`). Used for routing and filtering. |
| `timestamp` | string (ISO 8601) | Yes | When the event occurred, in UTC with millisecond precision. |
| `spec_version` | string | Yes | Envelope schema version. Currently `"1.0"`. |
| `data_content_type` | string | Yes | MIME type of the `data` field. Always `"application/json"` for now. |
| `data` | object | Yes | Event-type-specific payload. Schema determined by `type` + `metadata.schema_version`. |
| `metadata.trace_id` | string | Yes | OpenTelemetry trace ID for end-to-end correlation with the Observability Platform (subsystem 05). |
| `metadata.span_id` | string | No | Current span ID within the trace. |
| `metadata.correlation_id` | string | No | Identifier linking related events across a user request or workflow. |
| `metadata.causation_id` | string | No | The `id` of the event that caused this event. Forms an event causation chain. |
| `metadata.tenant_id` | string | Yes | Multi-tenant isolation. All filtering respects tenant boundaries. |
| `metadata.environment` | string | Yes | `development`, `staging`, or `production`. Events never cross environment boundaries. |
| `metadata.schema_version` | string | Yes | Semantic version of the `data` field's schema. Used by the Schema Registry for validation. |
| `metadata.idempotency_key` | string | No | Publisher-generated key for deduplication. Subscribers use this to achieve exactly-once processing. |

### 2.3 Event Envelope Python Model

```python
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional
import uuid


@dataclass(frozen=True)
class EventMetadata:
    """Metadata attached to every event for tracing, correlation, and governance."""
    trace_id: str
    tenant_id: str
    environment: str
    schema_version: str
    span_id: Optional[str] = None
    correlation_id: Optional[str] = None
    causation_id: Optional[str] = None
    idempotency_key: Optional[str] = None


@dataclass(frozen=True)
class Event:
    """
    Standard event envelope for all platform events.
    Immutable after creation -- events are facts, never modified.
    """
    type: str
    source: str
    data: dict[str, Any]
    metadata: EventMetadata
    id: str = field(default_factory=lambda: f"evt-{uuid.uuid4()}")
    timestamp: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    subject: Optional[str] = None
    spec_version: str = "1.0"
    data_content_type: str = "application/json"

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dictionary for transport."""
        return {
            "id": self.id,
            "type": self.type,
            "source": self.source,
            "subject": self.subject,
            "timestamp": self.timestamp,
            "spec_version": self.spec_version,
            "data_content_type": self.data_content_type,
            "data": self.data,
            "metadata": {
                "trace_id": self.metadata.trace_id,
                "span_id": self.metadata.span_id,
                "correlation_id": self.metadata.correlation_id,
                "causation_id": self.metadata.causation_id,
                "tenant_id": self.metadata.tenant_id,
                "environment": self.metadata.environment,
                "schema_version": self.metadata.schema_version,
                "idempotency_key": self.metadata.idempotency_key,
            },
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Event":
        """Deserialize from dictionary."""
        meta = data["metadata"]
        return cls(
            id=data["id"],
            type=data["type"],
            source=data["source"],
            subject=data.get("subject"),
            timestamp=data["timestamp"],
            spec_version=data["spec_version"],
            data_content_type=data["data_content_type"],
            data=data["data"],
            metadata=EventMetadata(
                trace_id=meta["trace_id"],
                span_id=meta.get("span_id"),
                correlation_id=meta.get("correlation_id"),
                causation_id=meta.get("causation_id"),
                tenant_id=meta["tenant_id"],
                environment=meta["environment"],
                schema_version=meta["schema_version"],
                idempotency_key=meta.get("idempotency_key"),
            ),
        )
```

---

## 3. Event Catalog

The Event Catalog is the comprehensive registry of every event type the platform produces. Each subsystem owns its event namespace and defines the `data` schema for its event types. The catalog is organized by the dot-delimited namespace prefix.

### 3.1 Agent Events (`agent.*`)

Owner: Agent Builder (subsystem 01)

These events track the lifecycle of agents from creation through deployment and failure. They form the agent lifecycle state machine referenced in the system overview.

| Event Type | Trigger | Data Schema |
|-----------|---------|-------------|
| `agent.created` | New agent definition registered | `{ agent_id, name, version, capabilities[], model_tier }` |
| `agent.deployed` | Agent promoted to serve traffic | `{ agent_id, version, deployment_target, previous_version }` |
| `agent.failed` | Agent encountered unrecoverable error during execution | `{ agent_id, version, error_type, error_message, trace_id, task_id }` |
| `agent.rollback` | Agent version rolled back to previous | `{ agent_id, from_version, to_version, reason, initiated_by }` |

### 3.2 Team Events (`team.*`)

Owner: Team Orchestrator (subsystem 02)

Team events track team lifecycle and task execution. The task state transitions mirror the A2A protocol states (p. 245): submitted, working, completed, failed.

| Event Type | Trigger | Data Schema |
|-----------|---------|-------------|
| `team.created` | New team definition registered | `{ team_id, name, topology, agent_ids[], version }` |
| `team.task.submitted` | Task dispatched to a team | `{ team_id, task_id, task_type, input_summary, priority }` |
| `team.task.completed` | Team finished processing a task | `{ team_id, task_id, status, output_summary, duration_ms, tokens_used }` |

### 3.3 Tool Events (`tool.*`)

Owner: Tool & MCP Manager (subsystem 03)

Tool events capture every tool invocation and its outcome. These are high-volume events -- every MCP tool call generates at least one.

| Event Type | Trigger | Data Schema |
|-----------|---------|-------------|
| `tool.invoked` | Agent called an MCP tool | `{ tool_server, tool_name, agent_id, input_hash, trace_id }` |
| `tool.failed` | Tool invocation returned an error | `{ tool_server, tool_name, agent_id, error_type, error_message, retry_count }` |
| `tool.result` | Tool invocation completed successfully | `{ tool_server, tool_name, agent_id, output_size_bytes, latency_ms }` |

### 3.4 Guardrail Events (`guardrail.*`)

Owner: Guardrail System (subsystem 04)

Guardrail events are safety-critical. They trigger real-time alerts and may halt agent execution (p. 297). The Guardrail System subscribes to many other event types to perform policy enforcement, but it publishes only these three.

| Event Type | Trigger | Data Schema |
|-----------|---------|-------------|
| `guardrail.violation` | Policy violation detected and blocked | `{ policy_id, severity, agent_id, action_blocked, details, trace_id }` |
| `guardrail.alert` | Suspicious pattern detected, not blocked | `{ policy_id, severity, agent_id, pattern_description, confidence }` |
| `guardrail.intervention` | Guardrail agent actively intervened in execution | `{ policy_id, intervention_type, agent_id, action_taken, escalation_required }` |

### 3.5 Prompt Events (`prompt.*`)

Owner: Prompt Registry (subsystem 07)

Prompt events track the prompt lifecycle from creation through production promotion and rollback. Goal completion events from prompt evaluation trigger downstream workflows (p. 183).

| Event Type | Trigger | Data Schema |
|-----------|---------|-------------|
| `prompt.created` | New prompt version registered | `{ prompt_id, agent_id, version, created_by, change_summary }` |
| `prompt.promoted` | Prompt version promoted to production | `{ prompt_id, agent_id, from_stage, to_stage, version, eval_score }` |
| `prompt.rollback` | Prompt rolled back to previous version | `{ prompt_id, agent_id, from_version, to_version, reason }` |

### 3.6 Evaluation Events (`eval.*`)

Owner: Evaluation Framework (subsystem 08)

Evaluation events drive the continuous improvement loop. The `eval.regression_detected` event is especially critical -- it triggers automatic rollback workflows in the Agent Builder and Prompt Registry.

| Event Type | Trigger | Data Schema |
|-----------|---------|-------------|
| `eval.started` | Evaluation run initiated | `{ eval_id, agent_id, eval_type, dataset_id, triggered_by }` |
| `eval.completed` | Evaluation run finished | `{ eval_id, agent_id, eval_type, scores, passed, duration_ms }` |
| `eval.regression_detected` | Quality regression found against baseline | `{ eval_id, agent_id, metric_name, baseline_value, current_value, degradation_pct }` |

### 3.7 Memory Events (`memory.*`)

Owner: Memory & Context Management (subsystem 11)

Memory events signal state changes in the memory subsystem. These are essential for cache invalidation and consistency across distributed agents (p. 154).

| Event Type | Trigger | Data Schema |
|-----------|---------|-------------|
| `memory.write` | New data written to any memory layer | `{ memory_key, memory_layer, agent_id, content_hash, ttl_seconds }` |
| `memory.invalidated` | Memory entry invalidated or expired | `{ memory_key, memory_layer, reason, invalidated_by }` |
| `memory.gc_completed` | Garbage collection cycle finished | `{ entries_removed, bytes_freed, layers_affected[], duration_ms }` |

### 3.8 Integration Events (`integration.*`)

Owner: External Integrations Hub (subsystem 12)

Integration events track all communication with external systems. The `integration.webhook_received` event converts inbound webhooks into platform events, bridging external systems into the event-driven architecture (p. 246).

| Event Type | Trigger | Data Schema |
|-----------|---------|-------------|
| `integration.call` | Outbound call to external service | `{ connector_id, service_name, operation, agent_id, latency_ms }` |
| `integration.error` | External service call failed | `{ connector_id, service_name, error_type, error_message, retry_count }` |
| `integration.webhook_received` | Inbound webhook from external service | `{ connector_id, service_name, webhook_type, payload_hash }` |

### 3.9 Budget Events (`budget.*`)

Owner: Cost & Resource Manager (subsystem 09)

Budget events drive the resource-aware degradation strategy. When budgets are exceeded, downstream subsystems receive the event and can independently adjust their behavior (p. 255).

| Event Type | Trigger | Data Schema |
|-----------|---------|-------------|
| `budget.warning` | Budget utilization crossed warning threshold | `{ budget_id, entity_type, entity_id, utilization_pct, threshold_pct }` |
| `budget.exceeded` | Budget fully exhausted | `{ budget_id, entity_type, entity_id, overage_amount, action_required }` |
| `budget.degradation_triggered` | Resource-aware degradation activated | `{ budget_id, entity_id, degradation_strategy, from_tier, to_tier }` |

### 3.10 Deployment Events (`deployment.*`)

Owner: Agent Builder (subsystem 01) and Team Orchestrator (subsystem 02)

Deployment events track the rollout lifecycle for agents and teams. These are consumed by the Evaluation Framework for automatic post-deployment testing.

| Event Type | Trigger | Data Schema |
|-----------|---------|-------------|
| `deployment.started` | New deployment initiated | `{ deployment_id, entity_type, entity_id, version, strategy, initiated_by }` |
| `deployment.canary_promoted` | Canary deployment promoted to full rollout | `{ deployment_id, entity_id, canary_metrics, promotion_criteria_met }` |
| `deployment.rollback` | Deployment rolled back | `{ deployment_id, entity_id, from_version, to_version, reason, automatic }` |

### 3.11 Auth Events (`auth.*`)

Owner: Platform Auth Service (cross-cutting)

Auth events are security-sensitive and always routed to the Guardrail System and Observability Platform. They are never filtered or dropped.

| Event Type | Trigger | Data Schema |
|-----------|---------|-------------|
| `auth.login` | Successful authentication | `{ user_id, method, ip_address, user_agent }` |
| `auth.permission_denied` | Authorization check failed | `{ user_id, resource, action, reason }` |
| `auth.key_rotated` | API key or secret rotated | `{ key_id, rotated_by, previous_key_hash, scope }` |

---

## 4. Event Bus Architecture

### 4.1 Technology Selection

The Event Bus uses **Redis Streams** as the primary stream engine, with **NATS JetStream** as an optional high-throughput alternative for deployments that exceed Redis's single-node capacity.

| Criterion | Redis Streams | NATS JetStream |
|-----------|--------------|----------------|
| Deployment complexity | Low -- already in the stack for caching | Medium -- requires dedicated cluster |
| Throughput | ~100K events/sec single-node | ~1M events/sec clustered |
| Persistence | AOF/RDB with configurable retention | File-based with replication |
| Consumer groups | Native `XREADGROUP` | Native consumer groups |
| Ordering | Per-stream total order | Per-stream with optional per-subject |
| Recommended for | Single-region, <50 subsystem instances | Multi-region, >50 subsystem instances |

The default deployment uses Redis Streams because it avoids introducing a new infrastructure dependency (Redis is already used for session memory in subsystem 11 and as the state store in the system overview).

### 4.2 Topic Design

Events are organized into **topics** based on their dot-delimited namespace prefix. Each top-level namespace maps to a dedicated Redis Stream:

```
┌─────────────────────────────────────────────────────────┐
│                    Topic Layout                         │
│                                                         │
│  Stream: events:agent       ← agent.created,            │
│                                agent.deployed,          │
│                                agent.failed,            │
│                                agent.rollback           │
│                                                         │
│  Stream: events:team        ← team.created,             │
│                                team.task.submitted,     │
│                                team.task.completed      │
│                                                         │
│  Stream: events:tool        ← tool.invoked,             │
│                                tool.failed,             │
│                                tool.result              │
│                                                         │
│  Stream: events:guardrail   ← guardrail.violation,      │
│                                guardrail.alert,         │
│                                guardrail.intervention   │
│                                                         │
│  Stream: events:prompt      ← prompt.created,           │
│                                prompt.promoted,         │
│                                prompt.rollback          │
│                                                         │
│  Stream: events:eval        ← eval.started,             │
│                                eval.completed,          │
│                                eval.regression_detected │
│                                                         │
│  Stream: events:memory      ← memory.write,             │
│                                memory.invalidated,      │
│                                memory.gc_completed      │
│                                                         │
│  Stream: events:integration ← integration.call,         │
│                                integration.error,       │
│                                integration.webhook_received│
│                                                         │
│  Stream: events:budget      ← budget.warning,           │
│                                budget.exceeded,         │
│                                budget.degradation_triggered│
│                                                         │
│  Stream: events:deployment  ← deployment.started,       │
│                                deployment.canary_promoted, │
│                                deployment.rollback      │
│                                                         │
│  Stream: events:auth        ← auth.login,               │
│                                auth.permission_denied,  │
│                                auth.key_rotated         │
│                                                         │
│  Stream: events:dlq         ← Dead Letter Queue         │
│                                (failed events from any  │
│                                 stream)                 │
└─────────────────────────────────────────────────────────┘
```

### 4.3 Partitioning Strategy

Within each stream, events are not physically partitioned (Redis Streams are single-partition by design). Instead, **logical partitioning** is achieved through consumer group assignment and client-side filtering:

```
                           events:agent stream
                    ┌──────────────────────────────┐
                    │ evt-001 agent.created         │
                    │ evt-002 agent.deployed        │
                    │ evt-003 agent.failed          │
                    │ evt-004 agent.deployed        │
                    │ evt-005 agent.rollback        │
                    │ ...                           │
                    └──────────┬───────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────┴────────┐ ┌────┴──────────┐ ┌───┴────────────┐
    │ Consumer Group:   │ │ Consumer Grp: │ │ Consumer Group: │
    │ observability     │ │ guardrails    │ │ eval-framework  │
    │                   │ │               │ │                 │
    │ filter: agent.*   │ │ filter:       │ │ filter:         │
    │ (all agent events)│ │ agent.failed  │ │ agent.deployed  │
    │                   │ │               │ │ agent.rollback  │
    │ Consumer-1 ──┐    │ │ Consumer-1    │ │ Consumer-1      │
    │ Consumer-2 ──┤    │ └───────────────┘ └─────────────────┘
    │ Consumer-3 ──┘    │
    └───────────────────┘
```

For NATS JetStream deployments, physical partitioning by subject (e.g., `agent.deployed.{agent_id}`) enables horizontal scaling across multiple consumer instances.

### 4.4 Event Flow

The complete lifecycle of an event from publish to consume:

```
Publisher                  Event Bus                         Subscriber
   │                          │                                  │
   │  1. publish(event)       │                                  │
   │─────────────────────────>│                                  │
   │                          │                                  │
   │  2. validate schema      │                                  │
   │  (Schema Registry)       │                                  │
   │                          │                                  │
   │  3. XADD to stream       │                                  │
   │                          │                                  │
   │  4. ACK to publisher     │                                  │
   │<─────────────────────────│                                  │
   │                          │                                  │
   │                          │  5. XREADGROUP (long poll)       │
   │                          │<─────────────────────────────────│
   │                          │                                  │
   │                          │  6. deliver event                │
   │                          │─────────────────────────────────>│
   │                          │                                  │
   │                          │                                  │  7. process event
   │                          │                                  │
   │                          │  8. XACK (consumer confirms)     │
   │                          │<─────────────────────────────────│
   │                          │                                  │
   │                          │  [if processing fails]           │
   │                          │                                  │
   │                          │  9. retry (up to max_retries)    │
   │                          │─────────────────────────────────>│
   │                          │                                  │
   │                          │  [if all retries exhausted]      │
   │                          │                                  │
   │                          │  10. move to DLQ                 │
   │                          │──────────> events:dlq            │
```

---

## 5. Publishing API

### 5.1 EventPublisher Client

Every subsystem uses the `EventPublisher` client to emit events. The client handles serialization, schema validation, retry on publish failure, and trace context propagation.

```python
import json
import time
import logging
from typing import Any, Optional

import redis.asyncio as redis

from agentforge.events.schema import Event, EventMetadata
from agentforge.events.registry import SchemaRegistry
from agentforge.observability import get_current_trace_context


logger = logging.getLogger("agentforge.events.publisher")


class EventPublisher:
    """
    Client for publishing events to the Event Bus.

    Used by all subsystems to emit structured events. Handles schema
    validation, serialization, and reliable delivery to Redis Streams.

    Usage:
        publisher = EventPublisher(redis_client, schema_registry, source="subsystem:agent-builder")
        await publisher.publish(
            event_type="agent.deployed",
            data={"agent_id": "agent-001", "version": "2.3.1", ...},
            subject="agent:agent-001",
        )
    """

    def __init__(
        self,
        redis_client: redis.Redis,
        schema_registry: "SchemaRegistry",
        source: str,
        environment: str = "production",
        tenant_id: str = "default",
        max_publish_retries: int = 3,
    ):
        self._redis = redis_client
        self._schema_registry = schema_registry
        self._source = source
        self._environment = environment
        self._tenant_id = tenant_id
        self._max_retries = max_publish_retries

    def _resolve_stream(self, event_type: str) -> str:
        """
        Map event type to Redis Stream name.
        'agent.deployed' -> 'events:agent'
        'team.task.submitted' -> 'events:team'
        """
        namespace = event_type.split(".")[0]
        return f"events:{namespace}"

    async def publish(
        self,
        event_type: str,
        data: dict[str, Any],
        subject: Optional[str] = None,
        correlation_id: Optional[str] = None,
        causation_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        schema_version: str = "1.0.0",
    ) -> str:
        """
        Publish a single event to the Event Bus.

        Validates the event data against the registered schema, wraps it
        in the standard envelope, and appends it to the appropriate
        Redis Stream.

        Returns the event ID on success.
        Raises EventPublishError on failure after all retries.
        """
        # Build the event envelope
        trace_ctx = get_current_trace_context()
        metadata = EventMetadata(
            trace_id=trace_ctx.trace_id,
            span_id=trace_ctx.span_id,
            correlation_id=correlation_id,
            causation_id=causation_id,
            tenant_id=self._tenant_id,
            environment=self._environment,
            schema_version=schema_version,
            idempotency_key=idempotency_key,
        )
        event = Event(
            type=event_type,
            source=self._source,
            data=data,
            metadata=metadata,
            subject=subject,
        )

        # Validate against schema registry
        validation_result = self._schema_registry.validate(event)
        if not validation_result.valid:
            raise EventSchemaError(
                f"Event data for '{event_type}' failed schema validation: "
                f"{validation_result.errors}"
            )

        # Publish to Redis Stream with retry
        stream = self._resolve_stream(event_type)
        serialized = json.dumps(event.to_dict())

        for attempt in range(1, self._max_retries + 1):
            try:
                stream_id = await self._redis.xadd(
                    stream,
                    {"event": serialized},
                    maxlen=1_000_000,  # cap stream length, oldest trimmed
                )
                logger.info(
                    "Published event",
                    extra={
                        "event_id": event.id,
                        "event_type": event_type,
                        "stream": stream,
                        "stream_id": stream_id,
                        "attempt": attempt,
                    },
                )
                return event.id

            except redis.RedisError as exc:
                logger.warning(
                    "Publish attempt failed",
                    extra={
                        "event_id": event.id,
                        "stream": stream,
                        "attempt": attempt,
                        "error": str(exc),
                    },
                )
                if attempt == self._max_retries:
                    raise EventPublishError(
                        f"Failed to publish event {event.id} after "
                        f"{self._max_retries} attempts: {exc}"
                    ) from exc
                await self._backoff(attempt)

    async def publish_batch(
        self,
        events: list[tuple[str, dict[str, Any]]],
        **kwargs,
    ) -> list[str]:
        """
        Publish multiple events atomically using a Redis pipeline.
        Each tuple is (event_type, data).
        Returns list of event IDs.
        """
        pipe = self._redis.pipeline()
        built_events = []

        for event_type, data in events:
            trace_ctx = get_current_trace_context()
            metadata = EventMetadata(
                trace_id=trace_ctx.trace_id,
                span_id=trace_ctx.span_id,
                tenant_id=self._tenant_id,
                environment=self._environment,
                schema_version=kwargs.get("schema_version", "1.0.0"),
            )
            event = Event(
                type=event_type,
                source=self._source,
                data=data,
                metadata=metadata,
            )
            stream = self._resolve_stream(event_type)
            serialized = json.dumps(event.to_dict())
            pipe.xadd(stream, {"event": serialized}, maxlen=1_000_000)
            built_events.append(event)

        await pipe.execute()
        return [e.id for e in built_events]

    @staticmethod
    async def _backoff(attempt: int) -> None:
        """Exponential backoff: 100ms, 200ms, 400ms, ..."""
        import asyncio
        delay = 0.1 * (2 ** (attempt - 1))
        await asyncio.sleep(delay)


class EventPublishError(Exception):
    """Raised when event publishing fails after all retry attempts."""
    pass


class EventSchemaError(Exception):
    """Raised when event data does not conform to the registered schema."""
    pass
```

### 5.2 Publishing Patterns

Subsystems follow standard patterns when publishing events:

**Pattern 1: Fire-and-forget (non-critical events)**

```python
# Tool invocation logging -- high volume, best-effort
await publisher.publish(
    event_type="tool.invoked",
    data={"tool_server": "mcp://db-server", "tool_name": "sql_query", "agent_id": agent_id},
)
```

**Pattern 2: Correlated event chain (workflow tracking)**

```python
# Deployment workflow -- each event references the previous one
deploy_evt_id = await publisher.publish(
    event_type="deployment.started",
    data={"deployment_id": dep_id, "entity_id": agent_id, "version": "2.3.1"},
    correlation_id=request_id,
)

# Later, after canary evaluation...
await publisher.publish(
    event_type="deployment.canary_promoted",
    data={"deployment_id": dep_id, "canary_metrics": metrics},
    correlation_id=request_id,
    causation_id=deploy_evt_id,
)
```

**Pattern 3: Idempotent publish (exactly-once semantics for critical events)**

```python
# Budget exceeded -- must not trigger duplicate degradation
await publisher.publish(
    event_type="budget.exceeded",
    data={"budget_id": budget_id, "entity_id": team_id, "overage_amount": 12.50},
    idempotency_key=f"budget-exceeded-{budget_id}-{current_period}",
)
```

---

## 6. Subscription API

### 6.1 EventSubscriber Client

Subscribers use consumer groups to receive events. Multiple instances of the same subscriber share a consumer group so that each event is processed by exactly one instance (load balancing). Different subscriber groups each receive their own copy of every event (fan-out).

```python
import json
import asyncio
import logging
from typing import Any, Callable, Awaitable, Optional
from dataclasses import dataclass

import redis.asyncio as redis

from agentforge.events.schema import Event


logger = logging.getLogger("agentforge.events.subscriber")


@dataclass
class SubscriptionFilter:
    """
    Filter criteria for event subscriptions.
    Subscribers only receive events matching ALL specified criteria.
    """
    event_types: Optional[list[str]] = None       # e.g., ["agent.deployed", "agent.failed"]
    source_prefix: Optional[str] = None            # e.g., "subsystem:agent-builder"
    subject_prefix: Optional[str] = None           # e.g., "agent:"
    tenant_id: Optional[str] = None                # e.g., "tenant-acme"
    min_severity: Optional[str] = None             # for guardrail events: "low", "medium", "high", "critical"

    def matches(self, event: Event) -> bool:
        """Evaluate whether an event passes this filter."""
        if self.event_types and event.type not in self.event_types:
            return False
        if self.source_prefix and not event.source.startswith(self.source_prefix):
            return False
        if self.subject_prefix and (
            event.subject is None or not event.subject.startswith(self.subject_prefix)
        ):
            return False
        if self.tenant_id and event.metadata.tenant_id != self.tenant_id:
            return False
        if self.min_severity:
            event_severity = event.data.get("severity", "low")
            severity_order = {"low": 0, "medium": 1, "high": 2, "critical": 3}
            if severity_order.get(event_severity, 0) < severity_order.get(self.min_severity, 0):
                return False
        return True


# Type alias for event handler callbacks
EventHandler = Callable[[Event], Awaitable[None]]


class EventSubscriber:
    """
    Client for consuming events from the Event Bus.

    Manages consumer group membership, long-poll reading, client-side
    filtering, acknowledgment, and retry/DLQ escalation.

    Usage:
        subscriber = EventSubscriber(redis_client, group="observability", consumer="obs-1")
        subscriber.subscribe("events:agent", handler=handle_agent_event, filter=my_filter)
        await subscriber.start()
    """

    def __init__(
        self,
        redis_client: redis.Redis,
        group: str,
        consumer: str,
        max_retries: int = 3,
        retry_delay_ms: int = 1000,
        block_ms: int = 5000,
        batch_size: int = 10,
    ):
        self._redis = redis_client
        self._group = group
        self._consumer = consumer
        self._max_retries = max_retries
        self._retry_delay_ms = retry_delay_ms
        self._block_ms = block_ms
        self._batch_size = batch_size
        self._subscriptions: list[tuple[str, EventHandler, Optional[SubscriptionFilter]]] = []
        self._running = False

    def subscribe(
        self,
        stream: str,
        handler: EventHandler,
        filter: Optional[SubscriptionFilter] = None,
    ) -> None:
        """Register a handler for a stream with optional filtering."""
        self._subscriptions.append((stream, handler, filter))

    async def start(self) -> None:
        """
        Start consuming events from all subscribed streams.
        Creates consumer groups if they do not exist.
        Runs until stop() is called.
        """
        self._running = True

        # Ensure consumer groups exist
        for stream, _, _ in self._subscriptions:
            try:
                await self._redis.xgroup_create(
                    stream, self._group, id="0", mkstream=True
                )
            except redis.ResponseError as e:
                if "BUSYGROUP" not in str(e):
                    raise  # Group already exists -- safe to ignore

        logger.info(
            "EventSubscriber started",
            extra={
                "group": self._group,
                "consumer": self._consumer,
                "streams": [s for s, _, _ in self._subscriptions],
            },
        )

        while self._running:
            await self._poll_cycle()

    async def stop(self) -> None:
        """Gracefully stop the subscriber."""
        self._running = False

    async def _poll_cycle(self) -> None:
        """Execute one read cycle across all subscribed streams."""
        streams = {stream: ">" for stream, _, _ in self._subscriptions}
        try:
            results = await self._redis.xreadgroup(
                groupname=self._group,
                consumername=self._consumer,
                streams=streams,
                count=self._batch_size,
                block=self._block_ms,
            )
        except redis.RedisError as exc:
            logger.error(f"XREADGROUP failed: {exc}")
            await asyncio.sleep(1)
            return

        if not results:
            return  # No new messages in this cycle

        for stream_name, messages in results:
            handler, filter_ = self._find_handler(stream_name)
            for message_id, fields in messages:
                event_data = json.loads(fields[b"event"])
                event = Event.from_dict(event_data)

                # Client-side filtering
                if filter_ and not filter_.matches(event):
                    await self._redis.xack(stream_name, self._group, message_id)
                    continue

                # Process with retry
                await self._process_with_retry(
                    stream_name, message_id, event, handler
                )

    def _find_handler(
        self, stream_name: str
    ) -> tuple[EventHandler, Optional[SubscriptionFilter]]:
        """Look up the handler and filter for a given stream."""
        stream_str = stream_name.decode() if isinstance(stream_name, bytes) else stream_name
        for stream, handler, filter_ in self._subscriptions:
            if stream == stream_str:
                return handler, filter_
        raise ValueError(f"No handler registered for stream: {stream_str}")

    async def _process_with_retry(
        self,
        stream: str,
        message_id: str,
        event: Event,
        handler: EventHandler,
    ) -> None:
        """
        Attempt to process an event. Retry on failure up to max_retries.
        If all retries fail, move the event to the Dead Letter Queue.
        """
        for attempt in range(1, self._max_retries + 1):
            try:
                await handler(event)
                await self._redis.xack(stream, self._group, message_id)
                logger.debug(
                    "Event processed",
                    extra={"event_id": event.id, "stream": stream, "attempt": attempt},
                )
                return
            except Exception as exc:
                logger.warning(
                    "Event processing failed",
                    extra={
                        "event_id": event.id,
                        "stream": stream,
                        "attempt": attempt,
                        "error": str(exc),
                    },
                )
                if attempt < self._max_retries:
                    await asyncio.sleep(self._retry_delay_ms / 1000 * attempt)

        # All retries exhausted -- send to DLQ
        await self._send_to_dlq(stream, message_id, event)

    async def _send_to_dlq(
        self, source_stream: str, message_id: str, event: Event
    ) -> None:
        """Move a failed event to the Dead Letter Queue stream."""
        import time

        dlq_entry = {
            "event": json.dumps(event.to_dict()),
            "source_stream": source_stream,
            "original_message_id": message_id.decode()
                if isinstance(message_id, bytes) else message_id,
            "consumer_group": self._group,
            "consumer": self._consumer,
            "failure_timestamp": time.time(),
            "retry_count": self._max_retries,
        }
        await self._redis.xadd("events:dlq", {
            "entry": json.dumps(dlq_entry),
        })
        await self._redis.xack(source_stream, self._group, message_id)
        logger.error(
            "Event moved to DLQ",
            extra={
                "event_id": event.id,
                "source_stream": source_stream,
                "consumer_group": self._group,
            },
        )
```

### 6.2 Subscription Patterns

**Pattern 1: Universal consumer (Observability Platform)**

The Observability Platform subscribes to all streams to compute metrics from event flows (p. 310). It uses a dedicated consumer group so it sees every event independently of other subscribers.

```python
subscriber = EventSubscriber(redis_client, group="observability", consumer="obs-1")

async def handle_any_event(event: Event) -> None:
    """Feed every event into the metrics pipeline."""
    await metrics_pipeline.ingest(event)
    await trace_correlator.link_event(event)

# Subscribe to every stream -- no filter, process all events
for stream in ALL_EVENT_STREAMS:
    subscriber.subscribe(stream, handler=handle_any_event)

await subscriber.start()
```

**Pattern 2: Selective consumer with filter (Evaluation Framework)**

```python
subscriber = EventSubscriber(redis_client, group="eval-framework", consumer="eval-1")

# Only care about deployment and agent lifecycle events
filter_ = SubscriptionFilter(
    event_types=["agent.deployed", "agent.rollback", "deployment.started"]
)

async def handle_deploy_event(event: Event) -> None:
    """Trigger post-deployment evaluation when an agent is deployed."""
    if event.type == "agent.deployed":
        await trigger_eval_suite(event.data["agent_id"], event.data["version"])

subscriber.subscribe("events:agent", handler=handle_deploy_event, filter=filter_)
subscriber.subscribe("events:deployment", handler=handle_deploy_event, filter=filter_)

await subscriber.start()
```

**Pattern 3: Fan-out to multiple handlers (Guardrail System)**

The Guardrail System monitors many event streams simultaneously for policy enforcement (p. 297). Safety intervention events are generated when a guardrail detects a violation in any subsystem's events.

```python
guardrail_sub = EventSubscriber(redis_client, group="guardrails", consumer="guard-1")

async def monitor_tool_events(event: Event) -> None:
    """Check tool invocations against security policies (p. 288)."""
    if event.type == "tool.failed" and event.data.get("error_type") == "permission_denied":
        await publisher.publish(
            event_type="guardrail.alert",
            data={"policy_id": "tool-permission", "severity": "high", ...},
            causation_id=event.id,
        )

async def monitor_auth_events(event: Event) -> None:
    """Detect suspicious authentication patterns."""
    if event.type == "auth.permission_denied":
        await rate_limiter.record_denied(event.data["user_id"])

guardrail_sub.subscribe("events:tool", handler=monitor_tool_events)
guardrail_sub.subscribe("events:auth", handler=monitor_auth_events)

await guardrail_sub.start()
```

---

## 7. Delivery Guarantees

### 7.1 At-Least-Once Semantics

The Event Bus provides **at-least-once delivery**. Every event published to a stream is guaranteed to be delivered to every consumer group at least once. This guarantee is implemented through the Redis Streams acknowledgment protocol:

1. Event is appended to the stream via `XADD` (durable write).
2. Consumer reads the event via `XREADGROUP` (marks as pending).
3. Consumer processes the event and calls `XACK` (marks as delivered).
4. If the consumer crashes before `XACK`, the event remains in the Pending Entries List (PEL).
5. A background claimer process (see below) detects stale PEL entries and reassigns them.

```
Publisher ──XADD──> Stream ──XREADGROUP──> Consumer
                       │                      │
                       │                      ├── success ──XACK──> done
                       │                      │
                       │                      └── crash (no XACK)
                       │                             │
                       │                      PEL entry remains
                       │                             │
                       └── XCLAIM (background) ──────┘
                              reassign to another consumer
```

### 7.2 Pending Entry Claimer

A background process runs in every subscriber instance to detect and reclaim stale pending entries:

```python
class PendingEntryClaimer:
    """
    Reclaims events that were delivered but never acknowledged.
    Runs as a background task in every EventSubscriber instance.
    Detects events stuck in the Pending Entries List (PEL) beyond
    the idle threshold and reassigns them to active consumers.
    """

    def __init__(
        self,
        redis_client: redis.Redis,
        group: str,
        consumer: str,
        idle_threshold_ms: int = 60_000,
        claim_interval_s: int = 30,
    ):
        self._redis = redis_client
        self._group = group
        self._consumer = consumer
        self._idle_threshold_ms = idle_threshold_ms
        self._claim_interval_s = claim_interval_s

    async def run(self, streams: list[str]) -> None:
        """Periodically scan PEL and reclaim stale entries."""
        while True:
            for stream in streams:
                try:
                    # XAUTOCLAIM: atomically claim entries idle beyond threshold
                    _, claimed, _ = await self._redis.xautoclaim(
                        stream,
                        self._group,
                        self._consumer,
                        min_idle_time=self._idle_threshold_ms,
                        start_id="0-0",
                        count=50,
                    )
                    if claimed:
                        logger.info(
                            f"Claimed {len(claimed)} stale entries from {stream}"
                        )
                except redis.RedisError as exc:
                    logger.error(f"PEL claim failed for {stream}: {exc}")

            await asyncio.sleep(self._claim_interval_s)
```

### 7.3 Ordering Guarantees

- **Per-stream ordering**: Events within a single Redis Stream are totally ordered by their stream ID. Consumers in a group see events in the order they were published.
- **Cross-stream ordering**: No ordering guarantee exists across different streams. If a subscriber reads from both `events:agent` and `events:tool`, the relative order between agent events and tool events is not guaranteed.
- **Causal ordering**: When ordering matters across event types, publishers use the `causation_id` field to establish causal chains. Consumers that need causal ordering must buffer and sort events by their causation chain before processing.

### 7.4 Idempotency

At-least-once delivery means a consumer may see the same event more than once (e.g., after a crash and reclaim). Consumers must handle duplicates. The platform provides two mechanisms:

**Mechanism 1: Idempotency key deduplication**

```python
class IdempotencyGuard:
    """
    Prevents duplicate processing of events using a Redis-backed
    deduplication set. Events with the same idempotency key are
    processed only once within the TTL window.
    """

    def __init__(self, redis_client: redis.Redis, ttl_seconds: int = 86400):
        self._redis = redis_client
        self._ttl = ttl_seconds

    async def is_duplicate(self, event: Event) -> bool:
        """Check if this event has already been processed."""
        key = event.metadata.idempotency_key or event.id
        dedup_key = f"idempotency:{key}"

        # SET NX: only sets if key does not exist
        was_set = await self._redis.set(dedup_key, "1", nx=True, ex=self._ttl)
        return not was_set  # True if key already existed (duplicate)
```

**Mechanism 2: Event ID tracking**

Consumers that cannot rely on idempotency keys track processed event IDs in their local state:

```python
async def idempotent_handler(event: Event) -> None:
    """Example handler with event ID-based deduplication."""
    if await idempotency_guard.is_duplicate(event):
        logger.debug(f"Skipping duplicate event: {event.id}")
        return
    # ... process event ...
```

---

## 8. Dead Letter Queue

### 8.1 DLQ Design

The Dead Letter Queue captures events that fail processing after all retry attempts have been exhausted. This implements the error recovery strategy from Exception Handling (p. 205): classify unrecoverable errors and preserve the failed work for manual intervention rather than silently dropping it.

The DLQ is itself a Redis Stream (`events:dlq`), which means it benefits from the same persistence, ordering, and consumer group capabilities as regular event streams.

```
Normal processing flow:
                                                         ┌─────────────┐
  events:agent ──> Consumer Group ──> handler() ──OK──> │    XACK     │
                         │                               └─────────────┘
                         │
                    handler() fails
                         │
                    retry 1 ──> fails
                    retry 2 ──> fails
                    retry 3 ──> fails
                         │
                         ▼
                  ┌──────────────┐
                  │  events:dlq  │  DLQ entry contains:
                  │              │  - Original event (full envelope)
                  │              │  - Source stream name
                  │              │  - Consumer group that failed
                  │              │  - Failure timestamp
                  │              │  - Retry count
                  │              │  - Last error message
                  └──────┬───────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
         ┌────┴────┐ ┌───┴───┐ ┌───┴──────┐
         │  Alert  │ │ Admin │ │ Auto-    │
         │  (ops)  │ │ Review│ │ Retry    │
         │         │ │  UI   │ │ Scheduler│
         └─────────┘ └───────┘ └──────────┘
```

### 8.2 DLQ Entry Schema

```json
{
  "event": { "...full event envelope..." },
  "source_stream": "events:agent",
  "original_message_id": "1709044330000-0",
  "consumer_group": "eval-framework",
  "consumer": "eval-1",
  "failure_timestamp": "2026-02-27T14:32:10.847Z",
  "retry_count": 3,
  "last_error": "ConnectionError: evaluation service unreachable",
  "error_category": "transient",
  "dlq_entry_id": "dlq-550e8400-e29b-41d4-a716-446655440099"
}
```

### 8.3 DLQ Handler

```python
import json
import asyncio
import logging
from typing import Optional
from datetime import datetime, timezone

import redis.asyncio as redis

from agentforge.events.schema import Event


logger = logging.getLogger("agentforge.events.dlq")


class DLQHandler:
    """
    Manages the Dead Letter Queue for failed events.

    Provides three operations:
    1. Inspect: List and filter DLQ entries for manual review.
    2. Retry: Re-publish a DLQ entry back to its original stream.
    3. Discard: Permanently remove a DLQ entry after review.

    Also runs an automatic retry scheduler for transient failures.
    """

    def __init__(
        self,
        redis_client: redis.Redis,
        auto_retry_interval_s: int = 300,
        max_auto_retries: int = 5,
    ):
        self._redis = redis_client
        self._auto_retry_interval = auto_retry_interval_s
        self._max_auto_retries = max_auto_retries
        self._dlq_stream = "events:dlq"

    async def inspect(
        self,
        count: int = 50,
        source_stream: Optional[str] = None,
        error_category: Optional[str] = None,
    ) -> list[dict]:
        """
        List DLQ entries for manual review.
        Supports filtering by source stream and error category.
        """
        entries = await self._redis.xrange(self._dlq_stream, count=count)
        results = []
        for message_id, fields in entries:
            entry = json.loads(fields[b"entry"])
            if source_stream and entry.get("source_stream") != source_stream:
                continue
            if error_category and entry.get("error_category") != error_category:
                continue
            entry["dlq_message_id"] = message_id
            results.append(entry)
        return results

    async def retry(self, dlq_message_id: str) -> str:
        """
        Re-publish a DLQ entry back to its original stream.
        Returns the new stream message ID.
        """
        entries = await self._redis.xrange(
            self._dlq_stream, min=dlq_message_id, max=dlq_message_id, count=1
        )
        if not entries:
            raise ValueError(f"DLQ entry not found: {dlq_message_id}")

        _, fields = entries[0]
        entry = json.loads(fields[b"entry"])
        event_data = entry["event"]
        source_stream = entry["source_stream"]

        # Re-publish to original stream
        new_id = await self._redis.xadd(
            source_stream, {"event": json.dumps(event_data)}
        )

        # Remove from DLQ
        await self._redis.xdel(self._dlq_stream, dlq_message_id)

        logger.info(
            "DLQ entry retried",
            extra={
                "dlq_message_id": dlq_message_id,
                "source_stream": source_stream,
                "new_message_id": new_id,
            },
        )
        return new_id

    async def discard(self, dlq_message_id: str, reason: str = "") -> None:
        """
        Permanently remove a DLQ entry after manual review.
        The reason is logged for audit purposes.
        """
        await self._redis.xdel(self._dlq_stream, dlq_message_id)
        logger.info(
            "DLQ entry discarded",
            extra={"dlq_message_id": dlq_message_id, "reason": reason},
        )

    async def run_auto_retry(self) -> None:
        """
        Background task that automatically retries DLQ entries
        categorized as transient failures.

        Runs on a fixed interval. Only retries entries that have
        not exceeded the max auto-retry count.
        """
        while True:
            entries = await self.inspect(
                count=100, error_category="transient"
            )
            for entry in entries:
                retry_count = entry.get("retry_count", 0)
                auto_retries = entry.get("auto_retry_count", 0)

                if auto_retries >= self._max_auto_retries:
                    # Escalate: re-categorize as permanent failure
                    logger.warning(
                        "DLQ entry exceeded auto-retry limit, escalating",
                        extra={"dlq_entry_id": entry.get("dlq_entry_id")},
                    )
                    continue

                try:
                    await self.retry(entry["dlq_message_id"])
                except Exception as exc:
                    logger.error(
                        f"Auto-retry failed: {exc}",
                        extra={"dlq_entry_id": entry.get("dlq_entry_id")},
                    )

            await asyncio.sleep(self._auto_retry_interval)

    async def get_depth(self) -> int:
        """Return the current number of entries in the DLQ."""
        info = await self._redis.xinfo_stream(self._dlq_stream)
        return info["length"]
```

### 8.4 DLQ Alerting

The DLQ depth is monitored by the Instrumentation Layer (see Section 13). Alerts are triggered when:

| Condition | Severity | Action |
|-----------|----------|--------|
| DLQ depth > 10 entries | Warning | Notify ops channel |
| DLQ depth > 50 entries | High | Page on-call engineer |
| DLQ entry age > 1 hour (transient) | High | Auto-retry or escalate |
| DLQ entry age > 24 hours (any) | Critical | Mandatory manual review |

---

## 9. Event Replay

### 9.1 Replay Design

Event Replay is the ability to re-deliver historical events to a consumer for debugging, recovery, or state reconstruction. This is critical for post-incident analysis (p. 301) and for bootstrapping new subscribers that need to catch up on historical state.

Redis Streams are an append-only log with configurable retention, making replay a native operation. The Replay Engine provides a controlled interface around raw stream reads to prevent accidental reprocessing.

```
                    Replay Request
                         │
                         ▼
              ┌──────────────────────┐
              │   Replay Engine       │
              │                       │
              │  1. Validate request  │
              │  2. Create replay     │
              │     consumer group    │
              │  3. Seek to start     │
              │     position          │
              │  4. Read + filter     │
              │  5. Deliver to        │
              │     replay consumer   │
              │  6. Track progress    │
              └──────────────────────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
         Time-range   Event-type   Consumer
         replay       replay       state
         (from/to)    (specific    rebuild
                       types)
```

### 9.2 Replay Engine

```python
import json
import asyncio
import logging
from typing import AsyncIterator, Optional
from dataclasses import dataclass
from datetime import datetime

import redis.asyncio as redis

from agentforge.events.schema import Event


logger = logging.getLogger("agentforge.events.replay")


@dataclass
class ReplayRequest:
    """Defines the scope of an event replay operation."""
    stream: str
    from_timestamp: Optional[str] = None    # ISO 8601 or Redis stream ID
    to_timestamp: Optional[str] = None      # ISO 8601 or Redis stream ID
    event_types: Optional[list[str]] = None # Filter to specific event types
    max_events: int = 10_000                # Safety limit
    replay_id: Optional[str] = None         # For tracking and deduplication


class ReplayEngine:
    """
    Replays historical events from Redis Streams.

    Supports three replay modes:
    1. Time-range: Replay all events between two timestamps.
    2. Event-type: Replay only specific event types from a stream.
    3. Consumer rebuild: Create a new consumer group starting from
       a historical position to rebuild subscriber state.

    All replayed events are tagged with replay metadata so consumers
    can distinguish replayed events from live events.
    """

    def __init__(self, redis_client: redis.Redis):
        self._redis = redis_client

    async def replay(
        self, request: ReplayRequest
    ) -> AsyncIterator[Event]:
        """
        Yield events matching the replay request.

        Events are read directly from the stream using XRANGE
        (not consumer groups) to avoid affecting live consumers.
        """
        start = self._to_stream_id(request.from_timestamp) if request.from_timestamp else "-"
        end = self._to_stream_id(request.to_timestamp) if request.to_timestamp else "+"

        count = 0
        cursor = start

        while count < request.max_events:
            batch = await self._redis.xrange(
                request.stream, min=cursor, max=end, count=100
            )
            if not batch:
                break

            for message_id, fields in batch:
                event_data = json.loads(fields[b"event"])
                event = Event.from_dict(event_data)

                # Apply event type filter
                if request.event_types and event.type not in request.event_types:
                    continue

                count += 1
                if count > request.max_events:
                    break

                yield event

            # Move cursor past the last message in this batch
            last_id = batch[-1][0]
            cursor = self._increment_id(last_id)

        logger.info(
            "Replay completed",
            extra={
                "stream": request.stream,
                "events_replayed": count,
                "replay_id": request.replay_id,
            },
        )

    async def rebuild_consumer_group(
        self,
        stream: str,
        group: str,
        start_id: str = "0",
    ) -> None:
        """
        Create a new consumer group starting from a historical position.
        Used to bootstrap new subscribers that need to process historical events.
        """
        try:
            await self._redis.xgroup_create(stream, group, id=start_id, mkstream=False)
            logger.info(
                f"Created consumer group '{group}' on '{stream}' starting from {start_id}"
            )
        except redis.ResponseError as e:
            if "BUSYGROUP" in str(e):
                # Group already exists -- reset its position
                await self._redis.xgroup_setid(stream, group, start_id)
                logger.info(
                    f"Reset consumer group '{group}' on '{stream}' to {start_id}"
                )
            else:
                raise

    @staticmethod
    def _to_stream_id(timestamp: str) -> str:
        """Convert ISO 8601 timestamp to Redis stream ID."""
        if "-" in timestamp and timestamp[0].isdigit() and len(timestamp) < 30:
            return timestamp  # Already a stream ID
        dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        ms = int(dt.timestamp() * 1000)
        return f"{ms}-0"

    @staticmethod
    def _increment_id(stream_id: bytes | str) -> str:
        """Increment a Redis stream ID to get the next exclusive start."""
        id_str = stream_id.decode() if isinstance(stream_id, bytes) else stream_id
        parts = id_str.split("-")
        return f"{parts[0]}-{int(parts[1]) + 1}"
```

### 9.3 Replay Use Cases

| Use Case | Replay Mode | Description |
|----------|-------------|-------------|
| Post-incident debugging | Time-range | Replay all events from 5 minutes before the incident to 5 minutes after. Correlate with traces in the Observability Platform. |
| New subscriber bootstrap | Consumer rebuild | A newly deployed subscriber (e.g., a new analytics service) needs to process all historical events to build its state. Create a consumer group starting from stream position `0`. |
| Evaluation regression analysis | Event-type | Replay only `eval.completed` and `eval.regression_detected` events to understand the regression timeline. |
| State reconstruction | Time-range + filter | After a subscriber data loss, replay events filtered to that subscriber's event types to reconstruct its state. |

---

## 10. Event Schema Registry

### 10.1 Registry Design

The Schema Registry is the central authority for event data schemas. Every event type has a registered schema that defines the structure of its `data` field. The registry enforces validation at publish time and manages schema evolution with backward compatibility.

This is analogous to how the Prompt Registry (subsystem 07) versions prompt templates -- but for event contracts instead of agent instructions.

```
┌──────────────────────────────────────────────────┐
│                Schema Registry                   │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │  Schema Store (PostgreSQL)                │   │
│  │                                           │   │
│  │  event_type    │ version │ schema (JSON)  │   │
│  │  ──────────────┼─────────┼───────────────  │  │
│  │  agent.created │  1.0.0  │ { ... }        │   │
│  │  agent.created │  1.1.0  │ { ... }        │   │
│  │  agent.deployed│  1.0.0  │ { ... }        │   │
│  │  ...           │  ...    │  ...           │   │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │  Compatibility Checker                    │   │
│  │                                           │   │
│  │  - BACKWARD: new schema reads old data    │   │
│  │  - FORWARD: old schema reads new data     │   │
│  │  - FULL: both directions                  │   │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │  Validation Cache (Redis)                 │   │
│  │                                           │   │
│  │  Compiled JSON Schema validators          │   │
│  │  cached per event_type + version          │   │
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
```

### 10.2 Schema Registration and Validation

```python
import json
import logging
from typing import Any, Optional
from dataclasses import dataclass
from enum import Enum

import jsonschema

from agentforge.events.schema import Event


logger = logging.getLogger("agentforge.events.registry")


class CompatibilityMode(Enum):
    BACKWARD = "backward"   # New schema can read data written by old schema
    FORWARD = "forward"     # Old schema can read data written by new schema
    FULL = "full"           # Both backward and forward compatible
    NONE = "none"           # No compatibility check (use with caution)


@dataclass
class ValidationResult:
    valid: bool
    errors: list[str]


class SchemaRegistry:
    """
    Central registry for event data schemas.

    Stores versioned JSON Schemas for every event type's data field.
    Validates events at publish time. Enforces compatibility rules
    when new schema versions are registered.

    All schemas are cached in memory after first load for
    sub-millisecond validation performance.
    """

    def __init__(self, db_connection, redis_client=None):
        self._db = db_connection
        self._redis = redis_client
        self._cache: dict[str, jsonschema.Draft7Validator] = {}

    async def register(
        self,
        event_type: str,
        version: str,
        schema: dict[str, Any],
        compatibility: CompatibilityMode = CompatibilityMode.BACKWARD,
    ) -> None:
        """
        Register a new schema version for an event type.

        If a previous version exists and compatibility is not NONE,
        validates that the new schema is compatible with the latest
        existing version.
        """
        # Check compatibility with existing schemas
        if compatibility != CompatibilityMode.NONE:
            latest = await self._get_latest_schema(event_type)
            if latest is not None:
                self._check_compatibility(latest, schema, compatibility)

        # Store in database
        await self._db.execute(
            """
            INSERT INTO event_schemas (event_type, version, schema, compatibility_mode)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (event_type, version) DO UPDATE SET schema = $3
            """,
            event_type,
            version,
            json.dumps(schema),
            compatibility.value,
        )

        # Invalidate cache
        cache_key = f"{event_type}:{version}"
        self._cache.pop(cache_key, None)
        if self._redis:
            await self._redis.delete(f"schema_cache:{cache_key}")

        logger.info(f"Registered schema: {event_type} v{version}")

    def validate(self, event: Event) -> ValidationResult:
        """
        Validate an event's data field against its registered schema.
        Uses cached compiled validators for performance.
        """
        cache_key = f"{event.type}:{event.metadata.schema_version}"
        validator = self._cache.get(cache_key)

        if validator is None:
            # Load and compile schema (synchronous for publish-path performance)
            schema = self._load_schema_sync(event.type, event.metadata.schema_version)
            if schema is None:
                return ValidationResult(
                    valid=False,
                    errors=[f"No schema registered for {event.type} v{event.metadata.schema_version}"],
                )
            validator = jsonschema.Draft7Validator(schema)
            self._cache[cache_key] = validator

        errors = list(validator.iter_errors(event.data))
        if errors:
            return ValidationResult(
                valid=False,
                errors=[f"{e.path}: {e.message}" for e in errors],
            )
        return ValidationResult(valid=True, errors=[])

    def _check_compatibility(
        self,
        old_schema: dict,
        new_schema: dict,
        mode: CompatibilityMode,
    ) -> None:
        """
        Verify schema compatibility between versions.

        BACKWARD: All fields required in old schema must exist in new schema.
                  New schema may add optional fields.
        FORWARD:  All fields required in new schema must exist in old schema.
        FULL:     Both backward and forward compatible.
        """
        old_required = set(old_schema.get("required", []))
        new_required = set(new_schema.get("required", []))
        old_props = set(old_schema.get("properties", {}).keys())
        new_props = set(new_schema.get("properties", {}).keys())

        if mode in (CompatibilityMode.BACKWARD, CompatibilityMode.FULL):
            # New schema must still accept data written under old schema
            removed_fields = old_props - new_props
            if removed_fields:
                raise SchemaCompatibilityError(
                    f"Backward incompatible: fields removed: {removed_fields}"
                )
            new_required_additions = new_required - old_required
            if new_required_additions:
                raise SchemaCompatibilityError(
                    f"Backward incompatible: new required fields: {new_required_additions}"
                )

        if mode in (CompatibilityMode.FORWARD, CompatibilityMode.FULL):
            # Old schema must still accept data written under new schema
            newly_required = new_required - old_required
            for field in newly_required:
                if field not in old_props:
                    raise SchemaCompatibilityError(
                        f"Forward incompatible: new required field '{field}' "
                        f"not present in old schema"
                    )

    async def _get_latest_schema(self, event_type: str) -> Optional[dict]:
        """Fetch the latest registered schema for an event type."""
        row = await self._db.fetchrow(
            """
            SELECT schema FROM event_schemas
            WHERE event_type = $1
            ORDER BY version DESC LIMIT 1
            """,
            event_type,
        )
        return json.loads(row["schema"]) if row else None

    def _load_schema_sync(self, event_type: str, version: str) -> Optional[dict]:
        """Synchronous schema load for the hot publish path."""
        # In production, pre-warm the cache at startup
        # This fallback uses a sync DB call
        raise NotImplementedError("Pre-warm cache at startup; see SchemaRegistry.warmup()")

    async def warmup(self) -> None:
        """Pre-load all schemas into the in-memory cache at startup."""
        rows = await self._db.fetch("SELECT event_type, version, schema FROM event_schemas")
        for row in rows:
            cache_key = f"{row['event_type']}:{row['version']}"
            schema = json.loads(row["schema"])
            self._cache[cache_key] = jsonschema.Draft7Validator(schema)
        logger.info(f"Schema cache warmed: {len(rows)} schemas loaded")


class SchemaCompatibilityError(Exception):
    """Raised when a new schema version breaks compatibility rules."""
    pass
```

### 10.3 Schema Evolution Rules

| Rule | Policy | Example |
|------|--------|---------|
| Add optional field | Always allowed | Add `deployment_region` to `agent.deployed` v1.1.0 |
| Add required field | Allowed with default value | Add `severity` to `guardrail.violation` -- old events default to `"medium"` |
| Remove field | Requires major version bump | Remove `input_hash` from `tool.invoked` v2.0.0 |
| Rename field | Not allowed | Use add + deprecate instead |
| Change field type | Requires major version bump | Change `retry_count` from int to string requires v2.0.0 |
| Widen field type | Allowed as minor version | Widen `status` enum from `["ok","error"]` to `["ok","error","timeout"]` |

### 10.4 Example Schema Registration

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "agent.deployed v1.0.0",
  "type": "object",
  "required": ["agent_id", "version", "deployment_target"],
  "properties": {
    "agent_id": {
      "type": "string",
      "description": "Unique identifier of the deployed agent"
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Semantic version of the agent"
    },
    "deployment_target": {
      "type": "string",
      "enum": ["development", "staging", "production"],
      "description": "Target environment"
    },
    "previous_version": {
      "type": "string",
      "description": "Version being replaced (null for first deployment)"
    }
  },
  "additionalProperties": false
}
```

---

## 11. API Surface

### 11.1 REST API Endpoints

The Event Bus exposes an HTTP API for management, inspection, and replay operations. Publishing and subscribing use the Python client directly (not HTTP) for latency-sensitive paths.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/events/publish` | Publish an event (HTTP fallback for external integrations) |
| `GET` | `/api/v1/events/streams` | List all event streams with metadata |
| `GET` | `/api/v1/events/streams/{stream}/messages` | Read messages from a stream (paginated) |
| `GET` | `/api/v1/events/streams/{stream}/groups` | List consumer groups and their lag |
| `POST` | `/api/v1/events/replay` | Initiate an event replay operation |
| `GET` | `/api/v1/events/replay/{replay_id}` | Check replay operation status |
| `GET` | `/api/v1/events/dlq` | List DLQ entries (paginated, filterable) |
| `POST` | `/api/v1/events/dlq/{entry_id}/retry` | Retry a DLQ entry |
| `DELETE` | `/api/v1/events/dlq/{entry_id}` | Discard a DLQ entry |
| `GET` | `/api/v1/events/dlq/stats` | DLQ depth, age distribution, error categories |
| `POST` | `/api/v1/events/schemas` | Register a new event schema version |
| `GET` | `/api/v1/events/schemas/{event_type}` | List all schema versions for an event type |
| `GET` | `/api/v1/events/schemas/{event_type}/{version}` | Get a specific schema version |
| `POST` | `/api/v1/events/schemas/{event_type}/validate` | Validate a payload against a schema |
| `GET` | `/api/v1/events/catalog` | List all registered event types with descriptions |
| `GET` | `/api/v1/events/health` | Event Bus health check (stream connectivity, consumer lag) |

### 11.2 API Request/Response Examples

**Publish an event (HTTP)**

```
POST /api/v1/events/publish
Content-Type: application/json

{
  "type": "integration.webhook_received",
  "data": {
    "connector_id": "slack-connector-01",
    "service_name": "slack",
    "webhook_type": "message.received",
    "payload_hash": "sha256:abc123..."
  },
  "subject": "connector:slack-connector-01",
  "correlation_id": "req-ext-001"
}

Response: 201 Created
{
  "event_id": "evt-550e8400-e29b-41d4-a716-446655440000",
  "stream": "events:integration",
  "stream_id": "1709044330847-0"
}
```

**Initiate a replay**

```
POST /api/v1/events/replay
Content-Type: application/json

{
  "stream": "events:agent",
  "from_timestamp": "2026-02-27T14:00:00Z",
  "to_timestamp": "2026-02-27T14:30:00Z",
  "event_types": ["agent.failed", "agent.rollback"],
  "target_group": "incident-debug-20260227",
  "max_events": 5000
}

Response: 202 Accepted
{
  "replay_id": "rpl-7890abcd",
  "status": "running",
  "estimated_events": 847
}
```

**List DLQ entries**

```
GET /api/v1/events/dlq?source_stream=events:eval&limit=10

Response: 200 OK
{
  "entries": [
    {
      "dlq_message_id": "1709044330847-0",
      "event_id": "evt-aaa111",
      "event_type": "eval.completed",
      "source_stream": "events:eval",
      "consumer_group": "agent-builder",
      "failure_timestamp": "2026-02-27T14:32:10.847Z",
      "retry_count": 3,
      "last_error": "TimeoutError: eval service did not respond",
      "error_category": "transient",
      "age_seconds": 3847
    }
  ],
  "total": 1,
  "dlq_depth": 1
}
```

### 11.3 Internal Python API Summary

```python
# --- Publishing ---
publisher = EventPublisher(redis, schema_registry, source="subsystem:agent-builder")
event_id = await publisher.publish("agent.deployed", data={...})
event_ids = await publisher.publish_batch([("agent.deployed", {...}), ("deployment.started", {...})])

# --- Subscribing ---
subscriber = EventSubscriber(redis, group="eval-framework", consumer="eval-1")
subscriber.subscribe("events:agent", handler=my_handler, filter=my_filter)
await subscriber.start()
await subscriber.stop()

# --- DLQ Management ---
dlq = DLQHandler(redis)
entries = await dlq.inspect(source_stream="events:eval")
await dlq.retry(dlq_message_id="1709044330847-0")
await dlq.discard(dlq_message_id="...", reason="Known bug, event irrelevant")
depth = await dlq.get_depth()

# --- Event Replay ---
engine = ReplayEngine(redis)
async for event in engine.replay(ReplayRequest(stream="events:agent", from_timestamp="...", to_timestamp="...")):
    process(event)
await engine.rebuild_consumer_group("events:agent", "new-subscriber", start_id="0")

# --- Schema Registry ---
registry = SchemaRegistry(db, redis)
await registry.register("agent.deployed", "1.0.0", schema={...})
result = registry.validate(event)
await registry.warmup()
```

---

## 12. Failure Modes & Mitigations

### 12.1 Failure Matrix

| # | Failure Mode | Impact | Detection | Mitigation |
|---|-------------|--------|-----------|------------|
| 1 | **Redis node down** | All event publishing and consuming halts | Health check returns unhealthy; connection errors on publish/subscribe | Redis Sentinel or Cluster for automatic failover. Publisher retries with backoff. Subscribers reconnect automatically. |
| 2 | **Publisher crashes mid-publish** | Event may or may not have been written (at-most-once for that event) | Missing events detected by Observability Platform gap detection | Publisher retry on startup. Idempotency key prevents duplicates if the event did land. |
| 3 | **Consumer crashes mid-processing** | Event stuck in PEL, not acknowledged | PEL monitoring by PendingEntryClaimer; consumer lag increases | XAUTOCLAIM reclaims stale entries after idle threshold. Event redelivered to another consumer in the group. |
| 4 | **Schema validation failure** | Event rejected at publish time | EventSchemaError raised to publisher; logged to Observability | Publisher receives synchronous error. Fix data payload. Schema mismatch metrics trigger alerts. |
| 5 | **DLQ overflow** | Unprocessed failed events accumulate | DLQ depth metric exceeds threshold | Auto-retry scheduler for transient errors. Alerting at depth thresholds. Manual review UI for permanent failures. |
| 6 | **Consumer group lag growing** | Subscribers fall behind on processing | Consumer lag metric per group per stream | Auto-scale consumer instances. Alert when lag exceeds SLA threshold. Backpressure signals to publishers. |
| 7 | **Stream memory exhaustion** | Redis OOM, all operations fail | Redis memory usage metric > 80% threshold | MAXLEN on XADD caps stream size. Configurable retention TTL. Older events trimmed automatically. |
| 8 | **Schema registry unavailable** | Cannot validate events at publish time | Health check on schema cache status | In-memory schema cache operates independently of DB. Warm cache at startup. Fail-open with warning if cache is cold and DB is down. |
| 9 | **Network partition** | Publishers cannot reach Redis; subscribers see stale data | Connection error metrics; split-brain detection | Redis Sentinel handles leader election. Publishers buffer to local queue and flush when reconnected. |
| 10 | **Poison message** | An event causes every consumer to crash repeatedly | Same event reclaimed repeatedly; DLQ fill rate spikes | After N failed claims, event is automatically moved to DLQ with `error_category: poison`. |

### 12.2 Circuit Breaker Pattern

Following the exception handling strategy (p. 206-209), the Event Bus client implements a circuit breaker to prevent cascading failures when Redis is unhealthy:

```python
from enum import Enum
from time import time


class CircuitState(Enum):
    CLOSED = "closed"       # Normal operation
    OPEN = "open"           # All calls fail immediately
    HALF_OPEN = "half_open" # Testing if service recovered


class CircuitBreaker:
    """
    Circuit breaker for Event Bus operations.

    Prevents cascading failures when Redis is unhealthy by
    fast-failing publish/subscribe operations instead of
    blocking on timeouts.

    States:
    - CLOSED: Normal operation. Track failure count.
    - OPEN: All operations fail immediately with CircuitOpenError.
            Transitions to HALF_OPEN after reset_timeout_s.
    - HALF_OPEN: Allow one probe request. Success -> CLOSED, failure -> OPEN.
    """

    def __init__(
        self,
        failure_threshold: int = 5,
        reset_timeout_s: float = 30.0,
    ):
        self._failure_threshold = failure_threshold
        self._reset_timeout = reset_timeout_s
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._last_failure_time = 0.0

    @property
    def state(self) -> CircuitState:
        if self._state == CircuitState.OPEN:
            if time() - self._last_failure_time >= self._reset_timeout:
                self._state = CircuitState.HALF_OPEN
        return self._state

    def record_success(self) -> None:
        self._failure_count = 0
        self._state = CircuitState.CLOSED

    def record_failure(self) -> None:
        self._failure_count += 1
        self._last_failure_time = time()
        if self._failure_count >= self._failure_threshold:
            self._state = CircuitState.OPEN

    def allow_request(self) -> bool:
        state = self.state
        if state == CircuitState.CLOSED:
            return True
        if state == CircuitState.HALF_OPEN:
            return True  # Allow probe
        return False  # OPEN -- fail fast
```

### 12.3 Graceful Degradation

When the Event Bus is degraded, subsystems follow this fallback hierarchy (aligned with Resource-Aware Optimization, p. 255):

1. **Healthy**: All events published and consumed normally.
2. **Degraded (high latency)**: Non-critical events (e.g., `tool.invoked`) are batched and published at reduced frequency. Critical events (e.g., `guardrail.violation`) maintain real-time delivery.
3. **Unavailable**: Publishers buffer events to a local in-process queue (bounded size). When connectivity is restored, the buffer is flushed. Subscribers retry connection with exponential backoff.
4. **Extended outage**: Local buffer fills up. Oldest non-critical events are dropped. Critical events are written to a local WAL (write-ahead log) file for guaranteed recovery.

---

## 13. Instrumentation

The Event Bus emits its own telemetry to the Observability Platform (subsystem 05). All metrics follow the OpenTelemetry conventions established in the Observability Platform design.

### 13.1 Metrics

| Metric Name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `eventbus.publish.count` | Counter | `stream`, `event_type`, `status` | Total events published (success/failure) |
| `eventbus.publish.latency_ms` | Histogram | `stream`, `event_type` | Time from publish call to stream ACK |
| `eventbus.publish.batch_size` | Histogram | `stream` | Number of events per batch publish |
| `eventbus.consume.count` | Counter | `stream`, `group`, `event_type`, `status` | Total events consumed (success/failure/filtered) |
| `eventbus.consume.latency_ms` | Histogram | `stream`, `group`, `event_type` | Time from event delivery to ACK |
| `eventbus.consumer.lag` | Gauge | `stream`, `group` | Number of unprocessed events per consumer group |
| `eventbus.consumer.active_count` | Gauge | `stream`, `group` | Number of active consumers in a group |
| `eventbus.dlq.depth` | Gauge | | Total entries in the Dead Letter Queue |
| `eventbus.dlq.ingest.count` | Counter | `source_stream`, `error_category` | Events moved to DLQ |
| `eventbus.dlq.retry.count` | Counter | `source_stream`, `status` | DLQ retry attempts (success/failure) |
| `eventbus.dlq.age_seconds` | Histogram | | Age of entries currently in the DLQ |
| `eventbus.replay.count` | Counter | `stream`, `status` | Replay operations executed |
| `eventbus.replay.events_delivered` | Counter | `stream`, `replay_id` | Events delivered during replay |
| `eventbus.schema.validation.count` | Counter | `event_type`, `status` | Schema validations (pass/fail) |
| `eventbus.schema.registration.count` | Counter | `event_type` | New schema versions registered |
| `eventbus.stream.length` | Gauge | `stream` | Current number of entries per stream |
| `eventbus.stream.memory_bytes` | Gauge | `stream` | Memory usage per stream |
| `eventbus.circuit_breaker.state` | Gauge | | Circuit breaker state (0=closed, 1=open, 2=half_open) |
| `eventbus.pel.depth` | Gauge | `stream`, `group` | Pending Entries List size (unacknowledged events) |
| `eventbus.pel.claimed` | Counter | `stream`, `group` | Stale entries reclaimed by PendingEntryClaimer |

### 13.2 Alerts

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| `EventBusPublishFailure` | `eventbus.publish.count{status=failure}` > 10/min | High | Investigate Redis connectivity. Check circuit breaker state. |
| `ConsumerLagHigh` | `eventbus.consumer.lag` > 1000 for any group | Warning | Scale consumer instances. Check handler performance. |
| `ConsumerLagCritical` | `eventbus.consumer.lag` > 10000 for any group | Critical | Immediate investigation. Possible consumer crash or poison message. |
| `DLQDepthWarning` | `eventbus.dlq.depth` > 10 | Warning | Review DLQ entries. Check for transient failures. |
| `DLQDepthCritical` | `eventbus.dlq.depth` > 50 | Critical | Page on-call. Immediate manual review required. |
| `SchemaValidationSpike` | `eventbus.schema.validation.count{status=fail}` > 5/min | High | Publisher sending malformed events. Check recent deployments. |
| `StreamMemoryHigh` | `eventbus.stream.memory_bytes` > 80% of configured limit | Warning | Review retention policies. Consider increasing MAXLEN. |
| `CircuitBreakerOpen` | `eventbus.circuit_breaker.state` == 1 (open) | Critical | Redis is unreachable. Check infrastructure health. |
| `PELGrowth` | `eventbus.pel.depth` > 100 for any group | High | Consumers are crashing or hanging. Check handler logs. |

### 13.3 Dashboard Panels

The Event Bus dashboard in Grafana provides the following views:

1. **Overview**: Total event throughput (publish/consume), DLQ depth, circuit breaker state.
2. **Per-Stream Detail**: Throughput, consumer lag, stream length, memory usage for each stream.
3. **Consumer Groups**: Lag per group, active consumer count, processing latency P50/P95/P99.
4. **DLQ Monitor**: Entry count over time, age distribution, error category breakdown, retry success rate.
5. **Schema Health**: Validation pass/fail rates, recent schema registrations, compatibility check results.
6. **Replay Operations**: Active replays, events delivered, replay duration.

### 13.4 Structured Log Events

All Event Bus operations emit structured log entries following the Observability Platform's schema conventions:

```json
{
  "timestamp": "2026-02-27T14:32:10.847Z",
  "level": "INFO",
  "logger": "agentforge.events.publisher",
  "message": "Published event",
  "event_id": "evt-550e8400",
  "event_type": "agent.deployed",
  "stream": "events:agent",
  "stream_id": "1709044330847-0",
  "attempt": 1,
  "latency_ms": 2.3,
  "trace_id": "tr-8f3a2b4c",
  "span_id": "sp-evt-001"
}
```

---

## 14. Cross-Subsystem Event Flow Examples

### 14.1 Agent Deployment with Post-Deploy Evaluation

This example shows how the Event Bus coordinates the deployment workflow across Agent Builder, Evaluation Framework, and Prompt Registry without any direct coupling between them. Goal completion events trigger downstream workflows (p. 183).

```
Agent Builder         Event Bus           Eval Framework         Prompt Registry
     │                    │                      │                      │
     │ agent.deployed     │                      │                      │
     │───────────────────>│                      │                      │
     │                    │  agent.deployed       │                      │
     │                    │─────────────────────>│                      │
     │                    │                      │                      │
     │                    │                      │  (run eval suite)    │
     │                    │                      │                      │
     │                    │  eval.completed       │                      │
     │                    │<─────────────────────│                      │
     │                    │                      │                      │
     │                    │                      │ eval.regression_detected
     │                    │<─────────────────────│                      │
     │                    │                      │                      │
     │  eval.regression   │                      │                      │
     │  _detected         │                      │                      │
     │<───────────────────│                      │                      │
     │                    │                      │   eval.regression    │
     │                    │                      │   _detected          │
     │                    │──────────────────────┼─────────────────────>│
     │                    │                      │                      │
     │ agent.rollback     │                      │   prompt.rollback    │
     │───────────────────>│                      │<─────────────────────│
     │                    │                      │                      │
```

### 14.2 Guardrail Violation Cascade

This example shows how a guardrail violation event (p. 297) ripples through the system, triggering safety alerts and budget adjustments:

```
Tool & MCP Mgr   Guardrail System    Event Bus        Observability    Cost Manager
     │                  │                │                  │               │
     │  tool.invoked    │                │                  │               │
     │─────────────────────────────────>│                  │               │
     │                  │                │  tool.invoked    │               │
     │                  │                │────────────────>│               │
     │                  │  tool.invoked  │                  │               │
     │                  │<───────────────│                  │               │
     │                  │                │                  │               │
     │                  │  (policy check │                  │               │
     │                  │   detects      │                  │               │
     │                  │   violation)   │                  │               │
     │                  │                │                  │               │
     │                  │ guardrail      │                  │               │
     │                  │ .violation     │                  │               │
     │                  │───────────────>│                  │               │
     │                  │                │  guardrail       │               │
     │                  │                │  .violation      │               │
     │                  │                │────────────────>│               │
     │                  │                │                  │(log + alert)  │
     │                  │                │  guardrail       │               │
     │                  │                │  .violation      │               │
     │                  │                │─────────────────────────────────>│
     │                  │                │                  │  (track cost  │
     │                  │                │                  │   of blocked  │
     │                  │                │                  │   action)     │
```

---

*This document defines the Event Bus subsystem of the AgentForge Agentic Orchestration Platform. It should be read alongside the System Overview (00), Observability Platform (05), and Memory & Context Management (11) documents, which are the primary consumers and producers of events in the platform.*
