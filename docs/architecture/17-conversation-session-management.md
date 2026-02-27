# Subsystem 17: Conversation & Session Management

## 1. Overview & Responsibility

The Conversation & Session Management subsystem is the **user-facing interaction layer** of AgentForge. It owns the full lifecycle of every end-user conversation with the platform: accepting messages from any supported channel, routing them to the correct agent or team, streaming responses in real time, managing session state across connections, orchestrating agent-to-human handoffs, and supporting multiple concurrent conversation threads per user.

This subsystem sits at the boundary between external users and the internal agent infrastructure. Every user message enters through it, and every agent response exits through it. It is the single surface that unifies API consumers, WebSocket clients, Slack workspaces, Telegram bots, and embedded web widgets into one coherent conversation model.

Without this subsystem, agents would have no standardized way to receive user input or deliver output. With it, the platform provides channel-agnostic conversation management with session persistence, real-time streaming, graceful recovery from disconnections, and seamless escalation to human operators when agents reach their limits.

### Core Responsibilities

| # | Responsibility | Pattern Reference |
|---|---------------|-------------------|
| 1 | **Session Lifecycle**: Create, activate, pause, resume, and close conversation sessions | Memory Management (p. 148) — Session scoping |
| 2 | **Multi-Channel Support**: Unified message model across API, WebSocket, Slack, Telegram, web widget | A2A Communication (p. 246) — SSE streaming |
| 3 | **Conversation Routing**: Direct incoming messages to the correct team or agent | Routing (p. 25) — LLM-based routing, default fallback (p. 27) |
| 4 | **Real-Time Streaming**: Token-by-token delivery via SSE and WebSocket | A2A Communication (p. 246) — SSE for streaming |
| 5 | **Agent-to-Human Handoff**: Full context transfer to human operators and handback | HITL (p. 210) — Four interaction modes, full context (p. 213) |
| 6 | **Session State Persistence**: Durable session state with recovery after failures | Memory Management (p. 151) — State prefix system, Exception Handling (p. 209) |
| 7 | **Conversation Threading**: Multiple concurrent conversations per user | Memory Management (p. 148) — Session scoping prevents cross-user bleed |
| 8 | **Typing Indicators & Read Receipts**: Real-time presence signals for user experience | A2A Communication (p. 246) — SSE event types |

### Architecture Diagram

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                 Conversation & Session Management Subsystem                    │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                       Channel Adapters Layer                            │  │
│  │                                                                         │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │  │
│  │  │  REST    │ │WebSocket │ │  Slack   │ │ Telegram │ │  Web Widget  │  │  │
│  │  │  API     │ │  Server  │ │ Adapter  │ │ Adapter  │ │  Adapter     │  │  │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘  │  │
│  │       │             │            │             │              │          │  │
│  │       └─────────────┴────────┬───┴─────────────┴──────────────┘          │  │
│  │                              │                                           │  │
│  │                   ┌──────────┴──────────┐                                │  │
│  │                   │  Unified Message    │                                │  │
│  │                   │  Normalizer         │                                │  │
│  │                   └──────────┬──────────┘                                │  │
│  └──────────────────────────────┼──────────────────────────────────────────┘  │
│                                 │                                              │
│  ┌──────────────────────────────┼──────────────────────────────────────────┐  │
│  │                      Core Session Engine                                │  │
│  │                                                                         │  │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │  │
│  │  │  Session Manager │  │  Conversation    │  │  Handoff Controller  │  │  │
│  │  │                  │  │  Router          │  │                      │  │  │
│  │  │ - create         │  │                  │  │ - agent_to_human     │  │  │
│  │  │ - activate       │  │ - classify       │  │ - human_to_agent     │  │  │
│  │  │ - pause          │  │ - route          │  │ - context_transfer   │  │  │
│  │  │ - resume         │  │ - fallback       │  │ - timeout_watchdog   │  │  │
│  │  │ - close          │  │ - rebalance      │  │ - safe_default       │  │  │
│  │  └────────┬─────────┘  └────────┬─────────┘  └──────────┬───────────┘  │  │
│  │           │                     │                        │              │  │
│  │  ┌────────┴─────────────────────┴────────────────────────┴───────────┐  │  │
│  │  │                    Session State Store                             │  │  │
│  │  │  prefix: session:  │  prefix: conv:  │  prefix: handoff:          │  │  │
│  │  └───────────────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────────────────┐ │
│  │  Stream Emitter  │  │  Thread Manager  │  │  Presence Tracker           │ │
│  │                  │  │                  │  │                             │ │
│  │ - SSE push       │  │ - thread_create  │  │ - typing_indicator          │ │
│  │ - WS push        │  │ - thread_list    │  │ - read_receipt              │ │
│  │ - webhook push   │  │ - thread_switch  │  │ - online/offline            │ │
│  │ - token stream   │  │ - thread_archive │  │ - agent_status              │ │
│  └──────────────────┘  └──────────────────┘  └─────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────┘
         │                       │                       │
    ┌────┴────┐             ┌────┴────┐             ┌────┴────┐
    │  Team   │             │ Memory  │             │Observ-  │
    │Orchestr.│             │ & Ctx   │             │ability  │
    └─────────┘             └─────────┘             └─────────┘
```

### Relationship to Other Subsystems

| Subsystem | Integration Point |
|-----------|------------------|
| Team Orchestrator (02) | Receives routed messages and returns agent responses; supervisor orchestrates which agent handles the conversation |
| Tool & MCP Manager (03) | Agents invoked during conversations use tools registered in the MCP Manager |
| Guardrail System (04) | All inbound user messages pass through input validation (p. 286); all outbound responses pass through output filtering (p. 286) |
| Observability Platform (05) | Every session event (create, message, handoff, close) emitted as a trace span; conversation metrics tracked |
| Memory & Context Management (11) | Session state persisted via the state prefix system (p. 151); conversation history stored in working and long-term memory |
| External Integrations Hub (12) | Slack and Telegram adapters use connectors registered in the integrations hub |

---

## 2. Session Schema

Every conversation session is represented by a durable session object. This schema captures the full state needed to resume a session after any interruption, route messages correctly, and transfer context during handoffs.

### 2.1 Session Definition

```json
{
  "session_id": "sess_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "conversation_id": "conv_f9e8d7c6-b5a4-3210-fedc-ba9876543210",
  "thread_id": "thr_00000000-0000-0000-0000-000000000001",
  "organization_id": "org_acme-corp",

  "status": "active",
  "status_history": [
    { "status": "created", "at": "2026-02-27T10:00:00Z", "by": "system" },
    { "status": "active", "at": "2026-02-27T10:00:01Z", "by": "system" }
  ],

  "user": {
    "user_id": "usr_jane-doe-12345",
    "display_name": "Jane Doe",
    "locale": "en-US",
    "timezone": "America/New_York",
    "metadata": {
      "plan": "enterprise",
      "account_age_days": 342
    }
  },

  "channel": {
    "type": "websocket",
    "channel_id": "ws_conn_abc123",
    "capabilities": ["streaming", "typing_indicator", "read_receipt", "file_upload"],
    "client_info": {
      "sdk_version": "1.4.0",
      "platform": "web",
      "user_agent": "AgentForge-Widget/1.4.0"
    }
  },

  "routing": {
    "assigned_team": "team-support",
    "assigned_agent": "agent:support-triage",
    "routing_reason": "intent_classification: billing_inquiry",
    "routing_confidence": 0.94,
    "fallback_agent": "agent:general-assistant",
    "routed_at": "2026-02-27T10:00:01Z"
  },

  "handoff": {
    "active": false,
    "current_operator": null,
    "handoff_history": []
  },

  "conversation_state": {
    "message_count": 12,
    "turn_count": 6,
    "first_message_at": "2026-02-27T10:00:01Z",
    "last_message_at": "2026-02-27T10:15:32Z",
    "last_activity_at": "2026-02-27T10:15:32Z",
    "goals": {
      "primary": "resolve_billing_inquiry",
      "goals_met": false,
      "goal_progress": 0.6
    },
    "context_summary": "User asking about unexpected charge on Feb invoice. Agent identified charge as pro-rata upgrade fee. Awaiting user confirmation."
  },

  "history": {
    "storage_ref": "memory://conv:conv_f9e8d7c6/history",
    "message_count": 12,
    "truncated": false,
    "summary_available": true
  },

  "configuration": {
    "idle_timeout_seconds": 1800,
    "max_session_duration_seconds": 86400,
    "max_messages": 500,
    "streaming_enabled": true,
    "auto_close_on_goal_met": false,
    "language_detection": true,
    "guardrail_policies": ["input-validation", "pii-redaction", "content-safety"]
  },

  "metadata": {
    "created_at": "2026-02-27T10:00:00Z",
    "updated_at": "2026-02-27T10:15:32Z",
    "version": 14,
    "trace_id": "trace_xyz789",
    "tags": ["billing", "enterprise", "high-priority"]
  }
}
```

### 2.2 Session State Prefix Mapping

Building on the platform state prefix system (p. 151), the Conversation & Session Management subsystem uses dedicated prefixes:

```python
# Session-scoped state (ephemeral, per-session)
"session:{session_id}:status"                  # Current session status
"session:{session_id}:routing"                 # Current routing assignment
"session:{session_id}:channel"                 # Channel connection info
"session:{session_id}:last_activity"           # Last activity timestamp

# Conversation-scoped state (persistent, per-conversation)
"conv:{conversation_id}:history"               # Full message history
"conv:{conversation_id}:summary"               # Rolling conversation summary
"conv:{conversation_id}:goals"                 # Conversation goal tracking
"conv:{conversation_id}:context"               # Active context for agent

# Handoff-scoped state (transient, per-handoff event)
"handoff:{handoff_id}:context_snapshot"        # Frozen context for human operator
"handoff:{handoff_id}:operator"                # Assigned human operator
"handoff:{handoff_id}:status"                  # Handoff lifecycle status

# Thread-scoped state (persistent, per-thread)
"thread:{thread_id}:parent_conversation"       # Parent conversation reference
"thread:{thread_id}:topic"                     # Thread topic / subject

# User-scoped state (long-term, cross-session)
"user:{user_id}:active_sessions"               # List of active session IDs
"user:{user_id}:preferences"                   # Channel & notification preferences
"user:{user_id}:conversation_history"          # Historical conversation index
```

---

## 3. Session Lifecycle State Machine

Sessions follow a strict state machine that governs valid transitions. Every transition is logged as a trace event for full auditability.

### 3.1 State Machine Diagram

```
                    ┌──────────────────────────────────────────────────┐
                    │           Session Lifecycle State Machine         │
                    │                                                    │
                    │                                                    │
                    │         ┌─────────┐                               │
                    │         │ CREATED │                               │
                    │         └────┬────┘                               │
                    │              │ agent_assigned                     │
                    │              ▼                                    │
                    │         ┌─────────┐   idle_timeout   ┌────────┐  │
                    │    ┌───>│ ACTIVE  │────────────────>│ PAUSED │  │
                    │    │    └────┬────┘                  └───┬────┘  │
                    │    │         │                           │        │
                    │    │         │ handoff_initiated          │ user_  │
                    │    │         ▼                           │ returns│
                    │    │    ┌──────────┐                     │        │
                    │    │    │ HANDED   │                     │        │
                    │    │    │ OFF      │                     │        │
                    │    │    └────┬─────┘                     │        │
                    │    │         │ handback_completed         │        │
                    │    │         ▼                           │        │
                    │    │    ┌─────────┐                      │        │
                    │    └────│ RESUMED │<─────────────────────┘        │
                    │         └────┬────┘                               │
                    │              │                                    │
                    │              │ goal_met | user_closes |           │
                    │              │ max_duration | admin_close         │
                    │              ▼                                    │
                    │         ┌─────────┐                               │
                    │         │ CLOSED  │                               │
                    │         └─────────┘                               │
                    │                                                    │
                    │  Any state ──── error ───> CLOSED (with reason)   │
                    └──────────────────────────────────────────────────┘
```

### 3.2 State Transition Table

| From | To | Trigger | Side Effects |
|------|----|---------|-------------|
| `created` | `active` | Agent assigned by router | Start idle timer, emit `session.activated` event |
| `active` | `paused` | Idle timeout (configurable, default 30min) | Persist state to durable store, release agent, emit `session.paused` |
| `active` | `handed_off` | Agent triggers handoff (HITL escalation, p. 210) | Snapshot context, notify human queue, emit `session.handoff_started` |
| `active` | `closed` | User explicitly closes, goal met (p. 188), max duration | Persist final state, archive history, emit `session.closed` |
| `paused` | `resumed` | User sends new message | Reload state from durable store, re-assign agent, emit `session.resumed` |
| `paused` | `closed` | Pause timeout (configurable, default 24h) | Archive and clean up, emit `session.closed` |
| `handed_off` | `resumed` | Human operator completes and hands back | Transfer context back, re-assign agent, emit `session.handback` |
| `handed_off` | `closed` | Human operator resolves without handback | Persist final state, emit `session.closed` |
| `resumed` | `active` | Automatic (immediate transition) | Reset idle timer, continue conversation |
| Any | `closed` | Unrecoverable error, admin action | Log error, persist state, emit `session.closed` with reason |

### 3.3 Session Manager — Python Pseudocode

```python
import asyncio
import uuid
from datetime import datetime, timedelta
from enum import Enum
from typing import Optional

from agentforge.memory import StateStore
from agentforge.observability import Tracer, emit_event
from agentforge.guardrails import InputValidator, OutputFilter


class SessionStatus(Enum):
    CREATED = "created"
    ACTIVE = "active"
    PAUSED = "paused"
    HANDED_OFF = "handed_off"
    RESUMED = "resumed"
    CLOSED = "closed"


# Valid state transitions (state machine enforcement)
VALID_TRANSITIONS = {
    SessionStatus.CREATED:    {SessionStatus.ACTIVE, SessionStatus.CLOSED},
    SessionStatus.ACTIVE:     {SessionStatus.PAUSED, SessionStatus.HANDED_OFF, SessionStatus.CLOSED},
    SessionStatus.PAUSED:     {SessionStatus.RESUMED, SessionStatus.CLOSED},
    SessionStatus.HANDED_OFF: {SessionStatus.RESUMED, SessionStatus.CLOSED},
    SessionStatus.RESUMED:    {SessionStatus.ACTIVE, SessionStatus.CLOSED},
    SessionStatus.CLOSED:     set(),  # Terminal state
}


class SessionManager:
    """
    Manages the full lifecycle of conversation sessions.
    Enforces the state machine, persists session state, and coordinates
    with routing, handoff, and streaming subsystems.

    Pattern references:
    - Session scoping prevents cross-user bleed (p. 148)
    - State prefix system for persistence (p. 151)
    - Session recovery after failures (p. 209)
    """

    def __init__(
        self,
        state_store: StateStore,
        tracer: Tracer,
        router: "ConversationRouter",
        handoff_controller: "HandoffController",
        idle_timeout: int = 1800,           # 30 minutes
        pause_timeout: int = 86400,          # 24 hours
        max_session_duration: int = 86400,   # 24 hours
    ):
        self.state_store = state_store
        self.tracer = tracer
        self.router = router
        self.handoff_controller = handoff_controller
        self.idle_timeout = idle_timeout
        self.pause_timeout = pause_timeout
        self.max_session_duration = max_session_duration
        self._idle_timers: dict[str, asyncio.Task] = {}

    async def create_session(
        self,
        user_id: str,
        channel: dict,
        initial_message: dict,
        conversation_id: Optional[str] = None,
        thread_id: Optional[str] = None,
    ) -> dict:
        """Create a new session and route to the appropriate agent."""
        session_id = f"sess_{uuid.uuid4()}"
        conversation_id = conversation_id or f"conv_{uuid.uuid4()}"
        thread_id = thread_id or f"thr_{uuid.uuid4()}"

        with self.tracer.span("session.create", session_id=session_id):
            session = {
                "session_id": session_id,
                "conversation_id": conversation_id,
                "thread_id": thread_id,
                "status": SessionStatus.CREATED.value,
                "user": await self._load_user_context(user_id),
                "channel": channel,
                "routing": None,
                "handoff": {"active": False},
                "conversation_state": {
                    "message_count": 0,
                    "turn_count": 0,
                    "first_message_at": datetime.utcnow().isoformat(),
                    "goals": {"primary": None, "goals_met": False},
                },
                "metadata": {
                    "created_at": datetime.utcnow().isoformat(),
                    "version": 1,
                },
            }

            # Persist session state (p. 151 — state prefix system)
            await self.state_store.set(
                f"session:{session_id}:state", session
            )

            # Track active sessions per user (prevents cross-user bleed, p. 148)
            await self.state_store.list_append(
                f"user:{user_id}:active_sessions", session_id
            )

            # Route to the correct agent (p. 25 — routing)
            routing = await self.router.route(initial_message, session)
            session["routing"] = routing

            # Transition to active
            await self._transition(session, SessionStatus.ACTIVE)
            self._start_idle_timer(session_id)

            emit_event("session.created", {
                "session_id": session_id,
                "user_id": user_id,
                "channel": channel["type"],
                "assigned_agent": routing["assigned_agent"],
            })

            return session

    async def handle_message(self, session_id: str, message: dict) -> dict:
        """Process an incoming user message within an existing session."""
        session = await self._load_session(session_id)

        # If paused, resume first
        if session["status"] == SessionStatus.PAUSED.value:
            await self._transition(session, SessionStatus.RESUMED)
            await self._transition(session, SessionStatus.ACTIVE)

        # Reset idle timer on every message
        self._reset_idle_timer(session_id)

        # Update conversation state
        session["conversation_state"]["message_count"] += 1
        session["conversation_state"]["turn_count"] += 1
        session["conversation_state"]["last_message_at"] = (
            datetime.utcnow().isoformat()
        )

        # Persist updated state
        session["metadata"]["version"] += 1
        await self.state_store.set(
            f"session:{session_id}:state", session
        )

        # Append message to conversation history
        await self.state_store.list_append(
            f"conv:{session['conversation_id']}:history", message
        )

        return session

    async def pause_session(self, session_id: str, reason: str = "idle_timeout"):
        """Pause a session (e.g., user idle). State persisted for later resume."""
        session = await self._load_session(session_id)
        await self._transition(session, SessionStatus.PAUSED, reason=reason)
        self._cancel_idle_timer(session_id)

        # Start pause timeout — auto-close if user never returns
        self._idle_timers[session_id] = asyncio.create_task(
            self._pause_timeout_watchdog(session_id)
        )

    async def close_session(
        self, session_id: str, reason: str = "user_closed"
    ):
        """Close a session. Terminal state — no further transitions."""
        session = await self._load_session(session_id)
        await self._transition(session, SessionStatus.CLOSED, reason=reason)
        self._cancel_idle_timer(session_id)

        # Remove from user's active sessions
        user_id = session["user"]["user_id"]
        await self.state_store.list_remove(
            f"user:{user_id}:active_sessions", session_id
        )

        # Archive conversation history to long-term storage
        await self._archive_conversation(session)

        emit_event("session.closed", {
            "session_id": session_id,
            "reason": reason,
            "message_count": session["conversation_state"]["message_count"],
            "duration_seconds": self._compute_duration(session),
        })

    async def check_goals(self, session_id: str) -> bool:
        """
        Check if conversation goals have been met (p. 188 — goals_met() check).
        Auto-close the session if configured to do so.
        """
        session = await self._load_session(session_id)
        goals = session["conversation_state"]["goals"]

        if goals.get("goals_met"):
            if session.get("configuration", {}).get("auto_close_on_goal_met"):
                await self.close_session(session_id, reason="goal_met")
            return True
        return False

    async def _transition(
        self, session: dict, target: SessionStatus, reason: str = ""
    ):
        """Enforce state machine transitions."""
        current = SessionStatus(session["status"])
        if target not in VALID_TRANSITIONS[current]:
            raise InvalidTransitionError(
                f"Cannot transition from {current.value} to {target.value}"
            )

        session["status"] = target.value
        session.setdefault("status_history", []).append({
            "status": target.value,
            "at": datetime.utcnow().isoformat(),
            "by": "system",
            "reason": reason,
        })
        session["metadata"]["updated_at"] = datetime.utcnow().isoformat()
        session["metadata"]["version"] += 1

        await self.state_store.set(
            f"session:{session['session_id']}:state", session
        )

        emit_event(f"session.{target.value}", {
            "session_id": session["session_id"],
            "previous_status": current.value,
            "reason": reason,
        })

    async def _load_session(self, session_id: str) -> dict:
        """Load session state from store. Raise if not found."""
        session = await self.state_store.get(f"session:{session_id}:state")
        if session is None:
            raise SessionNotFoundError(f"Session {session_id} not found")
        return session

    async def _load_user_context(self, user_id: str) -> dict:
        """Load user context from long-term memory (p. 148)."""
        user = await self.state_store.get(f"user:{user_id}:profile")
        return user or {"user_id": user_id, "display_name": "Unknown"}

    def _start_idle_timer(self, session_id: str):
        """Start idle timeout watchdog."""
        self._idle_timers[session_id] = asyncio.create_task(
            self._idle_timeout_watchdog(session_id)
        )

    def _reset_idle_timer(self, session_id: str):
        """Reset idle timer on user activity."""
        self._cancel_idle_timer(session_id)
        self._start_idle_timer(session_id)

    def _cancel_idle_timer(self, session_id: str):
        """Cancel an active idle timer."""
        timer = self._idle_timers.pop(session_id, None)
        if timer and not timer.done():
            timer.cancel()

    async def _idle_timeout_watchdog(self, session_id: str):
        """Pause session after idle timeout."""
        await asyncio.sleep(self.idle_timeout)
        try:
            await self.pause_session(session_id, reason="idle_timeout")
        except (SessionNotFoundError, InvalidTransitionError):
            pass  # Session already closed or transitioned

    async def _pause_timeout_watchdog(self, session_id: str):
        """Close session if paused for too long."""
        await asyncio.sleep(self.pause_timeout)
        try:
            await self.close_session(session_id, reason="pause_timeout")
        except (SessionNotFoundError, InvalidTransitionError):
            pass

    async def _archive_conversation(self, session: dict):
        """Archive conversation to long-term storage for analytics."""
        conv_id = session["conversation_id"]
        history = await self.state_store.get(f"conv:{conv_id}:history")
        await self.state_store.set(
            f"user:{session['user']['user_id']}:conversation_history:{conv_id}",
            {
                "conversation_id": conv_id,
                "summary": session["conversation_state"].get("context_summary"),
                "message_count": session["conversation_state"]["message_count"],
                "closed_at": datetime.utcnow().isoformat(),
                "tags": session["metadata"].get("tags", []),
            }
        )

    def _compute_duration(self, session: dict) -> float:
        """Compute session duration in seconds."""
        created = datetime.fromisoformat(session["metadata"]["created_at"])
        return (datetime.utcnow() - created).total_seconds()
```

---

## 4. Multi-Channel Architecture

The platform supports five communication channels, each with different capabilities. The Channel Adapter layer normalizes all inbound messages into a **Unified Message Format** and translates all outbound messages into channel-specific delivery formats.

### 4.1 Multi-Channel Flow

```
                          INBOUND FLOW
   ┌──────────────────────────────────────────────────────────────┐
   │                                                              │
   │  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────────────┐  │
   │  │ REST │  │  WS  │  │Slack │  │Telegr│  │ Web Widget   │  │
   │  │ POST │  │ msg  │  │event │  │update│  │ postMessage  │  │
   │  └──┬───┘  └──┬───┘  └──┬───┘  └──┬───┘  └──────┬───────┘  │
   │     │         │         │         │              │           │
   │     ▼         ▼         ▼         ▼              ▼           │
   │  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────────────┐  │
   │  │Adapt.│  │Adapt.│  │Adapt.│  │Adapt.│  │  Adapter     │  │
   │  │ REST │  │  WS  │  │Slack │  │Telegr│  │  Widget      │  │
   │  └──┬───┘  └──┬───┘  └──┬───┘  └──┬───┘  └──────┬───────┘  │
   │     │         │         │         │              │           │
   │     └─────────┴─────┬───┴─────────┴──────────────┘           │
   │                     │                                        │
   │                     ▼                                        │
   │           ┌─────────────────┐                                │
   │           │  Input Guardrail│  (p. 286 — validation,         │
   │           │  Pipeline       │   sanitization, PII detection) │
   │           └────────┬────────┘                                │
   │                    ▼                                        │
   │           ┌─────────────────┐                                │
   │           │ Unified Message │  Channel-agnostic format       │
   │           │ (normalized)    │                                 │
   │           └────────┬────────┘                                │
   │                    ▼                                        │
   │           ┌─────────────────┐                                │
   │           │ Session Manager │  Route to session / create     │
   │           └────────┬────────┘                                │
   │                    ▼                                        │
   │           ┌─────────────────┐                                │
   │           │ Conversation    │  Dispatch to agent / team      │
   │           │ Router          │  (p. 25 — LLM routing)         │
   │           └────────┬────────┘                                │
   │                    ▼                                        │
   │           ┌─────────────────┐                                │
   │           │ Agent / Team    │  Process and generate response  │
   │           │ Execution       │  (p. 127 — supervisor pattern) │
   │           └────────┬────────┘                                │
   │                    ▼                                        │
   │           ┌─────────────────┐                                │
   │           │ Output Guardrail│  (p. 286 — output filtering,   │
   │           │ Pipeline        │   PII redaction, safety check)  │
   │           └────────┬────────┘                                │
   │                    ▼                                        │
   │           ┌─────────────────┐                                │
   │           │ Stream Emitter  │  Token-by-token or full        │
   │           │                 │  response delivery              │
   │           └────────┬────────┘                                │
   │                    │                                        │
   │     ┌──────────────┼──────────────────────────────┐         │
   │     ▼         ▼         ▼         ▼              ▼          │
   │  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────────────┐  │
   │  │ REST │  │  WS  │  │Slack │  │Telegr│  │ Web Widget   │  │
   │  │ resp │  │ push │  │ API  │  │  API │  │ postMessage  │  │
   │  └──────┘  └──────┘  └──────┘  └──────┘  └──────────────┘  │
   │                                                              │
   │                         OUTBOUND FLOW                        │
   └──────────────────────────────────────────────────────────────┘
```

### 4.2 Unified Message Format

All channel adapters normalize messages into this format before processing:

```json
{
  "message_id": "msg_a1b2c3d4",
  "session_id": "sess_...",
  "conversation_id": "conv_...",
  "thread_id": "thr_...",
  "timestamp": "2026-02-27T10:05:00Z",

  "direction": "inbound",
  "sender": {
    "type": "user",
    "id": "usr_jane-doe-12345",
    "display_name": "Jane Doe"
  },

  "content": {
    "type": "text",
    "text": "Why was I charged $49.99 on my February invoice?",
    "attachments": [],
    "metadata": {}
  },

  "channel_origin": {
    "type": "slack",
    "channel_message_id": "1677123456.789012",
    "channel_thread_ts": "1677123400.000000",
    "channel_specific": {
      "workspace_id": "T01234567",
      "channel_id": "C09876543"
    }
  },

  "guardrail_results": {
    "input_validated": true,
    "pii_detected": false,
    "safety_score": 0.98,
    "injection_detected": false
  }
}
```

### 4.3 Channel Capability Matrix

| Capability | REST API | WebSocket | Slack | Telegram | Web Widget |
|-----------|----------|-----------|-------|----------|------------|
| Streaming (token-by-token) | SSE | Native | No | No | Native |
| Typing indicator | No | Yes | Yes | Yes | Yes |
| Read receipts | No | Yes | No | Yes | Yes |
| File upload | Yes | Yes | Yes | Yes | Yes |
| Rich formatting | Markdown | Markdown | Block Kit | Markdown+HTML | Markdown |
| Inline buttons | No | Yes | Yes | Yes | Yes |
| Bidirectional real-time | No (poll/SSE) | Yes | Via Events API | Via webhook | Yes |
| Thread support | Yes | Yes | Yes | Yes (reply) | Yes |
| Max message length | 32KB | 32KB | 3000 chars | 4096 chars | 32KB |

### 4.4 Channel Adapter Interface

```python
from abc import ABC, abstractmethod
from typing import AsyncIterator


class ChannelAdapter(ABC):
    """
    Abstract base for all channel adapters.
    Each adapter normalizes inbound messages and formats outbound responses
    for its specific channel. Adapters never contain business logic — they
    are pure translators.
    """

    @abstractmethod
    async def receive(self, raw_event: dict) -> dict:
        """
        Normalize a channel-specific inbound event into the
        Unified Message Format.
        """
        ...

    @abstractmethod
    async def send(self, session: dict, message: dict) -> dict:
        """
        Translate a Unified Message Format response into a
        channel-specific delivery and send it.
        Returns delivery receipt.
        """
        ...

    @abstractmethod
    async def send_stream(
        self, session: dict, token_stream: AsyncIterator[str]
    ) -> dict:
        """
        Stream a response token-by-token to the channel.
        Falls back to send() for channels that do not support streaming.
        """
        ...

    @abstractmethod
    async def send_typing_indicator(self, session: dict, active: bool):
        """Show or hide typing indicator on the channel."""
        ...

    @abstractmethod
    async def send_read_receipt(self, session: dict, message_id: str):
        """Send a read receipt for a specific message."""
        ...

    @abstractmethod
    def supports(self, capability: str) -> bool:
        """Check if this channel supports a given capability."""
        ...


class SlackAdapter(ChannelAdapter):
    """
    Slack-specific adapter. Receives events via the Slack Events API
    (webhook mode, p. 246) and sends responses via Slack Web API.
    """

    SUPPORTED_CAPABILITIES = {
        "typing_indicator", "file_upload", "rich_formatting",
        "inline_buttons", "thread_support"
    }

    async def receive(self, raw_event: dict) -> dict:
        """Normalize Slack event into Unified Message Format."""
        event = raw_event.get("event", {})
        return {
            "message_id": f"msg_{event.get('client_msg_id', uuid.uuid4())}",
            "direction": "inbound",
            "sender": {
                "type": "user",
                "id": await self._resolve_user_id(event["user"]),
                "display_name": await self._get_display_name(event["user"]),
            },
            "content": {
                "type": "text",
                "text": event.get("text", ""),
                "attachments": self._extract_attachments(event),
            },
            "channel_origin": {
                "type": "slack",
                "channel_message_id": event.get("ts"),
                "channel_thread_ts": event.get("thread_ts"),
                "channel_specific": {
                    "workspace_id": raw_event.get("team_id"),
                    "channel_id": event.get("channel"),
                },
            },
        }

    async def send(self, session: dict, message: dict) -> dict:
        """Send response via Slack Web API."""
        channel_info = session["channel"]["channel_specific"]
        result = await self.slack_client.chat_postMessage(
            channel=channel_info["channel_id"],
            text=message["content"]["text"],
            thread_ts=session.get("channel_origin", {}).get("channel_thread_ts"),
            blocks=self._format_blocks(message),
        )
        return {"delivered": True, "slack_ts": result["ts"]}

    async def send_stream(self, session: dict, token_stream: AsyncIterator[str]):
        """
        Slack does not support token-by-token streaming.
        Collect full response, then send as single message.
        """
        full_response = ""
        async for token in token_stream:
            full_response += token
        return await self.send(session, {
            "content": {"type": "text", "text": full_response}
        })

    async def send_typing_indicator(self, session: dict, active: bool):
        """Slack typing indicator is ephemeral — resend every 3 seconds."""
        if active:
            # Slack's typing indicator auto-expires; we re-send periodically
            # during agent processing via a background task
            pass

    async def send_read_receipt(self, session: dict, message_id: str):
        """Slack does not support read receipts — no-op."""
        pass

    def supports(self, capability: str) -> bool:
        return capability in self.SUPPORTED_CAPABILITIES
```

---

## 5. Conversation Routing

Conversation routing determines which agent or team handles each incoming conversation. It uses the platform's routing infrastructure (p. 25) with conversation-specific enhancements.

### 5.1 Routing Flow

```
Incoming Message
       │
       ▼
┌──────────────────┐
│ 1. Session Lookup│  Does an active session exist for this
│                  │  user + channel + thread?
└────────┬─────────┘
         │
    ┌────┴─────┐
    │ existing │──────────── Route to assigned agent
    │ session? │             (skip classification)
    └────┬─────┘
         │ no
         ▼
┌──────────────────┐
│ 2. Intent        │  LLM classifies user intent using
│ Classification   │  a fast/cheap model (p. 258)
│ (p. 25)          │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 3. Team/Agent    │  Map intent to the best team or agent
│ Selection        │  based on capability matching
└────────┬─────────┘
         │
    ┌────┴────────────┐
    │ confidence      │
    │ >= threshold?   │
    └────┬───────┬────┘
         │ yes   │ no
         ▼       ▼
   ┌──────┐  ┌──────────────┐
   │Assign│  │Default       │  Fallback to general-purpose
   │agent │  │Fallback      │  agent (p. 27)
   └──────┘  │Agent (p. 27) │
             └──────────────┘
```

### 5.2 Conversation Router — Python Pseudocode

```python
from agentforge.models import get_model
from agentforge.observability import Tracer


class ConversationRouter:
    """
    Routes incoming conversations to the correct agent or team.
    Uses LLM-based intent classification with a cheap/fast model (p. 258)
    and falls back to a default agent when confidence is low (p. 27).

    Pattern references:
    - Route incoming conversations to the correct team/agent (p. 25)
    - Default fallback (p. 27)
    - Treat sub-agent outputs as untrusted (p. 126)
    """

    def __init__(
        self,
        agent_registry: "AgentRegistry",
        team_registry: "TeamRegistry",
        tracer: Tracer,
        routing_model: str = "haiku",
        confidence_threshold: float = 0.75,
        fallback_agent: str = "agent:general-assistant",
    ):
        self.agent_registry = agent_registry
        self.team_registry = team_registry
        self.tracer = tracer
        self.model = get_model(routing_model)
        self.confidence_threshold = confidence_threshold
        self.fallback_agent = fallback_agent

    async def route(self, message: dict, session: dict) -> dict:
        """
        Determine which agent/team should handle this conversation.
        Returns routing assignment with confidence score.
        """
        with self.tracer.span("conversation.route") as span:
            # Step 1: Check for existing routing (session continuity)
            existing_routing = session.get("routing")
            if existing_routing and session["status"] != "created":
                span.set_attribute("routing.method", "session_continuity")
                return existing_routing

            # Step 2: Classify intent using LLM (cheap model, p. 258)
            classification = await self._classify_intent(message)
            span.set_attribute("routing.intent", classification["intent"])
            span.set_attribute("routing.confidence", classification["confidence"])

            # Step 3: Match intent to agent/team
            if classification["confidence"] >= self.confidence_threshold:
                assignment = await self._match_agent(classification)
            else:
                # Fallback when confidence is low (p. 27)
                span.set_attribute("routing.fallback", True)
                assignment = {
                    "assigned_team": None,
                    "assigned_agent": self.fallback_agent,
                    "routing_reason": f"low_confidence_fallback "
                                      f"(confidence={classification['confidence']:.2f})",
                    "routing_confidence": classification["confidence"],
                    "fallback_agent": self.fallback_agent,
                }

            assignment["routed_at"] = datetime.utcnow().isoformat()
            return assignment

    async def _classify_intent(self, message: dict) -> dict:
        """
        Use a fast LLM to classify user intent.
        Returns intent label and confidence score.
        """
        available_teams = await self.team_registry.list_teams_with_capabilities()

        prompt = f"""Classify the user's intent and select the best team to handle it.

Available teams and their capabilities:
{self._format_teams(available_teams)}

User message: {message['content']['text']}

Respond with JSON:
{{"intent": "<intent_label>", "team": "<team_id>", "confidence": <0.0-1.0>, "reasoning": "<brief>"}}"""

        response = await self.model.generate(prompt, response_format="json")

        # Treat LLM output as untrusted (p. 126) — validate structure
        classification = self._validate_classification(response)
        return classification

    async def _match_agent(self, classification: dict) -> dict:
        """Map classified intent to the best available agent."""
        team_id = classification["team"]
        team = await self.team_registry.get_team(team_id)

        if team is None:
            return self._fallback_assignment(
                reason=f"team_not_found: {team_id}"
            )

        # Select the team's entry-point agent (supervisor, p. 127)
        supervisor = team.get("supervisor_agent")
        if supervisor is None:
            return self._fallback_assignment(
                reason=f"team_has_no_supervisor: {team_id}"
            )

        return {
            "assigned_team": team_id,
            "assigned_agent": supervisor,
            "routing_reason": f"intent_classification: {classification['intent']}",
            "routing_confidence": classification["confidence"],
            "fallback_agent": self.fallback_agent,
        }

    async def reroute(self, session: dict, reason: str) -> dict:
        """
        Re-route a conversation mid-session (e.g., topic changed, or
        current agent requested escalation to a different team).
        """
        with self.tracer.span("conversation.reroute") as span:
            span.set_attribute("reroute.reason", reason)

            # Get the latest message for re-classification
            history = await self.state_store.get(
                f"conv:{session['conversation_id']}:history"
            )
            latest_message = history[-1] if history else None
            if latest_message is None:
                raise RoutingError("Cannot reroute: no messages in session")

            new_routing = await self.route(latest_message, {
                **session, "routing": None, "status": "created"
            })
            return new_routing

    def _fallback_assignment(self, reason: str) -> dict:
        """Return default fallback agent assignment (p. 27)."""
        return {
            "assigned_team": None,
            "assigned_agent": self.fallback_agent,
            "routing_reason": f"fallback: {reason}",
            "routing_confidence": 0.0,
            "fallback_agent": self.fallback_agent,
        }

    def _validate_classification(self, response: dict) -> dict:
        """
        Validate LLM classification output (p. 126 — untrusted sub-agent output).
        Ensures required fields exist and confidence is in valid range.
        """
        required_fields = {"intent", "team", "confidence"}
        if not required_fields.issubset(response.keys()):
            raise RoutingError(
                f"Invalid classification: missing fields "
                f"{required_fields - response.keys()}"
            )
        response["confidence"] = max(0.0, min(1.0, float(response["confidence"])))
        return response
```

---

## 6. Real-Time Streaming

For channels that support it, agent responses are streamed token-by-token to the user, providing a responsive conversational experience. The streaming architecture uses SSE for REST clients (p. 246) and native WebSocket frames for WebSocket clients.

### 6.1 Streaming Architecture

```
Agent LLM
    │
    │  token-by-token generation
    ▼
┌──────────────────────┐
│  Token Stream Buffer │  Buffering + output guardrail
│                      │  (p. 286 — incremental safety check)
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Stream Emitter      │  Fan-out to connected clients
│                      │
│  ┌────────────────┐  │
│  │ SSE Writer     │──┼──> REST/SSE clients
│  │ (event stream) │  │
│  ├────────────────┤  │
│  │ WS Writer      │──┼──> WebSocket clients
│  │ (ws.send)      │  │
│  ├────────────────┤  │
│  │ Webhook Writer │──┼──> Slack/Telegram (buffered, full response)
│  │ (HTTP POST)    │  │
│  └────────────────┘  │
└──────────────────────┘
```

### 6.2 SSE Event Protocol

REST clients receive streamed responses via Server-Sent Events (SSE). The protocol defines the following event types:

```
# Connection established
event: session.connected
data: {"session_id": "sess_...", "agent": "agent:support-triage"}

# Agent starts processing (typing indicator equivalent)
event: response.start
data: {"message_id": "msg_resp_001", "agent": "agent:support-triage"}

# Individual tokens
event: response.token
data: {"message_id": "msg_resp_001", "token": "I"}

event: response.token
data: {"message_id": "msg_resp_001", "token": " can"}

event: response.token
data: {"message_id": "msg_resp_001", "token": " help"}

event: response.token
data: {"message_id": "msg_resp_001", "token": " with"}

event: response.token
data: {"message_id": "msg_resp_001", "token": " that"}

# Response complete
event: response.end
data: {"message_id": "msg_resp_001", "full_text": "I can help with that", "usage": {"input_tokens": 150, "output_tokens": 5}}

# Typing indicator for multi-step processing
event: agent.thinking
data: {"message_id": "msg_resp_001", "status": "Searching knowledge base..."}

# Session events
event: session.paused
data: {"reason": "idle_timeout"}

event: session.handoff
data: {"operator": "human:ops-jane", "reason": "escalation_requested"}

# Error
event: error
data: {"code": "agent_unavailable", "message": "Agent temporarily unavailable. Retrying...", "retry_after_ms": 2000}

# Keepalive (every 15 seconds to prevent proxy timeout)
: keepalive
```

### 6.3 WebSocket Handler — Python Pseudocode

```python
import asyncio
import json
from datetime import datetime
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect
from agentforge.guardrails import InputValidator, OutputFilter
from agentforge.observability import Tracer


class ConversationWebSocketHandler:
    """
    Handles bidirectional WebSocket connections for real-time conversations.
    Supports token-by-token streaming, typing indicators, read receipts,
    and session lifecycle events.

    Pattern references:
    - SSE streaming for real-time responses (p. 246)
    - Input validation on all user messages (p. 286)
    - Output filtering before delivery (p. 286)
    - Session recovery after failures (p. 209)
    """

    def __init__(
        self,
        session_manager: SessionManager,
        router: "ConversationRouter",
        input_validator: InputValidator,
        output_filter: OutputFilter,
        tracer: Tracer,
    ):
        self.session_manager = session_manager
        self.router = router
        self.input_validator = input_validator
        self.output_filter = output_filter
        self.tracer = tracer
        self._connections: dict[str, WebSocket] = {}

    async def handle_connection(self, websocket: WebSocket, user_id: str):
        """
        Main WebSocket connection handler. Manages the full lifecycle
        of a WebSocket-based conversation.
        """
        await websocket.accept()
        session_id: Optional[str] = None

        try:
            # Authenticate and initialize
            auth = await self._authenticate(websocket, user_id)
            if not auth["valid"]:
                await websocket.send_json({
                    "event": "error",
                    "data": {"code": "auth_failed", "message": "Invalid credentials"}
                })
                await websocket.close(code=4001)
                return

            # Send connection acknowledgement
            await websocket.send_json({
                "event": "connection.ready",
                "data": {
                    "user_id": user_id,
                    "server_time": datetime.utcnow().isoformat(),
                    "capabilities": [
                        "streaming", "typing_indicator",
                        "read_receipt", "file_upload"
                    ],
                }
            })

            # Main message loop
            while True:
                raw = await websocket.receive_json()
                event_type = raw.get("event")

                if event_type == "message.send":
                    session_id = await self._handle_user_message(
                        websocket, user_id, raw, session_id
                    )

                elif event_type == "typing.start":
                    await self._handle_typing_indicator(session_id, active=True)

                elif event_type == "typing.stop":
                    await self._handle_typing_indicator(session_id, active=False)

                elif event_type == "message.read":
                    await self._handle_read_receipt(session_id, raw)

                elif event_type == "session.resume":
                    session_id = await self._handle_session_resume(
                        websocket, user_id, raw
                    )

                elif event_type == "session.close":
                    await self._handle_session_close(session_id, raw)
                    session_id = None

                elif event_type == "ping":
                    await websocket.send_json({"event": "pong"})

                else:
                    await websocket.send_json({
                        "event": "error",
                        "data": {"code": "unknown_event", "message": f"Unknown: {event_type}"}
                    })

        except WebSocketDisconnect:
            # Client disconnected — pause session for possible reconnection (p. 209)
            if session_id:
                await self.session_manager.pause_session(
                    session_id, reason="client_disconnected"
                )
                self._connections.pop(session_id, None)

        except Exception as e:
            # Unexpected error — log and close gracefully
            self.tracer.record_exception(e)
            if session_id:
                await self.session_manager.pause_session(
                    session_id, reason=f"error: {str(e)}"
                )
            try:
                await websocket.send_json({
                    "event": "error",
                    "data": {"code": "internal_error", "message": "Connection error"}
                })
                await websocket.close(code=1011)
            except Exception:
                pass

    async def _handle_user_message(
        self, websocket: WebSocket, user_id: str,
        raw: dict, session_id: Optional[str]
    ) -> str:
        """Process a user message and stream the agent response."""

        message_text = raw.get("data", {}).get("text", "")

        # Input validation (p. 286 — all user messages validated)
        validation = await self.input_validator.validate(message_text)
        if not validation["valid"]:
            await websocket.send_json({
                "event": "error",
                "data": {
                    "code": "input_rejected",
                    "message": validation["reason"],
                }
            })
            return session_id

        # Normalize to Unified Message Format
        message = {
            "message_id": f"msg_{uuid.uuid4()}",
            "direction": "inbound",
            "sender": {"type": "user", "id": user_id},
            "content": {"type": "text", "text": message_text},
            "channel_origin": {"type": "websocket"},
            "timestamp": datetime.utcnow().isoformat(),
        }

        # Create or continue session
        if session_id is None:
            session = await self.session_manager.create_session(
                user_id=user_id,
                channel={"type": "websocket", "capabilities": ["streaming"]},
                initial_message=message,
            )
            session_id = session["session_id"]
            self._connections[session_id] = websocket

            await websocket.send_json({
                "event": "session.created",
                "data": {"session_id": session_id}
            })
        else:
            session = await self.session_manager.handle_message(
                session_id, message
            )

        # Send typing indicator while agent processes
        await websocket.send_json({
            "event": "response.start",
            "data": {
                "message_id": f"msg_resp_{uuid.uuid4()}",
                "agent": session["routing"]["assigned_agent"],
            }
        })

        # Get agent response as a token stream
        agent = await self._get_agent(session["routing"]["assigned_agent"])
        response_message_id = f"msg_resp_{uuid.uuid4()}"
        full_text = ""

        async for token in agent.stream_response(message, session):
            # Incremental output filtering (p. 286)
            filtered_token = await self.output_filter.filter_token(token)
            if filtered_token:
                full_text += filtered_token
                await websocket.send_json({
                    "event": "response.token",
                    "data": {
                        "message_id": response_message_id,
                        "token": filtered_token,
                    }
                })

        # Final output validation on complete response (p. 286)
        final_text = await self.output_filter.filter_complete(full_text)

        await websocket.send_json({
            "event": "response.end",
            "data": {
                "message_id": response_message_id,
                "full_text": final_text,
            }
        })

        # Check if conversation goals are met (p. 188)
        await self.session_manager.check_goals(session_id)

        return session_id

    async def _handle_session_resume(
        self, websocket: WebSocket, user_id: str, raw: dict
    ) -> str:
        """
        Resume a previously paused session (p. 209 — session recovery).
        Replays recent history so the client has context.
        """
        resume_session_id = raw.get("data", {}).get("session_id")
        session = await self.session_manager._load_session(resume_session_id)

        # Verify user owns this session (p. 148 — cross-user bleed prevention)
        if session["user"]["user_id"] != user_id:
            await websocket.send_json({
                "event": "error",
                "data": {"code": "forbidden", "message": "Session belongs to another user"}
            })
            return None

        # Resume the session
        await self.session_manager.handle_message(resume_session_id, {
            "content": {"type": "system", "text": "[session_resumed]"},
            "direction": "system",
        })

        self._connections[resume_session_id] = websocket

        # Replay recent history for client context
        history = await self.session_manager.state_store.get(
            f"conv:{session['conversation_id']}:history"
        )
        recent_messages = (history or [])[-20:]  # Last 20 messages

        await websocket.send_json({
            "event": "session.resumed",
            "data": {
                "session_id": resume_session_id,
                "history_replay": recent_messages,
                "session_state": {
                    "message_count": session["conversation_state"]["message_count"],
                    "goals": session["conversation_state"]["goals"],
                },
            }
        })

        return resume_session_id

    async def _handle_session_close(self, session_id: str, raw: dict):
        """Close session at user's request."""
        if session_id:
            reason = raw.get("data", {}).get("reason", "user_closed")
            await self.session_manager.close_session(session_id, reason=reason)
            self._connections.pop(session_id, None)

    async def _handle_typing_indicator(self, session_id: str, active: bool):
        """Broadcast typing indicator to other participants (for handoff scenarios)."""
        if session_id:
            await self.session_manager.state_store.set(
                f"session:{session_id}:user_typing", active, ttl=5
            )

    async def _handle_read_receipt(self, session_id: str, raw: dict):
        """Record that the user has read up to a specific message."""
        message_id = raw.get("data", {}).get("message_id")
        if session_id and message_id:
            await self.session_manager.state_store.set(
                f"session:{session_id}:last_read", message_id
            )

    async def stream_to_client(
        self, session_id: str, event: str, data: dict
    ):
        """Push a server event to a connected WebSocket client."""
        ws = self._connections.get(session_id)
        if ws:
            try:
                await ws.send_json({"event": event, "data": data})
            except Exception:
                # Client disconnected — will be caught by main loop
                self._connections.pop(session_id, None)
```

---

## 7. Agent-to-Human Handoff Protocol

The handoff protocol implements the HITL escalation pattern (p. 210) for situations where an agent cannot or should not continue handling a conversation. This includes complex requests beyond agent capability, user frustration detection, policy-mandated human review, and agent uncertainty.

### 7.1 Handoff Lifecycle

```
                    AGENT-TO-HUMAN HANDOFF FLOW

Agent detects                                        Human operator
escalation need                                      accepts handoff
     │                                                     │
     ▼                                                     ▼
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────────┐
│ 1. Agent │───>│ 2. Context│───>│ 3. Queue │───>│ 4. Human         │
│ requests │    │ snapshot  │    │ for human│    │ operator active  │
│ handoff  │    │ created   │    │ operator │    │                  │
└──────────┘    └──────────┘    └──────────┘    └────────┬─────────┘
                                                         │
                                              ┌──────────┴──────────┐
                                              │                     │
                                              ▼                     ▼
                                    ┌──────────────┐     ┌──────────────┐
                                    │ 5a. Human    │     │ 5b. Human    │
                                    │ resolves &   │     │ hands back   │
                                    │ closes       │     │ to agent     │
                                    └──────────────┘     └──────┬───────┘
                                                                │
                                                                ▼
                                                       ┌──────────────┐
                                                       │ 6. Agent     │
                                                       │ resumes with │
                                                       │ full context │
                                                       └──────────────┘
```

### 7.2 Handoff Context Snapshot

When a handoff is initiated, the system creates a comprehensive context snapshot so the human operator has everything needed to continue the conversation without asking the user to repeat themselves (p. 213 — full context in escalation):

```json
{
  "handoff_id": "ho_a1b2c3d4",
  "session_id": "sess_...",
  "conversation_id": "conv_...",
  "initiated_at": "2026-02-27T10:20:00Z",
  "status": "queued",

  "escalation": {
    "reason": "agent_uncertainty",
    "reason_detail": "Agent confidence below threshold (0.35) for refund policy question involving edge case not covered in knowledge base.",
    "initiated_by": "agent:support-triage",
    "urgency": "medium",
    "required_skills": ["billing", "refund-policy"],
    "interaction_mode": "full_handoff"
  },

  "context_snapshot": {
    "user": {
      "user_id": "usr_jane-doe-12345",
      "display_name": "Jane Doe",
      "plan": "enterprise",
      "account_age_days": 342,
      "sentiment_trend": "declining",
      "previous_handoffs": 1
    },

    "conversation_summary": "User Jane Doe is inquiring about a $49.99 charge on her February invoice. The agent identified it as a pro-rata upgrade fee from Basic to Pro plan on Feb 15. The user disputes this, claiming she did not authorize the upgrade. Agent is uncertain about the refund policy for disputed auto-upgrades.",

    "conversation_history": [
      {
        "role": "user",
        "text": "Why was I charged $49.99 on my February invoice?",
        "at": "2026-02-27T10:00:01Z"
      },
      {
        "role": "agent",
        "text": "I can see a charge of $49.99 on your February invoice. This is a pro-rata fee for upgrading from Basic to Pro plan on February 15th.",
        "at": "2026-02-27T10:00:08Z"
      },
      {
        "role": "user",
        "text": "I never authorized that upgrade. I want a refund.",
        "at": "2026-02-27T10:01:15Z"
      },
      {
        "role": "agent",
        "text": "I understand your concern. Let me look into the refund policy for this situation.",
        "at": "2026-02-27T10:01:22Z"
      }
    ],

    "agent_internal_state": {
      "tools_used": ["billing_lookup", "knowledge_search"],
      "knowledge_gaps": ["refund policy for disputed auto-upgrades"],
      "confidence_score": 0.35,
      "suggested_resolution": "Consider processing a full refund and reverting the plan upgrade if no explicit user consent was recorded."
    },

    "relevant_data": {
      "invoice_id": "inv_20260201_jdoe",
      "charge_amount": 49.99,
      "upgrade_date": "2026-02-15",
      "plan_from": "basic",
      "plan_to": "pro"
    }
  },

  "operator_assignment": {
    "assigned_to": null,
    "queue": "billing-escalations",
    "estimated_wait_seconds": 120,
    "sla_deadline": "2026-02-27T10:35:00Z"
  },

  "timeout": {
    "timeout_seconds": 900,
    "safe_default_action": "apologize_and_create_ticket",
    "safe_default_message": "I apologize for the wait. I have created a support ticket for your refund request. A team member will follow up within 24 hours. Your ticket number is #SUP-12345."
  }
}
```

### 7.3 Four Interaction Modes (p. 210)

The handoff controller supports the four HITL interaction modes from the pattern reference:

| Mode | Description | Use Case |
|------|-------------|----------|
| **`full_handoff`** | Agent completely exits; human takes over the conversation | Complex disputes, sensitive situations, user explicitly requests human |
| **`agent_assist`** | Human operates with agent providing real-time suggestions | New operator training, complex cases needing agent knowledge |
| **`approval_gate`** | Agent proposes action; human approves or rejects before execution | Refund processing, account changes, high-value decisions |
| **`silent_monitor`** | Human observes agent conversation; can intervene at any time | Quality assurance, agent training, compliance monitoring |

### 7.4 Handoff Controller — Python Pseudocode

```python
import asyncio
from datetime import datetime, timedelta
from typing import Optional

from agentforge.memory import StateStore
from agentforge.observability import Tracer, emit_event


class HandoffController:
    """
    Manages agent-to-human handoffs and human-to-agent handbacks.
    Implements the four HITL interaction modes (p. 210) with full
    context transfer (p. 213) and timeout with safe default (p. 214).

    Pattern references:
    - Agent-to-human handoff as ultimate escalation (p. 210)
    - Full context in escalation (p. 213)
    - Timeout with safe default (p. 214)
    """

    def __init__(
        self,
        state_store: StateStore,
        session_manager: SessionManager,
        operator_queue: "OperatorQueue",
        tracer: Tracer,
        default_timeout: int = 900,  # 15 minutes
    ):
        self.state_store = state_store
        self.session_manager = session_manager
        self.operator_queue = operator_queue
        self.tracer = tracer
        self.default_timeout = default_timeout
        self._timeout_tasks: dict[str, asyncio.Task] = {}

    async def initiate_handoff(
        self,
        session_id: str,
        reason: str,
        reason_detail: str,
        interaction_mode: str = "full_handoff",
        urgency: str = "medium",
        required_skills: list[str] = None,
        safe_default_action: str = "apologize_and_create_ticket",
        safe_default_message: str = None,
        timeout_seconds: int = None,
    ) -> dict:
        """
        Initiate an agent-to-human handoff.
        Creates a full context snapshot (p. 213), queues for human operator,
        and starts timeout watchdog (p. 214).
        """
        with self.tracer.span("handoff.initiate", session_id=session_id) as span:
            session = await self.session_manager._load_session(session_id)
            handoff_id = f"ho_{uuid.uuid4()}"

            # Build context snapshot (p. 213 — full context in escalation)
            context_snapshot = await self._build_context_snapshot(
                session, reason, reason_detail
            )

            handoff = {
                "handoff_id": handoff_id,
                "session_id": session_id,
                "conversation_id": session["conversation_id"],
                "initiated_at": datetime.utcnow().isoformat(),
                "status": "queued",
                "escalation": {
                    "reason": reason,
                    "reason_detail": reason_detail,
                    "initiated_by": session["routing"]["assigned_agent"],
                    "urgency": urgency,
                    "required_skills": required_skills or [],
                    "interaction_mode": interaction_mode,
                },
                "context_snapshot": context_snapshot,
                "operator_assignment": {
                    "assigned_to": None,
                    "queue": self._select_queue(required_skills),
                },
                "timeout": {
                    "timeout_seconds": timeout_seconds or self.default_timeout,
                    "safe_default_action": safe_default_action,
                    "safe_default_message": safe_default_message,
                },
            }

            # Persist handoff state
            await self.state_store.set(
                f"handoff:{handoff_id}:state", handoff
            )

            # Transition session to handed_off state
            await self.session_manager._transition(
                session, SessionStatus.HANDED_OFF,
                reason=f"handoff:{handoff_id}"
            )

            # Queue for human operator
            await self.operator_queue.enqueue(handoff)

            # Notify user that a human is being connected
            await self._notify_user_handoff_started(session, handoff)

            # Start timeout watchdog (p. 214 — timeout with safe default)
            timeout = timeout_seconds or self.default_timeout
            self._timeout_tasks[handoff_id] = asyncio.create_task(
                self._timeout_watchdog(handoff_id, timeout)
            )

            span.set_attribute("handoff.id", handoff_id)
            span.set_attribute("handoff.mode", interaction_mode)

            emit_event("handoff.initiated", {
                "handoff_id": handoff_id,
                "session_id": session_id,
                "reason": reason,
                "mode": interaction_mode,
                "urgency": urgency,
            })

            return handoff

    async def assign_operator(
        self, handoff_id: str, operator_id: str
    ) -> dict:
        """Assign a human operator to a queued handoff."""
        handoff = await self.state_store.get(f"handoff:{handoff_id}:state")
        if handoff is None:
            raise HandoffNotFoundError(f"Handoff {handoff_id} not found")

        handoff["status"] = "assigned"
        handoff["operator_assignment"]["assigned_to"] = operator_id
        handoff["operator_assignment"]["assigned_at"] = (
            datetime.utcnow().isoformat()
        )

        await self.state_store.set(f"handoff:{handoff_id}:state", handoff)

        emit_event("handoff.operator_assigned", {
            "handoff_id": handoff_id,
            "operator_id": operator_id,
        })

        return handoff

    async def complete_handoff(
        self,
        handoff_id: str,
        resolution: str,
        handback_to_agent: bool = False,
        handback_context: dict = None,
    ) -> dict:
        """
        Complete a handoff. Either the human resolves the issue and closes,
        or hands back to the agent with additional context.
        """
        with self.tracer.span("handoff.complete", handoff_id=handoff_id):
            handoff = await self.state_store.get(f"handoff:{handoff_id}:state")
            if handoff is None:
                raise HandoffNotFoundError(f"Handoff {handoff_id} not found")

            # Cancel timeout watchdog
            task = self._timeout_tasks.pop(handoff_id, None)
            if task and not task.done():
                task.cancel()

            handoff["status"] = "completed"
            handoff["completed_at"] = datetime.utcnow().isoformat()
            handoff["resolution"] = resolution
            handoff["handback_to_agent"] = handback_to_agent

            await self.state_store.set(f"handoff:{handoff_id}:state", handoff)

            session_id = handoff["session_id"]
            session = await self.session_manager._load_session(session_id)

            if handback_to_agent:
                # Hand back to agent with context from human operator
                # Agent resumes with full knowledge of what human did
                if handback_context:
                    await self.state_store.set(
                        f"conv:{handoff['conversation_id']}:handback_context",
                        handback_context,
                    )

                # Resume session — transitions: handed_off -> resumed -> active
                await self.session_manager._transition(
                    session, SessionStatus.RESUMED,
                    reason=f"handback_from:{handoff_id}"
                )
                await self.session_manager._transition(
                    session, SessionStatus.ACTIVE
                )
            else:
                # Human resolved and closed
                await self.session_manager.close_session(
                    session_id, reason=f"resolved_by_human:{handoff_id}"
                )

            emit_event("handoff.completed", {
                "handoff_id": handoff_id,
                "session_id": session_id,
                "resolution": resolution,
                "handback": handback_to_agent,
                "duration_seconds": self._handoff_duration(handoff),
            })

            return handoff

    async def _timeout_watchdog(self, handoff_id: str, timeout_seconds: int):
        """
        Timeout with safe default (p. 214).
        If no human picks up within the timeout, execute the safe default
        action (e.g., create a ticket, send apology message).
        """
        await asyncio.sleep(timeout_seconds)

        handoff = await self.state_store.get(f"handoff:{handoff_id}:state")
        if handoff and handoff["status"] in ("queued", "assigned"):
            # No human resolved in time — apply safe default
            safe_default = handoff["timeout"]
            session_id = handoff["session_id"]

            # Send safe default message to user
            if safe_default.get("safe_default_message"):
                await self._send_safe_default_message(
                    session_id, safe_default["safe_default_message"]
                )

            # Execute safe default action
            await self._execute_safe_default_action(
                handoff, safe_default["safe_default_action"]
            )

            handoff["status"] = "timed_out"
            handoff["timed_out_at"] = datetime.utcnow().isoformat()
            await self.state_store.set(f"handoff:{handoff_id}:state", handoff)

            emit_event("handoff.timed_out", {
                "handoff_id": handoff_id,
                "safe_default_action": safe_default["safe_default_action"],
                "timeout_seconds": timeout_seconds,
            })

    async def _build_context_snapshot(
        self, session: dict, reason: str, reason_detail: str
    ) -> dict:
        """
        Build a comprehensive context snapshot for the human operator (p. 213).
        Includes conversation history, user context, agent internal state,
        and any relevant data the agent accumulated.
        """
        conv_id = session["conversation_id"]
        history = await self.state_store.get(f"conv:{conv_id}:history") or []

        return {
            "user": session["user"],
            "conversation_summary": session["conversation_state"].get(
                "context_summary", ""
            ),
            "conversation_history": history[-50:],  # Last 50 messages
            "agent_internal_state": {
                "assigned_agent": session["routing"]["assigned_agent"],
                "routing_reason": session["routing"]["routing_reason"],
                "goals": session["conversation_state"].get("goals"),
            },
        }

    async def _notify_user_handoff_started(self, session: dict, handoff: dict):
        """Notify the user that they are being connected to a human operator."""
        # Delivered through the session's active channel
        pass

    async def _send_safe_default_message(self, session_id: str, message: str):
        """Send safe default message to the user when handoff times out."""
        pass

    async def _execute_safe_default_action(self, handoff: dict, action: str):
        """Execute the safe default action (p. 214)."""
        if action == "apologize_and_create_ticket":
            # Create a support ticket in the external system
            pass
        elif action == "return_to_agent":
            # Hand back to agent with timeout note
            await self.complete_handoff(
                handoff["handoff_id"],
                resolution="timed_out_returned_to_agent",
                handback_to_agent=True,
                handback_context={"timeout": True},
            )

    def _select_queue(self, required_skills: list[str]) -> str:
        """Select the appropriate operator queue based on required skills."""
        if not required_skills:
            return "general-support"
        # Skill-based routing to specialized queues
        skill_queue_map = {
            "billing": "billing-escalations",
            "technical": "technical-escalations",
            "refund-policy": "billing-escalations",
            "security": "security-escalations",
        }
        for skill in required_skills:
            if skill in skill_queue_map:
                return skill_queue_map[skill]
        return "general-support"

    def _handoff_duration(self, handoff: dict) -> float:
        """Compute handoff duration in seconds."""
        initiated = datetime.fromisoformat(handoff["initiated_at"])
        completed = datetime.fromisoformat(
            handoff.get("completed_at", datetime.utcnow().isoformat())
        )
        return (completed - initiated).total_seconds()
```

---

## 8. Session Recovery

Session recovery ensures that conversations survive infrastructure failures, client disconnections, and server restarts. The design follows the exception handling pattern (p. 209) to provide graceful degradation and resumption.

### 8.1 Recovery Scenarios

| Scenario | Detection | Recovery Strategy |
|----------|-----------|-------------------|
| **Client disconnect** (network drop, browser close) | WebSocket `onclose` / SSE connection drop | Pause session. On reconnect, resume with history replay. State fully preserved in Redis + PostgreSQL. |
| **Server crash** | Health check failure, process exit | Session state is persisted durably. New server instance loads session from store. Client reconnects via load balancer. |
| **Agent failure** (LLM timeout, tool error) | Exception caught in agent execution loop | Retry with exponential backoff (p. 206). If unrecoverable, fall back to fallback agent (p. 27). Notify user of delay. |
| **Handoff queue failure** | Operator queue health check | Re-queue handoff. If queue is down, apply safe default action (p. 214) after timeout. |
| **State store failure** (Redis down) | Connection error on state read/write | Fall back to PostgreSQL for durable reads. Queue writes for replay when Redis recovers. Degrade to non-streaming mode. |

### 8.2 Reconnection Protocol

```
Client Reconnect Flow (WebSocket):

1. Client establishes new WebSocket connection
2. Client sends: {"event": "session.resume", "data": {"session_id": "sess_..."}}
3. Server validates session ownership (p. 148 — cross-user bleed prevention)
4. Server loads session state from durable store
5. Server transitions session: paused -> resumed -> active
6. Server replays last N messages to client
7. Server sends: {"event": "session.resumed", "data": {"history_replay": [...], "session_state": {...}}}
8. Conversation continues from where it left off
```

### 8.3 State Persistence Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                 State Persistence Layers                      │
│                                                               │
│  ┌──────────────────────────────┐                            │
│  │ Layer 1: In-Process Memory   │  Token stream buffers,     │
│  │ (volatile)                   │  active WebSocket refs,    │
│  │                               │  typing indicator state    │
│  └──────────────┬───────────────┘                            │
│                 │ every message                               │
│                 ▼                                             │
│  ┌──────────────────────────────┐                            │
│  │ Layer 2: Redis               │  Session state, routing,   │
│  │ (fast, semi-durable)         │  active timers, recent     │
│  │                               │  conversation window       │
│  └──────────────┬───────────────┘                            │
│                 │ every 10 messages or on state change        │
│                 ▼                                             │
│  ┌──────────────────────────────┐                            │
│  │ Layer 3: PostgreSQL          │  Full conversation history, │
│  │ (durable, source of truth)   │  session snapshots, user   │
│  │                               │  profiles, handoff records  │
│  └──────────────────────────────┘                            │
│                                                               │
│  Recovery priority: PostgreSQL > Redis > In-Process           │
└─────────────────────────────────────────────────────────────┘
```

### 8.4 Session Recovery Manager

```python
class SessionRecoveryManager:
    """
    Handles session recovery after failures (p. 209).
    Reconstructs session state from durable storage and
    manages reconnection replay.
    """

    def __init__(
        self,
        redis_store: "RedisStore",
        postgres_store: "PostgresStore",
        tracer: Tracer,
    ):
        self.redis = redis_store
        self.postgres = postgres_store
        self.tracer = tracer

    async def recover_session(self, session_id: str) -> dict:
        """
        Recover session state using layered fallback.
        Try Redis first (fast), fall back to PostgreSQL (durable).
        """
        with self.tracer.span("session.recover", session_id=session_id):
            # Try Redis first
            session = await self.redis.get(f"session:{session_id}:state")
            if session:
                return session

            # Fall back to PostgreSQL
            session = await self.postgres.get_session(session_id)
            if session:
                # Re-hydrate Redis for fast access
                await self.redis.set(
                    f"session:{session_id}:state", session
                )
                return session

            raise SessionNotFoundError(
                f"Session {session_id} not found in any store"
            )

    async def replay_history(
        self, conversation_id: str, last_n: int = 20
    ) -> list[dict]:
        """
        Load recent conversation history for client replay.
        Returns last N messages in chronological order.
        """
        # Try Redis for recent messages
        history = await self.redis.get(f"conv:{conversation_id}:history")
        if history:
            return history[-last_n:]

        # Fall back to PostgreSQL
        history = await self.postgres.get_conversation_history(
            conversation_id, limit=last_n
        )
        return history

    async def checkpoint_session(self, session: dict):
        """
        Persist session snapshot to durable storage.
        Called periodically and on every state transition.
        """
        session_id = session["session_id"]

        # Always write to Redis (fast path)
        await self.redis.set(f"session:{session_id}:state", session)

        # Write to PostgreSQL on state changes or every N messages
        message_count = session["conversation_state"]["message_count"]
        if message_count % 10 == 0 or session["status"] in (
            "paused", "handed_off", "closed"
        ):
            await self.postgres.upsert_session(session)

    async def recover_all_active_sessions(self) -> list[str]:
        """
        On server startup, recover all sessions that were active
        before the crash. Re-initialize idle timers and handoff watchdogs.
        """
        active_sessions = await self.postgres.list_sessions_by_status(
            statuses=["active", "paused", "handed_off"]
        )

        recovered = []
        for session in active_sessions:
            try:
                await self.redis.set(
                    f"session:{session['session_id']}:state", session
                )
                recovered.append(session["session_id"])
            except Exception as e:
                self.tracer.record_exception(e)

        emit_event("session.recovery.complete", {
            "recovered_count": len(recovered),
            "total_found": len(active_sessions),
        })

        return recovered
```

---

## 9. Conversation Threading

Users can maintain multiple concurrent conversations, each as a separate thread. Threads prevent topic mixing and allow users to context-switch between different issues.

### 9.1 Threading Model

```
┌─────────────────────────────────────────────────────┐
│                  User: Jane Doe                      │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │ Conversation: conv_001                        │    │
│  │                                                │    │
│  │  ┌────────────────────┐  ┌──────────────────┐ │    │
│  │  │ Thread: thr_001    │  │ Thread: thr_002  │ │    │
│  │  │ "Billing inquiry"  │  │ "Feature request"│ │    │
│  │  │ Agent: support     │  │ Agent: product   │ │    │
│  │  │ Status: active     │  │ Status: paused   │ │    │
│  │  │ Messages: 12       │  │ Messages: 5      │ │    │
│  │  └────────────────────┘  └──────────────────┘ │    │
│  └──────────────────────────────────────────────────┘  │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │ Conversation: conv_002 (different channel)    │    │
│  │                                                │    │
│  │  ┌────────────────────┐                       │    │
│  │  │ Thread: thr_003    │                       │    │
│  │  │ "API integration"  │                       │    │
│  │  │ Agent: developer   │                       │    │
│  │  │ Status: active     │                       │    │
│  │  └────────────────────┘                       │    │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### 9.2 Thread Schema

```json
{
  "thread_id": "thr_001",
  "conversation_id": "conv_001",
  "user_id": "usr_jane-doe-12345",
  "topic": "Billing inquiry — disputed charge",
  "status": "active",
  "session_id": "sess_current_abc",
  "created_at": "2026-02-27T10:00:00Z",
  "last_message_at": "2026-02-27T10:15:32Z",
  "message_count": 12,
  "assigned_agent": "agent:support-triage",
  "metadata": {
    "tags": ["billing", "dispute"],
    "priority": "high"
  }
}
```

### 9.3 Thread Manager

```python
class ThreadManager:
    """
    Manages multiple concurrent conversation threads per user.
    Each thread has its own session, routing, and message history.
    Thread isolation ensures cross-conversation bleed prevention (p. 148).
    """

    MAX_CONCURRENT_THREADS = 10  # Per user limit

    def __init__(self, state_store: StateStore, session_manager: SessionManager):
        self.state_store = state_store
        self.session_manager = session_manager

    async def create_thread(
        self,
        user_id: str,
        conversation_id: str,
        topic: str,
        initial_message: dict,
        channel: dict,
    ) -> dict:
        """Create a new conversation thread within a conversation."""
        # Enforce concurrent thread limit
        active_threads = await self.list_active_threads(user_id)
        if len(active_threads) >= self.MAX_CONCURRENT_THREADS:
            raise ThreadLimitExceededError(
                f"User {user_id} has reached the maximum of "
                f"{self.MAX_CONCURRENT_THREADS} concurrent threads"
            )

        thread_id = f"thr_{uuid.uuid4()}"
        thread = {
            "thread_id": thread_id,
            "conversation_id": conversation_id,
            "user_id": user_id,
            "topic": topic,
            "status": "active",
            "created_at": datetime.utcnow().isoformat(),
            "message_count": 0,
        }

        # Create a new session for this thread
        session = await self.session_manager.create_session(
            user_id=user_id,
            channel=channel,
            initial_message=initial_message,
            conversation_id=conversation_id,
            thread_id=thread_id,
        )
        thread["session_id"] = session["session_id"]
        thread["assigned_agent"] = session["routing"]["assigned_agent"]

        await self.state_store.set(f"thread:{thread_id}:state", thread)
        await self.state_store.list_append(
            f"user:{user_id}:threads", thread_id
        )

        return thread

    async def list_active_threads(self, user_id: str) -> list[dict]:
        """List all active threads for a user."""
        thread_ids = await self.state_store.get(
            f"user:{user_id}:threads"
        ) or []

        threads = []
        for tid in thread_ids:
            thread = await self.state_store.get(f"thread:{tid}:state")
            if thread and thread["status"] == "active":
                threads.append(thread)
        return threads

    async def switch_thread(self, user_id: str, thread_id: str) -> dict:
        """
        Switch user's active focus to a different thread.
        The previous thread is paused, and this thread is resumed.
        """
        thread = await self.state_store.get(f"thread:{thread_id}:state")
        if thread is None:
            raise ThreadNotFoundError(f"Thread {thread_id} not found")

        # Verify ownership (p. 148 — cross-user bleed prevention)
        if thread["user_id"] != user_id:
            raise PermissionError("Thread belongs to another user")

        # Resume this thread's session
        if thread.get("session_id"):
            session = await self.session_manager._load_session(
                thread["session_id"]
            )
            if session["status"] == SessionStatus.PAUSED.value:
                await self.session_manager.handle_message(
                    thread["session_id"],
                    {"content": {"type": "system", "text": "[thread_switched]"}, "direction": "system"},
                )

        return thread

    async def archive_thread(self, thread_id: str):
        """Archive a completed thread."""
        thread = await self.state_store.get(f"thread:{thread_id}:state")
        if thread:
            thread["status"] = "archived"
            thread["archived_at"] = datetime.utcnow().isoformat()
            await self.state_store.set(f"thread:{thread_id}:state", thread)

            # Close the associated session
            if thread.get("session_id"):
                await self.session_manager.close_session(
                    thread["session_id"], reason="thread_archived"
                )
```

---

## 10. API Surface

### 10.1 REST API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/conversations` | Create a new conversation and initial session |
| `GET` | `/v1/conversations/{conversation_id}` | Get conversation metadata and thread list |
| `POST` | `/v1/conversations/{conversation_id}/messages` | Send a message (returns SSE stream if `Accept: text/event-stream`) |
| `GET` | `/v1/conversations/{conversation_id}/messages` | Get conversation message history (paginated) |
| `GET` | `/v1/conversations/{conversation_id}/stream` | SSE endpoint for real-time events |
| `POST` | `/v1/conversations/{conversation_id}/threads` | Create a new thread in a conversation |
| `GET` | `/v1/conversations/{conversation_id}/threads` | List all threads |
| `POST` | `/v1/sessions/{session_id}/pause` | Pause a session |
| `POST` | `/v1/sessions/{session_id}/resume` | Resume a paused session |
| `POST` | `/v1/sessions/{session_id}/close` | Close a session |
| `GET` | `/v1/sessions/{session_id}` | Get session state |
| `POST` | `/v1/sessions/{session_id}/handoff` | Initiate agent-to-human handoff |
| `POST` | `/v1/handoffs/{handoff_id}/assign` | Assign human operator to handoff |
| `POST` | `/v1/handoffs/{handoff_id}/complete` | Complete handoff (resolve or handback) |
| `GET` | `/v1/handoffs/{handoff_id}` | Get handoff status and context |
| `GET` | `/v1/users/{user_id}/conversations` | List user's conversations |
| `GET` | `/v1/users/{user_id}/active-sessions` | List user's active sessions |

### 10.2 WebSocket Endpoint

```
WS /v1/ws/conversations?token={auth_token}
```

**Client-to-server events:**

| Event | Payload | Description |
|-------|---------|-------------|
| `message.send` | `{"text": "...", "thread_id": "..."}` | Send a message |
| `typing.start` | `{}` | User started typing |
| `typing.stop` | `{}` | User stopped typing |
| `message.read` | `{"message_id": "..."}` | Mark message as read |
| `session.resume` | `{"session_id": "..."}` | Resume a paused session |
| `session.close` | `{"reason": "..."}` | Close current session |
| `thread.switch` | `{"thread_id": "..."}` | Switch to a different thread |
| `thread.create` | `{"topic": "..."}` | Create a new thread |
| `ping` | `{}` | Keepalive ping |

**Server-to-client events:**

| Event | Payload | Description |
|-------|---------|-------------|
| `connection.ready` | `{"user_id": "...", "capabilities": [...]}` | Connection established |
| `session.created` | `{"session_id": "..."}` | New session created |
| `session.resumed` | `{"session_id": "...", "history_replay": [...]}` | Session resumed with history |
| `session.paused` | `{"reason": "..."}` | Session paused |
| `session.closed` | `{"reason": "..."}` | Session closed |
| `response.start` | `{"message_id": "...", "agent": "..."}` | Agent started generating |
| `response.token` | `{"message_id": "...", "token": "..."}` | Streamed token |
| `response.end` | `{"message_id": "...", "full_text": "..."}` | Response complete |
| `agent.thinking` | `{"status": "..."}` | Agent processing status |
| `session.handoff` | `{"operator": "...", "reason": "..."}` | Handoff to human initiated |
| `session.handback` | `{"agent": "..."}` | Handback to agent |
| `error` | `{"code": "...", "message": "..."}` | Error notification |
| `pong` | `{}` | Keepalive response |

### 10.3 Webhook Endpoints (Inbound from Channels)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/webhooks/slack/events` | Slack Events API receiver |
| `POST` | `/v1/webhooks/slack/interactions` | Slack interactive component callbacks |
| `POST` | `/v1/webhooks/telegram/update` | Telegram Bot API update receiver |
| `POST` | `/v1/webhooks/widget/message` | Web widget message receiver (fallback for non-WS) |

### 10.4 Example: Send Message with Streaming Response

```bash
# REST API with SSE streaming
curl -N -X POST https://api.agentforge.io/v1/conversations/conv_001/messages \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Why was I charged $49.99 on my February invoice?",
    "thread_id": "thr_001"
  }'

# Response (SSE stream):
# event: response.start
# data: {"message_id": "msg_resp_001", "agent": "agent:support-triage"}
#
# event: response.token
# data: {"message_id": "msg_resp_001", "token": "I"}
#
# event: response.token
# data: {"message_id": "msg_resp_001", "token": " can"}
#
# event: response.token
# data: {"message_id": "msg_resp_001", "token": " see"}
#
# ... (more tokens)
#
# event: response.end
# data: {"message_id": "msg_resp_001", "full_text": "I can see a charge of $49.99 on your February invoice. This is a pro-rata fee for upgrading from Basic to Pro plan on February 15th.", "usage": {"input_tokens": 280, "output_tokens": 42}}
```

---

## 11. Failure Modes & Mitigations

| # | Failure Mode | Impact | Detection | Mitigation | Pattern Reference |
|---|-------------|--------|-----------|------------|-------------------|
| 1 | **Agent LLM timeout** | User receives no response | Request timeout (30s default) | Retry with exponential backoff; after 3 retries, fall back to fallback agent (p. 27). Send `agent.thinking` event to user during retries. | Exception Handling (p. 206) |
| 2 | **WebSocket disconnect** | User loses real-time connection | `onclose` event / missing pong | Pause session, preserve state. Client auto-reconnects with `session.resume`. History replayed on reconnect. | Session Recovery (p. 209) |
| 3 | **Redis failure** | Session state reads/writes fail | Connection error, health check | Fall back to PostgreSQL for reads. Queue writes for replay. Degrade to request-response (no streaming). | Exception Handling (p. 209) |
| 4 | **Routing model failure** | Cannot classify intent | LLM call error | Route to fallback agent (p. 27). Log failure for investigation. | Routing Fallback (p. 27) |
| 5 | **Handoff queue overload** | Users wait indefinitely for human | Queue depth monitoring, SLA breach alert | Apply timeout with safe default (p. 214): send apology, create ticket. Expand queue capacity alert. | HITL Timeout (p. 214) |
| 6 | **Cross-user session bleed** | User sees another user's conversation | Invariant check on session load | Every session load validates `user_id` match. Sessions keyed by both `session_id` and `user_id`. Guardrail agent monitors access patterns. | Session Scoping (p. 148) |
| 7 | **Channel adapter crash** | One channel stops working | Health check, error rate spike | Circuit breaker per adapter. Other channels unaffected. Auto-restart with backoff. | Exception Handling (p. 205) |
| 8 | **Output guardrail blocks response** | User receives no response | Guardrail returns `non_compliant` | Regenerate response with stricter constraints. After 3 failures, send safe fallback message: "I'm unable to answer that. Let me connect you with someone who can help." | Guardrails (p. 286) |
| 9 | **Conversation history corruption** | Agent loses context | Checksum mismatch on history load | Rebuild from PostgreSQL snapshot. Summarize if full history unavailable. Alert ops team. | Memory Management (p. 154) |
| 10 | **Server crash mid-stream** | Partial response delivered to user | Client receives no `response.end` event | Client-side timeout triggers reconnect. On resume, server detects incomplete response and resends or continues. | Session Recovery (p. 209) |

### Error Classification and Handling

Following the Error Triad (p. 205):

```python
class ConversationErrorHandler:
    """
    Classifies and handles conversation-layer errors.
    Follows the Error Triad: Detect -> Classify -> Recover (p. 205).
    """

    async def handle_error(self, error: Exception, session: dict) -> dict:
        """Classify error and apply appropriate recovery strategy."""

        # 1. DETECTION — error is already caught

        # 2. CLASSIFICATION
        if isinstance(error, (TimeoutError, ConnectionError)):
            category = "transient"
        elif isinstance(error, (RoutingError, InvalidTransitionError)):
            category = "logic"
        elif isinstance(error, (SessionNotFoundError, PermissionError)):
            category = "unrecoverable"
        else:
            category = "unknown"

        # 3. RECOVERY
        if category == "transient":
            # Retry with exponential backoff (p. 206)
            return {"action": "retry", "max_retries": 3, "backoff": "exponential"}

        elif category == "logic":
            # Re-route or re-prompt (p. 205)
            return {"action": "reroute", "fallback": True}

        elif category == "unrecoverable":
            # Escalate — close session gracefully, notify user
            return {
                "action": "escalate",
                "notify_user": True,
                "message": "I apologize, but I encountered an issue. "
                           "Please start a new conversation.",
            }

        else:
            # Unknown — log for investigation, apply safe default
            return {
                "action": "safe_default",
                "message": "Something went wrong. Our team has been notified.",
            }
```

---

## 12. Instrumentation

### 12.1 Trace Structure

Every conversation interaction produces a trace following the platform's observability architecture:

```
Trace: conversation_interaction
├── Span: channel.receive
│   ├── channel_type: "websocket"
│   ├── message_size_bytes: 156
│   └── latency_ms: 2
│
├── Span: guardrail.input_validation (p. 286)
│   ├── pii_detected: false
│   ├── injection_detected: false
│   ├── safety_score: 0.98
│   └── latency_ms: 15
│
├── Span: session.handle_message
│   ├── session_id: "sess_..."
│   ├── session_status: "active"
│   ├── message_count: 13
│   └── latency_ms: 5
│
├── Span: conversation.route (p. 25)
│   ├── method: "session_continuity"
│   ├── assigned_agent: "agent:support-triage"
│   └── latency_ms: 0
│
├── Span: agent.execute
│   ├── agent: "agent:support-triage"
│   ├── model: "sonnet"
│   ├── input_tokens: 280
│   ├── output_tokens: 42
│   ├── tool_calls: ["billing_lookup"]
│   ├── streaming: true
│   └── latency_ms: 2800
│
├── Span: guardrail.output_filter (p. 286)
│   ├── pii_redacted: false
│   ├── safety_check: "compliant"
│   └── latency_ms: 12
│
├── Span: stream.deliver
│   ├── channel: "websocket"
│   ├── tokens_streamed: 42
│   ├── time_to_first_token_ms: 450
│   └── total_stream_duration_ms: 2200
│
└── Metadata
    ├── conversation_id: "conv_..."
    ├── thread_id: "thr_..."
    ├── user_id: "usr_..."
    ├── total_latency_ms: 3034
    ├── total_tokens: 322
    └── guardrail_interventions: 0
```

### 12.2 Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `session.created_total` | Counter | `channel`, `organization` | Total sessions created |
| `session.active_gauge` | Gauge | `channel`, `status` | Currently active sessions |
| `session.duration_seconds` | Histogram | `channel`, `close_reason` | Session duration distribution |
| `message.inbound_total` | Counter | `channel` | Total inbound user messages |
| `message.outbound_total` | Counter | `channel`, `agent` | Total outbound agent responses |
| `routing.latency_seconds` | Histogram | `method` (classification, continuity, fallback) | Routing decision latency |
| `routing.fallback_total` | Counter | — | Times fallback agent was used |
| `streaming.time_to_first_token_seconds` | Histogram | `agent`, `model` | Time from message received to first token |
| `streaming.tokens_per_second` | Histogram | `agent`, `model` | Token delivery throughput |
| `handoff.initiated_total` | Counter | `reason`, `mode` | Total handoffs initiated |
| `handoff.wait_seconds` | Histogram | `queue` | Time waiting for human operator |
| `handoff.timeout_total` | Counter | `queue` | Handoffs that timed out |
| `handoff.completed_total` | Counter | `resolution` (resolved, handback) | Completed handoffs |
| `recovery.session_resumed_total` | Counter | `reason` (disconnect, pause_timeout) | Sessions successfully resumed |
| `recovery.session_lost_total` | Counter | `reason` | Sessions that could not be recovered |
| `thread.concurrent_gauge` | Gauge | `user_id` | Concurrent active threads per user |
| `guardrail.input_rejected_total` | Counter | `reason` | Messages rejected by input guardrail |
| `guardrail.output_filtered_total` | Counter | `reason` | Responses modified by output guardrail |
| `error.total` | Counter | `category` (transient, logic, unrecoverable) | Errors by classification |
| `channel.health` | Gauge | `channel` | Channel adapter health (1=healthy, 0=down) |

### 12.3 Alerts

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| `SessionBleedDetected` | Session loaded with mismatched `user_id` | Critical | Block access, page on-call, investigate |
| `HandoffQueueBacklog` | Queue depth > 20 OR wait time p95 > 5 minutes | High | Notify ops, consider auto-scaling human agents |
| `ChannelAdapterDown` | Channel health = 0 for > 30 seconds | High | Page on-call, activate circuit breaker |
| `HighRoutingFallbackRate` | Fallback rate > 25% over 15 minutes | Medium | Review routing model, check for new intent patterns |
| `StreamingLatencyDegraded` | Time-to-first-token p95 > 3 seconds | Medium | Check LLM provider status, consider model fallback |
| `SessionRecoveryFailure` | Recovery success rate < 95% | High | Check state store health, investigate data corruption |
| `GuardrailRejectionSpike` | Input rejection rate > 10% over 5 minutes | Medium | Check for attack pattern, review guardrail sensitivity |
| `ErrorRateElevated` | Error rate > 5% over 5 minutes | High | Check agent health, LLM provider status, infrastructure |

### 12.4 Dashboard Panels

The Conversation & Session Management dashboard provides the following views:

1. **Live Sessions**: Real-time count of active sessions by channel and status, with drill-down to individual sessions
2. **Message Flow**: Inbound/outbound message rate over time, segmented by channel
3. **Routing Distribution**: Breakdown of which teams/agents receive conversations, fallback rate
4. **Streaming Performance**: Time-to-first-token and tokens-per-second distributions
5. **Handoff Pipeline**: Queue depth, wait times, timeout rate, resolution breakdown
6. **Session Lifecycle**: Funnel from created to active to closed, with drop-off analysis
7. **Error & Recovery**: Error rates by classification, recovery success rate
8. **Channel Health**: Per-channel adapter health, latency, and error rates

---

*This subsystem integrates with the Team Orchestrator (02) for agent dispatch, Memory & Context Management (11) for session persistence, Guardrail System (04) for message safety, and Observability Platform (05) for full conversation traceability. See individual subsystem documents for their detailed specifications.*
