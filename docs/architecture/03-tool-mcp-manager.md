# Tool & MCP Manager — Architecture Design

## 1. Overview & Responsibility

The **Tool & MCP Manager** is subsystem #3 of the AgentForge platform. It is the centralized control plane through which every agent and team discovers, acquires, and invokes external capabilities. No agent in the platform calls a tool directly; all tool traffic is mediated by this subsystem.

Core responsibilities:

1. **MCP Server Registration** — onboard and manage MCP servers using both STDIO (local process) and HTTP+SSE (remote service) transports (p. 160).
2. **Tool Definition** — maintain a catalog of tools with self-contained descriptions, JSON Schema parameters, permission metadata, and safety flags (p. 85, p. 162).
3. **Tool Assignment** — bind tools to individual agents or entire teams following the Principle of Least Privilege (p. 288).
4. **Health Checking** — continuously verify that registered MCP servers are alive and responsive, using stateless probe requests (p. 163).
5. **Versioning & Lifecycle** — track tool versions, manage deprecation schedules, and enforce compatibility constraints.
6. **Tool Discovery & Catalog** — expose a queryable catalog so that supervisors and planning agents can reason about available capabilities.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Tool & MCP Manager                            │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │  MCP Server   │  │  Tool        │  │  Assignment               │  │
│  │  Registry     │  │  Catalog     │  │  Engine                   │  │
│  │              │  │              │  │  (Least Privilege)        │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬──────────────┘  │
│         │                 │                        │                 │
│  ┌──────┴─────────────────┴────────────────────────┴──────────────┐  │
│  │                    Lifecycle Controller                          │  │
│  │     (Health Checks / Versioning / Deprecation / Caching)        │  │
│  └─────────────────────────────┬──────────────────────────────────┘  │
│                                │                                     │
│  ┌─────────────────────────────┴──────────────────────────────────┐  │
│  │                     Security Layer                               │  │
│  │  (before_tool_callback / Output Sanitization / Permission Eval) │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
         │                    │                     │
         ▼                    ▼                     ▼
   STDIO Servers        HTTP+SSE Servers     Observability Platform
   (local process)      (remote service)     (traces, metrics, logs)
```

### Relationship to Other Subsystems

| Subsystem | Interaction |
|-----------|-------------|
| **Agent Builder** (01) | Reads the tool catalog to populate agent `tools` field during agent creation |
| **Team Orchestrator** (02) | Requests tool sets for teams; receives team-scoped tool bindings |
| **Guardrail System** (04) | Provides `before_tool_callback` hook; receives tool output for sanitization |
| **Observability Platform** (05) | Receives all tool invocation traces, health-check metrics, catalog events |
| **Cost & Resource Manager** (09) | Provides per-tool cost metadata; enforces token budgets on tool calls |

### MCP vs A2A Distinction (p. 165)

It is critical to understand the boundary:

- **MCP (Model Context Protocol)** connects an agent to a *tool server* — a deterministic, code-driven service that exposes resources, tools, and prompts (p. 159). The agent is the intelligent party; the server is a passive capability provider.
- **A2A (Agent-to-Agent)** connects two *agents* — both are intelligent, autonomous parties that negotiate task delegation (p. 240).

This subsystem manages **MCP connections only**. Agent-to-agent communication is handled by the Team Orchestrator (subsystem #2).

---

## 2. MCP Server Registration Schema

Every MCP server must be registered before its tools become available. Registration captures identity, transport, authentication, and operational metadata.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "MCPServerRegistration",
  "type": "object",
  "required": ["server_id", "name", "transport", "tools"],
  "properties": {
    "server_id": {
      "type": "string",
      "format": "uuid",
      "description": "Unique identifier for this MCP server instance"
    },
    "name": {
      "type": "string",
      "description": "Human-readable server name (e.g. 'filesystem-server', 'web-search-server')"
    },
    "description": {
      "type": "string",
      "description": "What this server does, written as if explaining to a smart intern (p. 86)"
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Semantic version of the server"
    },
    "transport": {
      "type": "object",
      "oneOf": [
        {
          "properties": {
            "type": { "const": "stdio" },
            "command": { "type": "string", "description": "Executable path" },
            "args": { "type": "array", "items": { "type": "string" } },
            "env": {
              "type": "object",
              "additionalProperties": { "type": "string" },
              "description": "Environment variables passed to the process"
            }
          },
          "required": ["type", "command"]
        },
        {
          "properties": {
            "type": { "const": "http_sse" },
            "url": { "type": "string", "format": "uri" },
            "auth": {
              "type": "object",
              "properties": {
                "method": { "enum": ["bearer", "mtls", "api_key"] },
                "credentials_ref": {
                  "type": "string",
                  "description": "Reference to secret store (e.g. vault://mcp/web-search/api-key)"
                }
              },
              "required": ["method", "credentials_ref"]
            }
          },
          "required": ["type", "url"]
        }
      ]
    },
    "health_check": {
      "type": "object",
      "properties": {
        "interval_seconds": { "type": "integer", "default": 30 },
        "timeout_seconds": { "type": "integer", "default": 5 },
        "unhealthy_threshold": { "type": "integer", "default": 3 },
        "healthy_threshold": { "type": "integer", "default": 1 }
      }
    },
    "tools": {
      "type": "array",
      "items": { "$ref": "#/$defs/ToolDefinition" },
      "description": "Tools exposed by this server (populated on registration or via discovery)"
    },
    "resources": {
      "type": "array",
      "items": { "type": "object" },
      "description": "MCP Resources exposed by this server (p. 159)"
    },
    "prompts": {
      "type": "array",
      "items": { "type": "object" },
      "description": "MCP Prompt templates exposed by this server (p. 159)"
    },
    "tags": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Categorization tags for discovery (e.g. ['search', 'web', 'external'])"
    },
    "owner": {
      "type": "string",
      "description": "Team or individual responsible for this server"
    },
    "registered_at": {
      "type": "string",
      "format": "date-time"
    },
    "status": {
      "enum": ["active", "degraded", "unhealthy", "deprecated", "deregistered"],
      "default": "active"
    }
  }
}
```

### Transport Considerations (p. 160)

| Transport | Use Case | Pros | Cons |
|-----------|----------|------|------|
| **STDIO** | Local tools, development, sandboxed environments | Zero network overhead; process-level isolation; simple security model | Single-machine only; one client per process |
| **HTTP+SSE** | Remote services, shared infrastructure, production deployments | Multi-client; load-balanced; independently scalable | Network latency; requires auth; more failure modes |

Servers should be **stateless** (p. 163): they must not maintain session state between calls. Any state required by a tool (e.g., database connections, file handles) must be managed internally by the server and not exposed to the MCP client.

---

## 3. Tool Definition Schema

Each tool is a discrete, self-contained capability with a clear description that enables the LLM to decide when and how to use it (p. 162). Tool descriptions follow the "smart intern" heuristic (p. 86): write descriptions as if explaining to a competent colleague who is unfamiliar with the specific system.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ToolDefinition",
  "type": "object",
  "required": ["tool_id", "name", "description", "input_schema", "server_id"],
  "properties": {
    "tool_id": {
      "type": "string",
      "format": "uuid",
      "description": "Unique identifier for this tool"
    },
    "name": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_]{1,63}$",
      "description": "Machine-readable tool name (e.g. 'web_search', 'create_file')"
    },
    "description": {
      "type": "string",
      "minLength": 20,
      "maxLength": 1024,
      "description": "Self-contained description of what this tool does, when to use it, and what it returns. Written as if explaining to a smart intern (p. 86, p. 162)."
    },
    "input_schema": {
      "type": "object",
      "description": "JSON Schema defining the tool's parameters (p. 85). Every parameter must have a description.",
      "properties": {
        "type": { "const": "object" },
        "properties": { "type": "object" },
        "required": { "type": "array", "items": { "type": "string" } }
      }
    },
    "output_schema": {
      "type": "object",
      "description": "JSON Schema defining the expected output structure. Used for validation and documentation."
    },
    "server_id": {
      "type": "string",
      "format": "uuid",
      "description": "The MCP server that hosts this tool"
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$"
    },
    "permissions": {
      "type": "object",
      "description": "Permission metadata used by the Assignment Engine for Least Privilege evaluation (p. 288)",
      "properties": {
        "scope": {
          "enum": ["read", "write", "execute", "admin"],
          "description": "Broadest permission category this tool requires"
        },
        "resources_accessed": {
          "type": "array",
          "items": { "type": "string" },
          "description": "External resources the tool accesses (e.g. 'filesystem:/tmp', 'network:api.example.com')"
        },
        "data_classification": {
          "enum": ["public", "internal", "confidential", "restricted"],
          "description": "Highest data classification level this tool may handle"
        }
      }
    },
    "flags": {
      "type": "object",
      "description": "Safety and behavioral flags",
      "properties": {
        "irreversible": {
          "type": "boolean",
          "default": false,
          "description": "If true, this tool performs actions that cannot be undone (e.g. send_email, delete_record). Requires confirmation or HITL approval (p. 91)."
        },
        "side_effects": {
          "type": "boolean",
          "default": false,
          "description": "If true, this tool modifies external state (e.g. writes to database, calls external API)"
        },
        "expensive": {
          "type": "boolean",
          "default": false,
          "description": "If true, this tool has significant cost or latency; prefer caching (p. 264)"
        },
        "requires_hitl": {
          "type": "boolean",
          "default": false,
          "description": "If true, every invocation must be approved by a human (p. 207)"
        },
        "cacheable": {
          "type": "boolean",
          "default": false,
          "description": "If true, results can be cached with tool-level caching (p. 264)"
        },
        "cache_ttl_seconds": {
          "type": "integer",
          "default": 0,
          "description": "TTL for cached results; 0 means use system default"
        }
      }
    },
    "rate_limit": {
      "type": "object",
      "properties": {
        "max_calls_per_minute": { "type": "integer" },
        "max_calls_per_agent_per_minute": { "type": "integer" }
      }
    },
    "deprecated": {
      "type": "boolean",
      "default": false
    },
    "deprecated_message": {
      "type": "string",
      "description": "Migration guidance when deprecated (e.g. 'Use web_search_v2 instead')"
    },
    "examples": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "input": { "type": "object" },
          "output": { "type": "object" },
          "description": { "type": "string" }
        }
      },
      "description": "Example invocations for documentation and LLM context"
    }
  }
}
```

### Example: Well-Written Tool Definition

```json
{
  "tool_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "web_search",
  "description": "Search the web using a text query and return a list of relevant results. Each result includes a title, URL, and snippet. Use this tool when you need to find current information that is not in your training data. Do NOT use this for searching internal documents — use 'doc_search' instead. Returns up to 10 results by default.",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "The search query. Be specific and include relevant keywords. Example: 'Python asyncio tutorial 2025'"
      },
      "max_results": {
        "type": "integer",
        "minimum": 1,
        "maximum": 50,
        "default": 10,
        "description": "Maximum number of results to return"
      },
      "date_range": {
        "type": "string",
        "enum": ["day", "week", "month", "year", "all"],
        "default": "all",
        "description": "Restrict results to a time period"
      }
    },
    "required": ["query"]
  },
  "server_id": "web-search-server-001",
  "version": "2.1.0",
  "permissions": {
    "scope": "read",
    "resources_accessed": ["network:*.google.com", "network:*.bing.com"],
    "data_classification": "public"
  },
  "flags": {
    "irreversible": false,
    "side_effects": false,
    "expensive": false,
    "cacheable": true,
    "cache_ttl_seconds": 300
  },
  "rate_limit": {
    "max_calls_per_minute": 60,
    "max_calls_per_agent_per_minute": 10
  }
}
```

---

## 4. Tool Assignment Model

Tool assignment is the mechanism by which the platform enforces the **Principle of Least Privilege** (p. 288): every agent receives only the tools it needs for its specific task, and no more. This is a core security property of the platform.

### 4.1 Assignment Hierarchy

```
┌──────────────────────────────────────────────────┐
│                 Platform Level                    │
│   Global tool policies (banned tools, global      │
│   rate limits, data classification ceilings)      │
└──────────────────────┬───────────────────────────┘
                       │
         ┌─────────────┴─────────────┐
         │                           │
┌────────┴──────────┐    ┌──────────┴────────────┐
│   Team Level       │    │   Team Level           │
│   Team-scoped tool │    │   Different team,      │
│   allowlist        │    │   different allowlist   │
└────────┬──────────┘    └──────────┬────────────┘
         │                          │
    ┌────┴────┐               ┌────┴────┐
    │         │               │         │
┌───┴───┐ ┌──┴────┐    ┌────┴───┐ ┌───┴────┐
│Agent A│ │Agent B│    │Agent C │ │Agent D │
│ tools │ │ tools │    │ tools  │ │ tools  │
│ ⊂ team│ │ ⊂ team│    │ ⊂ team │ │ ⊂ team │
└───────┘ └───────┘    └────────┘ └────────┘
```

**Rule**: An agent's effective tool set is the **intersection** of:
1. The tools assigned to the agent directly
2. The tools allowed for the agent's team
3. The tools permitted by platform-level policy

### 4.2 Assignment Schema

```json
{
  "title": "ToolAssignment",
  "type": "object",
  "required": ["assignment_id", "target", "tools"],
  "properties": {
    "assignment_id": {
      "type": "string",
      "format": "uuid"
    },
    "target": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "type": { "const": "agent" },
            "agent_id": { "type": "string", "format": "uuid" }
          },
          "required": ["type", "agent_id"]
        },
        {
          "type": "object",
          "properties": {
            "type": { "const": "team" },
            "team_id": { "type": "string", "format": "uuid" }
          },
          "required": ["type", "team_id"]
        }
      ]
    },
    "tools": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "tool_id": { "type": "string" },
          "constraints": {
            "type": "object",
            "description": "Per-assignment constraints that further narrow tool capabilities",
            "properties": {
              "allowed_parameters": {
                "type": "object",
                "description": "Restrict parameter values (e.g. max_results <= 10)"
              },
              "max_calls_per_task": { "type": "integer" },
              "require_confirmation": { "type": "boolean" }
            }
          }
        },
        "required": ["tool_id"]
      }
    },
    "valid_from": { "type": "string", "format": "date-time" },
    "valid_until": { "type": "string", "format": "date-time" },
    "granted_by": { "type": "string", "description": "User or system that created this assignment" },
    "justification": { "type": "string", "description": "Why this agent/team needs these tools" }
  }
}
```

### 4.3 Least Privilege Enforcement Logic

```python
from dataclasses import dataclass, field

@dataclass
class ToolPermission:
    tool_id: str
    constraints: dict = field(default_factory=dict)

@dataclass
class EffectiveToolSet:
    """Resolved set of tools an agent can actually use."""
    agent_id: str
    tools: list[ToolPermission]
    resolved_at: str  # ISO timestamp


class AssignmentEngine:
    """
    Resolves the effective tool set for an agent by intersecting
    agent-level, team-level, and platform-level assignments.
    Enforces the Principle of Least Privilege (p. 288).
    """

    def __init__(self, registry: "ToolRegistry", policy_store: "PolicyStore"):
        self.registry = registry
        self.policy_store = policy_store

    async def resolve_effective_tools(
        self,
        agent_id: str,
        team_id: str,
        task_context: dict | None = None,
    ) -> EffectiveToolSet:
        # 1. Gather all assignment layers
        platform_allowed = await self.policy_store.get_platform_allowed_tools()
        team_assigned = await self.registry.get_team_tools(team_id)
        agent_assigned = await self.registry.get_agent_tools(agent_id)

        # 2. Intersect: agent tools must be a subset of team tools,
        #    which must be a subset of platform tools
        team_effective = [
            t for t in team_assigned
            if t.tool_id in {p.tool_id for p in platform_allowed}
        ]
        agent_effective = [
            t for t in agent_assigned
            if t.tool_id in {p.tool_id for p in team_effective}
        ]

        # 3. Apply constraints — most restrictive wins
        resolved = []
        for tool_perm in agent_effective:
            merged_constraints = self._merge_constraints(
                platform_constraints=self._find(platform_allowed, tool_perm.tool_id),
                team_constraints=self._find(team_effective, tool_perm.tool_id),
                agent_constraints=tool_perm,
            )
            resolved.append(merged_constraints)

        # 4. Filter deprecated tools with warning
        final = []
        for tool_perm in resolved:
            tool_def = await self.registry.get_tool(tool_perm.tool_id)
            if tool_def.deprecated:
                logger.warning(
                    "Agent %s assigned deprecated tool %s: %s",
                    agent_id, tool_perm.tool_id, tool_def.deprecated_message,
                )
            else:
                final.append(tool_perm)

        return EffectiveToolSet(
            agent_id=agent_id,
            tools=final,
            resolved_at=datetime.utcnow().isoformat(),
        )

    def _merge_constraints(self, platform_constraints, team_constraints, agent_constraints):
        """Most restrictive constraint wins at each level."""
        # Example: if platform says max_calls_per_task=100 and team says 50,
        # the effective limit is 50 (most restrictive).
        merged = ToolPermission(tool_id=agent_constraints.tool_id)
        for key in ("max_calls_per_task", "require_confirmation"):
            values = [
                getattr(c.constraints, key, None)
                for c in [platform_constraints, team_constraints, agent_constraints]
                if c is not None
            ]
            if values:
                # For numeric: take minimum; for boolean: take True if any is True
                if isinstance(values[0], bool):
                    merged.constraints[key] = any(values)
                elif isinstance(values[0], (int, float)):
                    merged.constraints[key] = min(v for v in values if v is not None)
        return merged

    @staticmethod
    def _find(permissions: list[ToolPermission], tool_id: str) -> ToolPermission | None:
        return next((p for p in permissions if p.tool_id == tool_id), None)
```

### 4.4 Dynamic Task-Scoped Assignment

For additional security, the Team Orchestrator can request a **task-scoped** tool set that is even narrower than the agent's standing assignment. This supports scenarios where a single agent performs multiple types of tasks but should only have certain tools during certain tasks:

```python
# Team Supervisor requests tools for a specific planning step
effective_tools = await assignment_engine.resolve_effective_tools(
    agent_id="agent-research-01",
    team_id="team-alpha",
    task_context={
        "task_type": "web_research",
        "step": "gather_sources",
        # Only tools tagged with 'search' are needed for this step
        "required_tags": ["search"],
    },
)
```

---

## 5. MCP Server Lifecycle

### 5.1 State Machine

```
                  register()
    ┌──────────┐ ──────────> ┌──────────┐
    │  Unknown  │             │  Active   │◄──── healthy_threshold met
    └──────────┘             └────┬─────┘
                                  │
                    health check fails × unhealthy_threshold
                                  │
                                  ▼
                             ┌──────────┐
                   ┌─────────│ Degraded  │────────┐
                   │         └──────────┘         │
                   │              │                │
          recovers │    continues failing          │ all health checks
          (healthy │         │                     │ fail for > max_downtime
          threshold│         ▼                     │
          met)     │    ┌──────────┐               │
                   │    │Unhealthy │               │
                   │    └────┬─────┘               │
                   │         │                     │
                   ▼         │ manual action        │
              ┌──────────┐   │ or auto-recovery    ▼
              │  Active   │◄─┘              ┌──────────────┐
              └──────────┘                  │Deregistered  │
                                            └──────────────┘
                   │
                   │ deprecate()
                   ▼
              ┌──────────┐
              │Deprecated│ ── tools still work but new assignments blocked
              └────┬─────┘
                   │
                   │ deregister()
                   ▼
              ┌──────────────┐
              │Deregistered  │ ── all tool bindings removed
              └──────────────┘
```

### 5.2 Registration Flow

```python
from fastmcp import FastMCP
from datetime import datetime, timezone

# --- Server-side: Defining an MCP server with FastMCP (p. 162) ---

mcp = FastMCP("web-search-server")

@mcp.tool()
def web_search(query: str, max_results: int = 10) -> list[dict]:
    """Search the web using a text query and return a list of relevant results.

    Each result includes a title, URL, and snippet. Use this when you need
    to find current information not in your training data. Do NOT use this
    for internal documents — use 'doc_search' instead.

    Args:
        query: The search query. Be specific with relevant keywords.
        max_results: Maximum number of results to return (1-50, default 10).

    Returns:
        A list of dicts, each with 'title', 'url', and 'snippet' keys.
    """
    # Implementation details...
    return search_engine.search(query, limit=max_results)

@mcp.tool()
def web_fetch(url: str) -> dict:
    """Fetch the full content of a web page given its URL.

    Returns the page title, text content (HTML stripped), and metadata.
    Use this after 'web_search' to read the full content of a result.
    Will timeout after 30 seconds. Does NOT execute JavaScript.

    Args:
        url: The full URL to fetch (must start with https://).

    Returns:
        A dict with 'title', 'content', 'status_code', and 'content_type' keys.
    """
    return fetcher.get(url)

# --- Platform-side: Registering the MCP server ---

class MCPServerRegistry:
    """Central registry for all MCP servers in the platform."""

    async def register(self, registration: dict) -> str:
        """
        Register a new MCP server.

        Steps:
        1. Validate registration schema
        2. Probe the server for connectivity (STDIO: spawn process; HTTP+SSE: GET /health)
        3. Discover tools via MCP tools/list (p. 161)
        4. Validate tool descriptions meet quality thresholds
        5. Store in registry with status='active'
        6. Start health-check loop
        7. Emit 'server.registered' event to Observability Platform
        """
        # Validate schema
        self._validate_registration(registration)

        # Probe connectivity based on transport type (p. 160)
        transport_type = registration["transport"]["type"]
        if transport_type == "stdio":
            client = await self._connect_stdio(
                command=registration["transport"]["command"],
                args=registration["transport"].get("args", []),
                env=registration["transport"].get("env", {}),
            )
        elif transport_type == "http_sse":
            client = await self._connect_http_sse(
                url=registration["transport"]["url"],
                auth=registration["transport"].get("auth"),
            )

        # Discover tools from server (MCPToolset integration, p. 161)
        discovered_tools = await client.list_tools()
        registration["tools"] = self._merge_tool_metadata(
            declared=registration.get("tools", []),
            discovered=discovered_tools,
        )

        # Validate tool description quality
        for tool in registration["tools"]:
            self._validate_tool_description(tool)

        # Store and start health checks
        server_id = registration["server_id"]
        await self.store.put(server_id, registration)
        await self.health_checker.start(server_id)

        # Emit event
        await self.events.emit("server.registered", {
            "server_id": server_id,
            "name": registration["name"],
            "tool_count": len(registration["tools"]),
            "transport": transport_type,
        })

        return server_id
```

### 5.3 Health Check Protocol

Health checks ensure that registered MCP servers remain available. Since MCP servers should be **stateless** (p. 163), health checks are simple probe requests.

```python
import asyncio
from enum import Enum

class HealthStatus(Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"

class MCPHealthChecker:
    """
    Periodically probes registered MCP servers.
    Emits status changes to the Observability Platform.
    """

    async def check(self, server_id: str) -> HealthStatus:
        server = await self.registry.get(server_id)
        transport = server["transport"]

        try:
            if transport["type"] == "stdio":
                # For STDIO servers: send a lightweight tools/list request
                # and verify the process responds within timeout
                result = await asyncio.wait_for(
                    self._stdio_probe(server),
                    timeout=server["health_check"]["timeout_seconds"],
                )
            elif transport["type"] == "http_sse":
                # For HTTP+SSE servers: send GET to health endpoint
                result = await asyncio.wait_for(
                    self._http_probe(server),
                    timeout=server["health_check"]["timeout_seconds"],
                )

            # Verify tool list has not changed unexpectedly (description drift detection)
            if result.tools != server["tools"]:
                await self.events.emit("server.tool_drift_detected", {
                    "server_id": server_id,
                    "expected_tools": len(server["tools"]),
                    "actual_tools": len(result.tools),
                })
                return HealthStatus.DEGRADED

            return HealthStatus.HEALTHY

        except asyncio.TimeoutError:
            return HealthStatus.UNHEALTHY
        except ConnectionError:
            return HealthStatus.UNHEALTHY

    async def run_loop(self, server_id: str):
        """Continuous health check loop for a single server."""
        server = await self.registry.get(server_id)
        interval = server["health_check"]["interval_seconds"]
        unhealthy_count = 0
        healthy_count = 0

        while True:
            status = await self.check(server_id)

            if status == HealthStatus.HEALTHY:
                healthy_count += 1
                unhealthy_count = 0
                if healthy_count >= server["health_check"]["healthy_threshold"]:
                    await self.registry.set_status(server_id, "active")
            else:
                unhealthy_count += 1
                healthy_count = 0
                if unhealthy_count >= server["health_check"]["unhealthy_threshold"]:
                    await self.registry.set_status(server_id, "unhealthy")
                    await self.events.emit("server.unhealthy", {
                        "server_id": server_id,
                        "consecutive_failures": unhealthy_count,
                    })

            # Emit health metric
            await self.metrics.gauge(
                "mcp.server.health",
                value=1 if status == HealthStatus.HEALTHY else 0,
                tags={"server_id": server_id, "transport": server["transport"]["type"]},
            )

            await asyncio.sleep(interval)
```

### 5.4 Version Management

Tool versions follow semantic versioning. The platform tracks which versions are in use and enforces compatibility:

```python
class ToolVersionManager:
    """
    Manages tool version lifecycle:
    - Major bump: breaking change, requires re-assignment review
    - Minor bump: new functionality, backward compatible
    - Patch bump: bug fix, transparent upgrade
    """

    async def register_version(
        self,
        tool_id: str,
        new_version: str,
        changelog: str,
        breaking_changes: list[str] | None = None,
    ):
        current = await self.registry.get_tool(tool_id)
        current_v = self._parse_version(current["version"])
        new_v = self._parse_version(new_version)

        if new_v.major > current_v.major:
            # Major version: breaking change
            # 1. Do NOT auto-upgrade agents
            # 2. Mark old version as deprecated with migration message
            # 3. Notify all agents/teams currently using this tool
            # 4. Require HITL review for upgrade
            await self._handle_major_upgrade(tool_id, current, new_version, breaking_changes)

        elif new_v.minor > current_v.minor:
            # Minor version: backward compatible
            # 1. Auto-upgrade agents that opted in to auto-update
            # 2. Notify others of available update
            await self._handle_minor_upgrade(tool_id, new_version, changelog)

        else:
            # Patch version: transparent upgrade
            # 1. Auto-upgrade all agents immediately
            # 2. Log the change
            await self._handle_patch_upgrade(tool_id, new_version, changelog)

    async def deprecate_tool(
        self,
        tool_id: str,
        sunset_date: str,
        replacement_tool_id: str | None = None,
        migration_guide: str | None = None,
    ):
        """
        Mark a tool as deprecated. It remains functional until sunset_date,
        but new assignments are blocked and existing agents receive warnings.
        """
        await self.registry.update_tool(tool_id, {
            "deprecated": True,
            "deprecated_message": migration_guide or f"This tool will be removed on {sunset_date}.",
        })

        # Notify all current users
        assignments = await self.registry.get_assignments_for_tool(tool_id)
        for assignment in assignments:
            await self.events.emit("tool.deprecated_warning", {
                "tool_id": tool_id,
                "target": assignment["target"],
                "sunset_date": sunset_date,
                "replacement": replacement_tool_id,
            })
```

---

## 6. Tool Discovery & Catalog API

The Tool Catalog provides a queryable interface so that both human operators and planning agents (p. 101) can discover available tools. Planning agents use the catalog to select which tools are needed for a given task decomposition.

### 6.1 Catalog Data Model

```python
from dataclasses import dataclass

@dataclass
class CatalogEntry:
    tool_id: str
    name: str
    description: str
    server_name: str
    server_status: str  # active | degraded | unhealthy
    version: str
    tags: list[str]
    permissions: dict
    flags: dict
    deprecated: bool
    input_schema: dict
    output_schema: dict | None
    examples: list[dict]
    avg_latency_ms: float      # from Observability Platform
    success_rate: float         # from Observability Platform
    call_count_30d: int         # usage statistics
```

### 6.2 Discovery Queries

```python
class ToolCatalog:
    """
    Queryable catalog of all registered tools.
    Supports filtering by tags, permissions, server status, and free-text search.
    """

    async def search(
        self,
        query: str | None = None,
        tags: list[str] | None = None,
        scope: str | None = None,           # read | write | execute | admin
        data_classification_max: str | None = None,  # public | internal | confidential
        server_status: str | None = None,    # active | degraded
        include_deprecated: bool = False,
        limit: int = 50,
        offset: int = 0,
    ) -> list[CatalogEntry]:
        """
        Search the tool catalog.

        Used by:
        - Human operators configuring agent tool assignments
        - Planning agents selecting tools for task steps (p. 101)
        - Team Orchestrator resolving tool requirements for new teams
        """
        filters = []

        if query:
            # Full-text search over name + description
            filters.append(self._text_filter(query))
        if tags:
            filters.append(self._tags_filter(tags))
        if scope:
            filters.append(self._scope_filter(scope))
        if data_classification_max:
            filters.append(self._classification_filter(data_classification_max))
        if server_status:
            filters.append(self._server_status_filter(server_status))
        if not include_deprecated:
            filters.append(self._not_deprecated_filter())

        return await self.store.query(filters, limit=limit, offset=offset)

    async def get_tools_for_capability(self, capability: str) -> list[CatalogEntry]:
        """
        Given a natural-language capability description (e.g. 'search the web'),
        return ranked tools that match. Uses embedding similarity over tool
        descriptions (p. 162) for semantic matching.
        """
        embedding = await self.embedder.embed(capability)
        return await self.vector_store.similarity_search(
            embedding,
            collection="tool_descriptions",
            top_k=10,
        )

    async def get_tool_detail(self, tool_id: str) -> CatalogEntry:
        """Full detail for a single tool, including usage statistics and examples."""
        tool = await self.store.get(tool_id)
        stats = await self.observability.get_tool_stats(tool_id)
        return CatalogEntry(
            **tool,
            avg_latency_ms=stats.avg_latency_ms,
            success_rate=stats.success_rate,
            call_count_30d=stats.call_count_30d,
        )
```

### 6.3 Auto-Discovery from MCP Servers

When a new MCP server is registered, the platform can automatically discover its tools using the MCP `tools/list` method (MCPToolset integration, p. 161):

```python
async def auto_discover_tools(self, server_id: str) -> list[dict]:
    """
    Connect to an MCP server and discover all tools it exposes.
    This populates the catalog with the server's self-described tools (p. 162).
    """
    server = await self.registry.get(server_id)
    client = await self._connect(server)

    # MCP tools/list returns tool definitions with descriptions and schemas
    raw_tools = await client.list_tools()

    catalog_entries = []
    for raw in raw_tools:
        entry = {
            "tool_id": generate_uuid(),
            "name": raw["name"],
            "description": raw["description"],
            "input_schema": raw["inputSchema"],
            "server_id": server_id,
            "version": server.get("version", "1.0.0"),
            # Permissions and flags must be set by an operator —
            # they cannot be inferred from the MCP server alone
            "permissions": {"scope": "unknown", "resources_accessed": [], "data_classification": "internal"},
            "flags": {"irreversible": False, "side_effects": False},
        }
        catalog_entries.append(entry)

    # Store discovered tools, flagged as requiring permission review
    for entry in catalog_entries:
        await self.store.put(entry["tool_id"], entry)
        await self.events.emit("tool.discovered", {
            "tool_id": entry["tool_id"],
            "name": entry["name"],
            "server_id": server_id,
            "requires_permission_review": True,
        })

    return catalog_entries
```

---

## 7. Security Model

The Tool & MCP Manager implements **Layer 3: Tool Restrictions** of the platform's defense-in-depth security model (p. 288). Security is enforced at three points: before invocation, during execution, and after result.

### 7.1 `before_tool_callback` Validation (p. 295)

Every tool invocation passes through a `before_tool_callback` before reaching the MCP server. This is the primary enforcement point for tool-level security.

```python
from enum import Enum
from typing import Any

class ToolCallDecision(Enum):
    ALLOW = "allow"
    DENY = "deny"
    REQUIRE_CONFIRMATION = "require_confirmation"

class BeforeToolCallback:
    """
    Validates every tool call before execution.
    Implements the before_tool_callback pattern (p. 295).
    """

    def __init__(
        self,
        assignment_engine: AssignmentEngine,
        policy_store: "PolicyStore",
        rate_limiter: "RateLimiter",
    ):
        self.assignment_engine = assignment_engine
        self.policy_store = policy_store
        self.rate_limiter = rate_limiter

    async def evaluate(
        self,
        agent_id: str,
        team_id: str,
        tool_id: str,
        tool_name: str,
        arguments: dict[str, Any],
        task_context: dict,
    ) -> tuple[ToolCallDecision, str]:
        """
        Evaluate a tool call against all security policies.

        Returns:
            (decision, reason) — ALLOW, DENY with reason, or REQUIRE_CONFIRMATION.
        """

        # 1. Verify agent is assigned this tool (Least Privilege, p. 288)
        effective_tools = await self.assignment_engine.resolve_effective_tools(
            agent_id, team_id, task_context,
        )
        tool_ids = {t.tool_id for t in effective_tools.tools}
        if tool_id not in tool_ids:
            return (
                ToolCallDecision.DENY,
                f"Agent {agent_id} is not assigned tool {tool_name}. "
                f"Assigned tools: {tool_ids}",
            )

        # 2. Validate arguments against input schema
        tool_def = await self.registry.get_tool(tool_id)
        schema_errors = validate_json_schema(arguments, tool_def["input_schema"])
        if schema_errors:
            return (
                ToolCallDecision.DENY,
                f"Invalid arguments for {tool_name}: {schema_errors}",
            )

        # 3. Check per-assignment constraints
        tool_perm = next(t for t in effective_tools.tools if t.tool_id == tool_id)
        if constraint_violation := self._check_constraints(tool_perm, arguments):
            return (ToolCallDecision.DENY, constraint_violation)

        # 4. Rate limiting
        if not await self.rate_limiter.allow(agent_id, tool_id):
            return (
                ToolCallDecision.DENY,
                f"Rate limit exceeded for {tool_name} by agent {agent_id}",
            )

        # 5. Check irreversible flag (p. 91)
        if tool_def["flags"].get("irreversible", False):
            if tool_def["flags"].get("requires_hitl", False):
                return (
                    ToolCallDecision.REQUIRE_CONFIRMATION,
                    f"Tool {tool_name} is flagged as irreversible and requires human approval",
                )

        # 6. Evaluate custom policies (p. 292)
        policy_result = await self.policy_store.evaluate(
            agent_id=agent_id,
            action="tool_call",
            resource=tool_name,
            arguments=arguments,
            context=task_context,
        )
        if not policy_result.allowed:
            return (ToolCallDecision.DENY, policy_result.reason)

        return (ToolCallDecision.ALLOW, "All checks passed")

    def _check_constraints(self, tool_perm: ToolPermission, arguments: dict) -> str | None:
        """Check per-assignment parameter constraints."""
        allowed = tool_perm.constraints.get("allowed_parameters", {})
        for param, constraint in allowed.items():
            if param in arguments:
                if "max" in constraint and arguments[param] > constraint["max"]:
                    return f"Parameter '{param}' value {arguments[param]} exceeds maximum {constraint['max']}"
                if "allowed_values" in constraint and arguments[param] not in constraint["allowed_values"]:
                    return f"Parameter '{param}' value '{arguments[param]}' not in allowed values"
        return None
```

### 7.2 Tool Output Sanitization (p. 289)

Tool outputs are **treated as untrusted** (p. 289). The platform must sanitize outputs before they enter the LLM context to prevent indirect prompt injection and data leakage.

```python
class ToolOutputSanitizer:
    """
    Sanitizes tool outputs before they are passed back to the agent.
    Tool outputs are untrusted (p. 289) — they may contain:
    - Indirect prompt injections embedded in web content
    - PII that should not enter the LLM context
    - Excessively large payloads that waste context tokens
    """

    async def sanitize(
        self,
        tool_name: str,
        raw_output: Any,
        tool_def: dict,
        agent_context: dict,
    ) -> dict:
        result = {"tool_name": tool_name, "output": raw_output, "sanitized": False}

        # 1. Size limits — truncate oversized outputs to protect context window
        if isinstance(raw_output, str) and len(raw_output) > self.max_output_chars:
            result["output"] = raw_output[:self.max_output_chars] + "\n[TRUNCATED]"
            result["sanitized"] = True
            result["sanitization_notes"] = ["output_truncated"]

        # 2. PII detection — redact any PII found in output
        pii_matches = await self.pii_detector.scan(str(result["output"]))
        if pii_matches:
            result["output"] = self.pii_detector.redact(str(result["output"]), pii_matches)
            result["sanitized"] = True
            result.setdefault("sanitization_notes", []).append("pii_redacted")

        # 3. Injection pattern detection — flag suspicious content
        if self.injection_detector.detect(str(result["output"])):
            result["sanitized"] = True
            result.setdefault("sanitization_notes", []).append("injection_pattern_detected")
            # Log for security review but do not block — the agent
            # can observe the content but guardrails at other layers
            # will catch any resulting unsafe behavior
            await self.events.emit("security.injection_pattern_in_tool_output", {
                "tool_name": tool_name,
                "agent_id": agent_context.get("agent_id"),
            })

        return result
```

### 7.3 Permission Boundaries Summary

```
┌──────────────────────────────────────────────────────────────┐
│                     Security Enforcement Points              │
│                                                              │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────┐  │
│  │ BEFORE           │  │ DURING            │  │ AFTER       │  │
│  │                  │  │                   │  │             │  │
│  │ Assignment check │  │ Schema validation │  │ Output      │  │
│  │ (Least Privilege)│  │ on server side    │  │ sanitization│  │
│  │                  │  │                   │  │ (untrusted) │  │
│  │ Rate limiting    │  │ Timeout           │  │ PII scan    │  │
│  │                  │  │ enforcement       │  │             │  │
│  │ Policy eval      │  │                   │  │ Size limit  │  │
│  │ (p. 292)         │  │ Sandboxed         │  │             │  │
│  │                  │  │ execution         │  │ Injection   │  │
│  │ HITL gate for    │  │                   │  │ detection   │  │
│  │ irreversible     │  │                   │  │             │  │
│  │ tools (p. 91)    │  │                   │  │             │  │
│  └─────────────────┘  └──────────────────┘  └────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## 8. API Surface

### 8.1 Key Endpoints

All endpoints are exposed via the platform's FastAPI gateway. Authentication uses OAuth2 bearer tokens (p. 248).

#### MCP Server Management

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/mcp/servers` | Register a new MCP server |
| `GET` | `/api/v1/mcp/servers` | List all registered servers (with status filter) |
| `GET` | `/api/v1/mcp/servers/{server_id}` | Get server details including tool list |
| `PATCH` | `/api/v1/mcp/servers/{server_id}` | Update server configuration (e.g., health check interval) |
| `DELETE` | `/api/v1/mcp/servers/{server_id}` | Deregister a server (removes all tool bindings) |
| `POST` | `/api/v1/mcp/servers/{server_id}/discover` | Trigger tool auto-discovery from server |
| `GET` | `/api/v1/mcp/servers/{server_id}/health` | Get current health status and history |

#### Tool Catalog

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/tools` | Search/list the tool catalog (supports query, tags, scope filters) |
| `GET` | `/api/v1/tools/{tool_id}` | Get full tool detail including usage stats |
| `PUT` | `/api/v1/tools/{tool_id}` | Update tool metadata (description, flags, permissions) |
| `POST` | `/api/v1/tools/{tool_id}/deprecate` | Deprecate a tool with sunset date and migration guide |
| `GET` | `/api/v1/tools/{tool_id}/assignments` | List all agents/teams assigned this tool |
| `GET` | `/api/v1/tools/search/semantic` | Semantic search over tool descriptions (for planning agents) |

#### Tool Assignment

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/assignments` | Create a new tool assignment (per-agent or per-team) |
| `GET` | `/api/v1/assignments` | List assignments (filter by agent, team, or tool) |
| `DELETE` | `/api/v1/assignments/{assignment_id}` | Revoke a tool assignment |
| `GET` | `/api/v1/agents/{agent_id}/effective-tools` | Resolve effective tool set for an agent (intersection of all layers) |
| `GET` | `/api/v1/teams/{team_id}/effective-tools` | Resolve effective tool set for a team |

#### Tool Invocation (Internal)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/internal/v1/tools/{tool_id}/invoke` | Invoke a tool (called by agent runtime, not exposed externally) |
| `GET` | `/internal/v1/tools/{tool_id}/cache/{cache_key}` | Check tool-level cache (p. 264) |

### 8.2 FastAPI Implementation Sketch

```python
from fastapi import FastAPI, Depends, HTTPException, Query
from typing import Optional

app = FastAPI(title="Tool & MCP Manager", version="1.0.0")

# --- MCP Server Endpoints ---

@app.post("/api/v1/mcp/servers", status_code=201)
async def register_server(
    registration: MCPServerRegistrationRequest,
    registry: MCPServerRegistry = Depends(get_registry),
):
    """Register a new MCP server and discover its tools."""
    server_id = await registry.register(registration.dict())
    return {"server_id": server_id, "status": "active"}

@app.get("/api/v1/mcp/servers")
async def list_servers(
    status: Optional[str] = Query(None, enum=["active", "degraded", "unhealthy", "deprecated"]),
    transport: Optional[str] = Query(None, enum=["stdio", "http_sse"]),
    registry: MCPServerRegistry = Depends(get_registry),
):
    """List registered MCP servers with optional status and transport filters."""
    return await registry.list(status=status, transport=transport)

@app.get("/api/v1/mcp/servers/{server_id}/health")
async def get_server_health(
    server_id: str,
    health_checker: MCPHealthChecker = Depends(get_health_checker),
):
    """Get current health status and recent health check history."""
    current = await health_checker.check(server_id)
    history = await health_checker.get_history(server_id, limit=20)
    return {"current": current.value, "history": history}

# --- Tool Catalog Endpoints ---

@app.get("/api/v1/tools")
async def search_tools(
    query: Optional[str] = None,
    tags: Optional[list[str]] = Query(None),
    scope: Optional[str] = Query(None, enum=["read", "write", "execute", "admin"]),
    data_classification_max: Optional[str] = Query(None),
    include_deprecated: bool = False,
    limit: int = Query(50, le=200),
    offset: int = 0,
    catalog: ToolCatalog = Depends(get_catalog),
):
    """Search the tool catalog with filtering and pagination."""
    results = await catalog.search(
        query=query,
        tags=tags,
        scope=scope,
        data_classification_max=data_classification_max,
        include_deprecated=include_deprecated,
        limit=limit,
        offset=offset,
    )
    return {"tools": results, "count": len(results), "offset": offset}

# --- Assignment Endpoints ---

@app.post("/api/v1/assignments", status_code=201)
async def create_assignment(
    assignment: ToolAssignmentRequest,
    engine: AssignmentEngine = Depends(get_assignment_engine),
):
    """
    Create a tool assignment for an agent or team.
    Validates against Least Privilege policies (p. 288).
    """
    # Validate that the assignment does not violate platform policies
    violations = await engine.validate_assignment(assignment.dict())
    if violations:
        raise HTTPException(
            status_code=403,
            detail={"message": "Assignment violates Least Privilege policy", "violations": violations},
        )

    assignment_id = await engine.create_assignment(assignment.dict())
    return {"assignment_id": assignment_id}

@app.get("/api/v1/agents/{agent_id}/effective-tools")
async def get_agent_effective_tools(
    agent_id: str,
    team_id: Optional[str] = None,
    engine: AssignmentEngine = Depends(get_assignment_engine),
):
    """
    Resolve the effective tool set for an agent.
    This is the intersection of agent-level, team-level, and platform-level assignments.
    """
    # Look up team_id from agent if not provided
    if team_id is None:
        agent = await get_agent(agent_id)
        team_id = agent.get("team_id")

    effective = await engine.resolve_effective_tools(agent_id, team_id)
    return {
        "agent_id": agent_id,
        "team_id": team_id,
        "tools": [{"tool_id": t.tool_id, "constraints": t.constraints} for t in effective.tools],
        "resolved_at": effective.resolved_at,
    }
```

---

## 9. Failure Modes & Mitigations

### 9.1 Failure Catalog

| # | Failure Mode | Severity | Detection | Mitigation |
|---|-------------|----------|-----------|------------|
| F1 | **MCP server unavailable** | High | Health check loop detects consecutive failures | 1. Mark server as unhealthy. 2. Agents receive error as observation (p. 90) — the LLM can reason about the failure and try alternative tools. 3. If server hosts critical tools, alert on-call via Observability Platform. |
| F2 | **Tool description drift** | Medium | Health check compares discovered tools against registered catalog | 1. Emit `server.tool_drift_detected` event. 2. Block the drifted tool until an operator reviews. 3. Auto-re-discover and present diff for approval. |
| F3 | **Tool invocation timeout** | Medium | Per-call timeout in MCP client | 1. Return timeout error as observation to agent (p. 90). 2. Agent retries with exponential backoff (p. 205). 3. After N retries, escalate or use fallback. |
| F4 | **Schema validation failure** | Low | `before_tool_callback` validates arguments against JSON Schema | 1. Reject the call with descriptive error (p. 90). 2. Error message includes the expected schema so the LLM can self-correct. |
| F5 | **Rate limit exceeded** | Low | Rate limiter in `before_tool_callback` | 1. Reject with `429` equivalent. 2. Agent observes the error and can wait or choose alternative tool. |
| F6 | **Unauthorized tool access** | High | Assignment check in `before_tool_callback` | 1. Deny immediately. 2. Log security event. 3. Alert if pattern suggests prompt injection or confused deputy attack. |
| F7 | **Poisoned tool output** (indirect injection) | Critical | Output sanitization + injection pattern detector | 1. Flag output with warning. 2. Guardrail System (subsystem #4) evaluates the agent's next action for influence from injected content. 3. If detected, halt agent and escalate (HITL, p. 213). |
| F8 | **STDIO server crash** | High | Process exit detection | 1. Attempt auto-restart (up to N times). 2. If restart fails, mark unhealthy. 3. Spawn replacement process if configured. |
| F9 | **Version incompatibility** | Medium | Version check during tool resolution | 1. Block incompatible tools from assignment. 2. Notify operator of required migration. 3. Provide clear deprecation messages. |

### 9.2 Error Handling as Observations (p. 90)

Tool errors are **not exceptions that crash the agent**. They are treated as observations that the LLM can reason about:

```python
async def invoke_tool_safely(
    self,
    agent_id: str,
    tool_id: str,
    arguments: dict,
) -> dict:
    """
    Invoke a tool and handle errors as observations (p. 90).
    The agent receives error information it can use to decide
    what to do next — retry, use an alternative tool, or report.
    """
    try:
        result = await self._invoke(tool_id, arguments)
        return {
            "status": "success",
            "output": result,
        }
    except TimeoutError:
        return {
            "status": "error",
            "error_type": "timeout",
            "message": f"Tool '{tool_id}' did not respond within the timeout. "
                       f"You may retry or use an alternative tool.",
        }
    except ConnectionError:
        return {
            "status": "error",
            "error_type": "server_unavailable",
            "message": f"The MCP server hosting tool '{tool_id}' is currently unavailable. "
                       f"Consider using an alternative tool if available.",
        }
    except SchemaValidationError as e:
        return {
            "status": "error",
            "error_type": "invalid_arguments",
            "message": f"Arguments did not match the expected schema: {e}. "
                       f"Expected schema: {e.schema}",
        }
    except Exception as e:
        # Classify: transient vs logic vs unrecoverable (p. 205)
        error_class = classify_error(e)
        return {
            "status": "error",
            "error_type": error_class.value,
            "message": str(e),
            "retryable": error_class == ErrorClass.TRANSIENT,
        }
```

---

## 10. Instrumentation

The Tool & MCP Manager emits structured telemetry to the Observability Platform (subsystem #5) using OpenTelemetry.

### 10.1 Traces

Every tool invocation produces a span within the parent agent's trace:

```
Trace: agent-task-execution
├── Span: before_tool_callback
│   ├── agent_id: "agent-research-01"
│   ├── tool_id: "web_search"
│   ├── decision: "allow"
│   ├── checks_passed: ["assignment", "rate_limit", "schema", "policy"]
│   └── latency_ms: 3
│
├── Span: tool_invocation
│   ├── tool_id: "web_search"
│   ├── server_id: "web-search-server-001"
│   ├── transport: "http_sse"
│   ├── arguments: { "query": "..." }
│   ├── response_size_bytes: 4200
│   ├── cache_hit: false
│   └── latency_ms: 850
│
└── Span: tool_output_sanitization
    ├── sanitized: true
    ├── sanitization_notes: ["output_truncated"]
    └── latency_ms: 2
```

### 10.2 Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `mcp.tool.invocation.count` | Counter | `tool_id`, `agent_id`, `team_id`, `status` | Total tool invocations |
| `mcp.tool.invocation.latency_ms` | Histogram | `tool_id`, `transport` | End-to-end invocation latency |
| `mcp.tool.invocation.error_rate` | Gauge | `tool_id`, `error_type` | Rolling error rate per tool |
| `mcp.server.health` | Gauge | `server_id`, `transport` | 1 = healthy, 0 = unhealthy |
| `mcp.server.health_check.latency_ms` | Histogram | `server_id` | Health check probe latency |
| `mcp.assignment.resolution.latency_ms` | Histogram | `agent_id` | Time to resolve effective tool set |
| `mcp.callback.before_tool.decision` | Counter | `decision`, `tool_id` | Count of allow/deny/confirm decisions |
| `mcp.callback.before_tool.deny_reason` | Counter | `reason`, `tool_id` | Breakdown of denial reasons |
| `mcp.cache.hit_rate` | Gauge | `tool_id` | Tool-level cache hit rate (p. 264) |
| `mcp.catalog.search.count` | Counter | `query_type` | Catalog search queries |
| `mcp.server.registered` | Gauge | `transport`, `status` | Count of registered servers by status |

### 10.3 Structured Log Events

```python
# All events emitted to the Observability Platform
EVENTS = {
    # Server lifecycle
    "server.registered":          {"server_id", "name", "transport", "tool_count"},
    "server.health_changed":      {"server_id", "old_status", "new_status"},
    "server.unhealthy":           {"server_id", "consecutive_failures"},
    "server.tool_drift_detected": {"server_id", "expected_tools", "actual_tools"},
    "server.deregistered":        {"server_id", "reason"},

    # Tool lifecycle
    "tool.discovered":            {"tool_id", "name", "server_id", "requires_permission_review"},
    "tool.version_updated":       {"tool_id", "old_version", "new_version", "change_type"},
    "tool.deprecated_warning":    {"tool_id", "target", "sunset_date", "replacement"},
    "tool.removed":               {"tool_id", "reason"},

    # Assignment events
    "assignment.created":         {"assignment_id", "target", "tools", "granted_by"},
    "assignment.revoked":         {"assignment_id", "reason"},
    "assignment.policy_violation":{"agent_id", "tool_id", "violation_type"},

    # Security events
    "security.unauthorized_access":          {"agent_id", "tool_id", "reason"},
    "security.rate_limit_exceeded":          {"agent_id", "tool_id"},
    "security.injection_pattern_in_tool_output": {"tool_name", "agent_id"},
    "security.irreversible_tool_blocked":    {"agent_id", "tool_id", "awaiting_approval"},
}
```

### 10.4 Tool-Level Caching (p. 264)

For tools marked as `cacheable`, the platform maintains a cache keyed on the tool name and input arguments. This is a resource-aware optimization (p. 264) that avoids redundant calls to expensive or slow tools.

```python
import hashlib
import json

class ToolCache:
    """
    Tool-level result cache (p. 264).
    Caches tool outputs keyed by (tool_id, arguments_hash).
    """

    def __init__(self, redis_client, default_ttl: int = 300):
        self.redis = redis_client
        self.default_ttl = default_ttl

    def _cache_key(self, tool_id: str, arguments: dict) -> str:
        args_hash = hashlib.sha256(
            json.dumps(arguments, sort_keys=True).encode()
        ).hexdigest()
        return f"tool_cache:{tool_id}:{args_hash}"

    async def get(self, tool_id: str, arguments: dict) -> dict | None:
        key = self._cache_key(tool_id, arguments)
        cached = await self.redis.get(key)
        if cached:
            await self.metrics.increment("mcp.cache.hit", tags={"tool_id": tool_id})
            return json.loads(cached)
        await self.metrics.increment("mcp.cache.miss", tags={"tool_id": tool_id})
        return None

    async def put(
        self,
        tool_id: str,
        arguments: dict,
        result: dict,
        ttl: int | None = None,
    ):
        key = self._cache_key(tool_id, arguments)
        await self.redis.setex(
            key,
            ttl or self.default_ttl,
            json.dumps(result),
        )

    async def invalidate(self, tool_id: str):
        """Invalidate all cached results for a tool (e.g., on version change)."""
        pattern = f"tool_cache:{tool_id}:*"
        keys = await self.redis.keys(pattern)
        if keys:
            await self.redis.delete(*keys)
```

### 10.5 Dashboard Recommendations

The Observability Platform should provide the following views for the Tool & MCP Manager:

1. **Server Health Dashboard** — real-time status of all MCP servers, health check history, uptime percentages.
2. **Tool Usage Dashboard** — invocation counts, latency percentiles (p50, p95, p99), error rates, top tools by volume.
3. **Security Dashboard** — denied access attempts, rate limit hits, injection pattern detections, HITL approval queue.
4. **Catalog Dashboard** — total registered tools, tools pending permission review, deprecated tools approaching sunset dates.
5. **Cache Performance Dashboard** — hit rates per tool, cache size, eviction counts, estimated cost savings from cached calls.

---

*This document specifies subsystem #3 of the AgentForge platform. For the overall system architecture see [00 — System Overview](./00-system-overview.md). For related subsystems see the Agent Builder (01), Team Orchestrator (02), Guardrail System (04), and Observability Platform (05).*
