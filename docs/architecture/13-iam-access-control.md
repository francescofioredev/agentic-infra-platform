# IAM & Access Control -- Subsystem #12

## Contents

| # | Section | Description |
|---|---------|-------------|
| 1 | [Overview & Responsibility](#1-overview--responsibility) | Security backbone mandate: AuthN, AuthZ, multi-tenancy, and audit |
| 2 | [Multi-Tenancy Model](#2-multi-tenancy-model) | Logical, network, and process-level isolation between tenants |
| 3 | [RBAC with OPA](#3-rbac-with-opa) | Declarative OPA policies, role hierarchy, and real-time policy evaluation |
| 4 | [API Key Management](#4-api-key-management) | Key generation, rotation, scoping, and rate-limiting per tenant/agent |
| 5 | [Agent Identity & Authentication](#5-agent-identity--authentication) | mTLS service accounts, identity certificates, and JWT issuance |
| 6 | [Permission Scoping for Tools](#6-permission-scoping-for-tools) | Least-privilege tool access enforcement at the IAM layer |
| 7 | [Token-Based Session Management](#7-token-based-session-management) | JWT lifecycle: issuance, validation, refresh, and revocation |
| 8 | [Audit Trail](#8-audit-trail) | Append-only, tamper-evident log of every access-control decision |
| 9 | [Data Models](#9-data-models) | Core entity schemas: Tenant, Role, Policy, APIKey, ServiceAccount, AuditEvent |
| 10 | [API Endpoints](#10-api-endpoints) | REST endpoints for identity, token, policy, and audit operations |
| 11 | [Metrics & Alerts](#11-metrics--alerts) | Auth failure rates, policy evaluation latency, and key-rotation alerts |
| 12 | [Failure Modes & Mitigations](#12-failure-modes--mitigations) | Token-service outage, OPA latency spikes, and key-rotation failures |
| 13 | [Integration Points](#13-integration-points) | How IAM integrates with every other subsystem |
| 14 | [Security Hardening](#14-security-hardening) | Defense-in-depth controls: rate limiting, TLS, secret rotation, and pen-test requirements |
| 15 | [Testing Strategy](#15-testing-strategy) | Unit, integration, and adversarial test plan for IAM correctness |

---

## 1. Overview & Responsibility

The IAM & Access Control subsystem is the security backbone of the AgentForge platform. It governs authentication, authorization, multi-tenancy isolation, and audit logging for every human user, agent, team, tool invocation, and API call in the system (p. 248, p. 288). Unlike conventional IAM systems that only protect HTTP endpoints, AgentForge IAM must also authenticate and authorize **agent-to-agent communication** (mTLS + OAuth2, p. 248), enforce **least-privilege tool access** for autonomous agents (p. 288), and provide a comprehensive audit trail for compliance reporting (p. 297).

Core responsibilities:

1. **Policy-driven enforcement** -- define and evaluate access control rules through a declarative OPA policy engine, aligned with the CrewAI policy evaluation pattern (p. 292).
2. **Multi-tenancy isolation** -- enforce strict logical, network, and process-level boundaries between tenants so that one tenant's agents, data, and configurations are never accessible to another (p. 288).
3. **Role-based access control (RBAC)** -- define a hierarchical role model (Platform Admin, Tenant Admin, Agent Developer, Operator, Viewer) and enforce it via OPA at every decision point.
4. **API key management** -- generate, rotate, scope, and rate-limit API keys at tenant, team, and agent granularity.
5. **Agent identity & authentication** -- assign cryptographic identities to agents, enforce mTLS for agent-to-agent communication (p. 248), and manage service accounts for non-human principals.
6. **Token-based session management** -- issue, validate, refresh, and revoke JWT tokens for all authenticated sessions.
7. **Permission scoping for tools** -- integrate with the Tool & MCP Manager to enforce least-privilege tool access at the IAM layer (p. 288).
8. **Audit trail** -- log every access control decision, authentication event, and authorization evaluation in an immutable, append-only audit log (p. 297).

```
+---------------------------------------------------------------------------+
|                        IAM & Access Control                                |
|                                                                            |
|  +------------------+  +------------------+  +-----------------------+     |
|  | Tenant Manager   |  | RBAC / OPA       |  | API Key Manager       |     |
|  | (Isolation,      |  | Policy Engine    |  | (Generation, rotation,|     |
|  |  resource scoping,|  | (Role hierarchy, |  |  scoping, rate limits)|     |
|  |  cross-tenant    |  |  Rego policies,  |  |                       |     |
|  |  prevention)     |  |  permission eval)|  |                       |     |
|  +--------+---------+  +--------+---------+  +-----------+-----------+     |
|           |                      |                        |                 |
|  +--------+----------------------+------------------------+-----------+     |
|  |                     Authentication & Session Layer                  |     |
|  |  (JWT issuance, mTLS verification, OAuth2 flows,                   |     |
|  |   agent identity certs, token refresh/revocation)                   |     |
|  +------------------------------------+-------------------------------+     |
|                                       |                                     |
|  +------------------------------------+-------------------------------+     |
|  |                     Audit & Compliance Layer                        |     |
|  |  (Immutable audit log, compliance reporting, metric emission)       |     |
|  +--------------------------------------------------------------------+     |
+---------------------------------------------------------------------------+
```

---

## 2. Multi-Tenancy Model

### 2.1 Isolation Levels

AgentForge provides three layers of tenant isolation, applied cumulatively based on deployment tier:

| Isolation Level | Mechanism | Deployment Tier | Description |
|-----------------|-----------|-----------------|-------------|
| **Logical** | Row-level security + tenant ID filtering | All tiers | Every database query, cache key, and event bus channel is scoped by `tenant_id`. Cross-tenant queries are structurally impossible at the data layer. |
| **Network** | Namespace-level network policies + dedicated virtual networks | Standard, Enterprise | Tenant workloads run in isolated Kubernetes namespaces with network policies that deny cross-namespace traffic by default. |
| **Process** | Dedicated agent runtimes + isolated compute pools | Enterprise | Each tenant's agents execute in dedicated container pools with separate resource quotas, preventing noisy-neighbor effects and side-channel leakage. |

### 2.2 Tenant-Scoped Resources

Every resource in the AgentForge platform carries an immutable `tenant_id` field that is set at creation time and cannot be modified. The following resources are tenant-scoped:

- **Agents** -- agent definitions, system prompts, configurations
- **Teams** -- team topologies, supervisor configurations, routing rules
- **Tools** -- tool registrations, MCP server connections, tool access policies
- **Policies** -- guardrail policies, safety rules, behavioral constraints
- **API keys** -- scoped to a single tenant (and optionally to a team or agent within that tenant)
- **Prompts** -- prompt registry entries, version history
- **Evaluations** -- test suites, benchmark results, quality metrics
- **Audit logs** -- each log entry records the `tenant_id` of the principal that generated it
- **Sessions** -- conversation sessions, JWT tokens, user state

### 2.3 Cross-Tenant Access Prevention

Cross-tenant access is prevented at multiple levels following the defense-in-depth model (p. 286):

```
Request --> API Gateway --> Tenant ID Extraction --> RBAC Check --> Data Layer Filter
                                    |                      |               |
                                    v                      v               v
                              Reject if no           Reject if role   Row-level
                              tenant context         insufficient     security filter
```

**Layer 1 -- API Gateway**: Every inbound request must carry a tenant identifier (extracted from JWT token, API key, or mTLS certificate). Requests without tenant context are rejected with `401 Unauthorized`.

**Layer 2 -- Middleware enforcement**: A `TenantContextMiddleware` injects the authenticated `tenant_id` into the request context. All downstream service calls propagate this context automatically.

**Layer 3 -- Data layer**: All database queries pass through a `TenantScopedRepository` that appends `WHERE tenant_id = :tenant_id` to every query. Direct table access is prohibited; all access goes through the repository layer.

**Layer 4 -- Event bus**: Event bus channels are namespaced by tenant (`events.{tenant_id}.*`). Subscribers can only bind to their own tenant's channels.

```python
class TenantContextMiddleware:
    """
    Extracts and validates tenant context from incoming requests.
    Injects tenant_id into request scope for downstream propagation.
    Rejects requests with missing or invalid tenant context.
    """

    async def __call__(self, request: Request, call_next):
        # Extract tenant_id from authentication credential
        auth_context = await self.authenticate(request)
        if not auth_context or not auth_context.tenant_id:
            raise HTTPException(
                status_code=401,
                detail="Missing tenant context in authentication credential"
            )

        # Validate tenant exists and is active
        tenant = await self.tenant_store.get(auth_context.tenant_id)
        if not tenant or tenant.status != TenantStatus.ACTIVE:
            raise HTTPException(
                status_code=403,
                detail=f"Tenant '{auth_context.tenant_id}' is not active"
            )

        # Inject tenant context for downstream services
        request.state.tenant_id = auth_context.tenant_id
        request.state.auth_context = auth_context

        response = await call_next(request)
        return response
```

### 2.4 TenantManager

```python
class TenantManager:
    """
    Manages tenant lifecycle, provisioning, and isolation enforcement.
    Coordinates with Kubernetes API for network-level isolation in
    Standard/Enterprise tiers.
    """

    def __init__(
        self,
        tenant_store: TenantStore,
        resource_provisioner: ResourceProvisioner,
        event_bus: EventBus,
        audit_logger: AuditLogger
    ):
        self.tenant_store = tenant_store
        self.provisioner = resource_provisioner
        self.event_bus = event_bus
        self.audit_logger = audit_logger

    async def create_tenant(
        self,
        name: str,
        tier: TenantTier,
        admin_email: str,
        config: TenantConfig
    ) -> Tenant:
        """
        Provision a new tenant with all required isolation resources.
        Creates namespace, network policies, database schema, and initial admin user.
        """
        tenant = Tenant(
            tenant_id=generate_uuid(),
            name=name,
            tier=tier,
            status=TenantStatus.PROVISIONING,
            config=config,
            created_at=utcnow(),
            created_by=admin_email
        )
        await self.tenant_store.save(tenant)

        # Provision isolation resources based on tier
        try:
            if tier in (TenantTier.STANDARD, TenantTier.ENTERPRISE):
                await self.provisioner.create_namespace(tenant.tenant_id)
                await self.provisioner.apply_network_policies(tenant.tenant_id)

            if tier == TenantTier.ENTERPRISE:
                await self.provisioner.create_dedicated_compute_pool(tenant.tenant_id)

            # Provision database schema with row-level security
            await self.provisioner.create_tenant_schema(tenant.tenant_id)

            # Create event bus channels
            await self.event_bus.create_tenant_channels(tenant.tenant_id)

            # Create initial admin user
            admin_user = await self._create_tenant_admin(tenant, admin_email)

            tenant.status = TenantStatus.ACTIVE
            await self.tenant_store.save(tenant)

            await self.audit_logger.log(AuditEntry(
                event_type="tenant_created",
                tenant_id=tenant.tenant_id,
                actor_id="system",
                resource_type="tenant",
                resource_id=tenant.tenant_id,
                details={"tier": tier.value, "admin_email": admin_email}
            ))

            return tenant

        except Exception as e:
            tenant.status = TenantStatus.PROVISIONING_FAILED
            await self.tenant_store.save(tenant)
            await self.audit_logger.log(AuditEntry(
                event_type="tenant_provisioning_failed",
                tenant_id=tenant.tenant_id,
                actor_id="system",
                resource_type="tenant",
                resource_id=tenant.tenant_id,
                details={"error": str(e)}
            ))
            raise TenantProvisioningError(f"Failed to provision tenant: {e}")

    async def suspend_tenant(self, tenant_id: str, reason: str, actor_id: str) -> Tenant:
        """
        Suspend a tenant -- all agents are paused, API keys are deactivated,
        but data is preserved. Used for billing, security, or compliance holds.
        """
        tenant = await self.tenant_store.get(tenant_id)
        if not tenant:
            raise TenantNotFoundError(tenant_id)

        tenant.status = TenantStatus.SUSPENDED
        tenant.suspended_at = utcnow()
        tenant.suspension_reason = reason
        await self.tenant_store.save(tenant)

        # Deactivate all API keys for this tenant
        await self.api_key_manager.deactivate_all_for_tenant(tenant_id)

        # Pause all running agents
        await self.agent_runtime.pause_all_for_tenant(tenant_id)

        await self.audit_logger.log(AuditEntry(
            event_type="tenant_suspended",
            tenant_id=tenant_id,
            actor_id=actor_id,
            resource_type="tenant",
            resource_id=tenant_id,
            details={"reason": reason}
        ))

        return tenant

    async def validate_tenant_access(
        self,
        requesting_tenant_id: str,
        target_resource_tenant_id: str
    ) -> bool:
        """
        Validates that a request from one tenant is not attempting to access
        another tenant's resources. This is the core cross-tenant prevention check.
        """
        if requesting_tenant_id != target_resource_tenant_id:
            await self.audit_logger.log(AuditEntry(
                event_type="cross_tenant_access_denied",
                tenant_id=requesting_tenant_id,
                actor_id="system",
                resource_type="unknown",
                resource_id="unknown",
                details={
                    "requesting_tenant": requesting_tenant_id,
                    "target_tenant": target_resource_tenant_id
                },
                severity="critical"
            ))
            return False
        return True
```

---

## 3. RBAC with OPA

### 3.1 Role Definitions

The platform defines five built-in roles arranged in a hierarchical model. Higher roles inherit all permissions of lower roles.

| Role | Scope | Description | Key Permissions |
|------|-------|-------------|-----------------|
| **Platform Admin** | Global | Full platform access across all tenants. Reserved for infrastructure operators. | Tenant CRUD, global policy management, system configuration, user management across tenants |
| **Tenant Admin** | Single tenant | Full control within their tenant boundary. Cannot access other tenants. | User management, team/agent CRUD, policy management, API key management, audit log access |
| **Agent Developer** | Single tenant | Creates and configures agents, teams, tools, and prompts. Cannot manage users or policies. | Agent CRUD, team CRUD, tool registration, prompt management, evaluation execution |
| **Operator** | Single tenant | Monitors and operates running agents. Cannot create or modify agent definitions. | Start/stop agents, view logs, view metrics, view audit trail, escalation handling (p. 213) |
| **Viewer** | Single tenant | Read-only access to dashboards, logs, and agent outputs. | View dashboards, view logs, view agent outputs, view metrics |

### 3.2 Role Hierarchy

```
Platform Admin
      |
      +-- (inherits all Tenant Admin permissions across all tenants)
      |
Tenant Admin
      |
      +-- (inherits all Agent Developer permissions)
      |
Agent Developer
      |
      +-- (inherits all Operator permissions)
      |
Operator
      |
      +-- (inherits all Viewer permissions)
      |
Viewer
```

### 3.3 Permission Model

Permissions are structured as `resource:action` pairs. Each role maps to a set of permissions.

```json
{
  "permissions": {
    "tenant:create": ["platform_admin"],
    "tenant:read": ["platform_admin", "tenant_admin"],
    "tenant:update": ["platform_admin", "tenant_admin"],
    "tenant:delete": ["platform_admin"],
    "tenant:suspend": ["platform_admin"],

    "user:create": ["platform_admin", "tenant_admin"],
    "user:read": ["platform_admin", "tenant_admin", "operator"],
    "user:update": ["platform_admin", "tenant_admin"],
    "user:delete": ["platform_admin", "tenant_admin"],
    "user:assign_role": ["platform_admin", "tenant_admin"],

    "agent:create": ["tenant_admin", "agent_developer"],
    "agent:read": ["tenant_admin", "agent_developer", "operator", "viewer"],
    "agent:update": ["tenant_admin", "agent_developer"],
    "agent:delete": ["tenant_admin", "agent_developer"],
    "agent:start": ["tenant_admin", "agent_developer", "operator"],
    "agent:stop": ["tenant_admin", "agent_developer", "operator"],

    "team:create": ["tenant_admin", "agent_developer"],
    "team:read": ["tenant_admin", "agent_developer", "operator", "viewer"],
    "team:update": ["tenant_admin", "agent_developer"],
    "team:delete": ["tenant_admin", "agent_developer"],

    "tool:register": ["tenant_admin", "agent_developer"],
    "tool:read": ["tenant_admin", "agent_developer", "operator", "viewer"],
    "tool:assign": ["tenant_admin", "agent_developer"],
    "tool:revoke": ["tenant_admin", "agent_developer"],

    "policy:create": ["platform_admin", "tenant_admin"],
    "policy:read": ["platform_admin", "tenant_admin", "agent_developer", "operator"],
    "policy:update": ["platform_admin", "tenant_admin"],
    "policy:delete": ["platform_admin", "tenant_admin"],

    "apikey:create": ["platform_admin", "tenant_admin"],
    "apikey:read": ["platform_admin", "tenant_admin"],
    "apikey:rotate": ["platform_admin", "tenant_admin"],
    "apikey:revoke": ["platform_admin", "tenant_admin"],

    "audit:read": ["platform_admin", "tenant_admin", "operator"],
    "audit:export": ["platform_admin", "tenant_admin"],

    "escalation:handle": ["tenant_admin", "operator"],
    "escalation:read": ["tenant_admin", "operator", "viewer"],

    "metrics:read": ["platform_admin", "tenant_admin", "agent_developer", "operator", "viewer"],
    "dashboard:read": ["platform_admin", "tenant_admin", "agent_developer", "operator", "viewer"]
  }
}
```

### 3.4 OPA Policy Engine Integration

Authorization decisions are delegated to an Open Policy Agent (OPA) instance that evaluates Rego policies. OPA provides a declarative, auditable, and externalized policy evaluation model aligned with the CrewAI policy evaluation pattern (p. 292).

```python
class OPAPolicyEngine:
    """
    Evaluates authorization decisions using Open Policy Agent (OPA).
    All RBAC checks are delegated to OPA for centralized, declarative
    policy management. Policies are written in Rego and hot-reloaded
    when updated (p. 292).
    """

    def __init__(
        self,
        opa_url: str,
        policy_bundle_path: str,
        cache_ttl_seconds: int = 60,
        timeout_ms: int = 50
    ):
        self.opa_url = opa_url
        self.policy_bundle_path = policy_bundle_path
        self.cache = LRUCache(max_size=5000, ttl_seconds=cache_ttl_seconds)
        self.timeout_ms = timeout_ms
        self.metrics = OPAMetrics()

    async def evaluate(
        self,
        principal: Principal,
        action: str,
        resource: Resource,
        context: dict | None = None
    ) -> AuthorizationDecision:
        """
        Evaluate an authorization request against OPA policies.
        Returns ALLOW or DENY with reasoning.

        Args:
            principal: The authenticated user, agent, or service account
            action: The permission being requested (e.g., "agent:create")
            resource: The target resource with tenant_id
            context: Additional context (time of day, IP, risk score, etc.)
        """
        cache_key = f"{principal.id}:{action}:{resource.resource_id}"
        cached = self.cache.get(cache_key)
        if cached:
            self.metrics.cache_hits.inc()
            return cached

        # Build OPA input document
        opa_input = {
            "principal": {
                "id": principal.id,
                "type": principal.type,  # "user" | "agent" | "service_account"
                "tenant_id": principal.tenant_id,
                "roles": principal.roles,
                "attributes": principal.attributes
            },
            "action": action,
            "resource": {
                "type": resource.type,
                "id": resource.resource_id,
                "tenant_id": resource.tenant_id,
                "attributes": resource.attributes
            },
            "context": context or {}
        }

        try:
            start_time = time.monotonic()
            response = await self._query_opa(opa_input)
            latency_ms = (time.monotonic() - start_time) * 1000
            self.metrics.evaluation_latency.observe(latency_ms)

            decision = AuthorizationDecision(
                allowed=response.get("allow", False),
                principal_id=principal.id,
                action=action,
                resource_id=resource.resource_id,
                reason=response.get("reason", ""),
                matched_policy=response.get("matched_policy", ""),
                evaluated_at=utcnow()
            )

            # Cache ALLOW decisions; never cache DENY to avoid stale denials
            if decision.allowed:
                self.cache.set(cache_key, decision)

            self.metrics.decisions_total.labels(
                result="allow" if decision.allowed else "deny",
                action=action
            ).inc()

            return decision

        except asyncio.TimeoutError:
            # Fail-closed on OPA timeout (p. 214) -- deny by default
            self.metrics.timeouts.inc()
            return AuthorizationDecision(
                allowed=False,
                principal_id=principal.id,
                action=action,
                resource_id=resource.resource_id,
                reason="OPA evaluation timed out -- fail-closed default applied",
                matched_policy="system.fail_closed",
                evaluated_at=utcnow()
            )

        except OPAConnectionError as e:
            # OPA unreachable -- fail-closed (p. 214)
            self.metrics.connection_errors.inc()
            return AuthorizationDecision(
                allowed=False,
                principal_id=principal.id,
                action=action,
                resource_id=resource.resource_id,
                reason=f"OPA unreachable -- fail-closed: {e}",
                matched_policy="system.fail_closed",
                evaluated_at=utcnow()
            )

    async def _query_opa(self, input_doc: dict) -> dict:
        """Send authorization query to OPA and return the decision."""
        async with httpx.AsyncClient(timeout=self.timeout_ms / 1000) as client:
            response = await client.post(
                f"{self.opa_url}/v1/data/agentforge/authz",
                json={"input": input_doc}
            )
            response.raise_for_status()
            return response.json().get("result", {})

    async def reload_policies(self) -> None:
        """
        Hot-reload OPA policy bundle from the policy store.
        Triggered on policy update events from the Event Bus.
        """
        async with httpx.AsyncClient() as client:
            response = await client.put(
                f"{self.opa_url}/v1/policies/agentforge",
                data=await self._load_policy_bundle()
            )
            response.raise_for_status()
            self.cache.clear()  # Invalidate cache after policy reload
            self.metrics.policy_reloads.inc()
```

### 3.5 Sample Rego Policy

```rego
package agentforge.authz

import future.keywords.if
import future.keywords.in

default allow := false

# Platform admins can do anything
allow if {
    "platform_admin" in input.principal.roles
}

# Tenant admins can do anything within their own tenant
allow if {
    "tenant_admin" in input.principal.roles
    input.principal.tenant_id == input.resource.tenant_id
}

# Agent developers can manage agents, teams, tools, and prompts
allow if {
    "agent_developer" in input.principal.roles
    input.principal.tenant_id == input.resource.tenant_id
    input.action in developer_actions
}

developer_actions := {
    "agent:create", "agent:read", "agent:update", "agent:delete",
    "agent:start", "agent:stop",
    "team:create", "team:read", "team:update", "team:delete",
    "tool:register", "tool:read", "tool:assign", "tool:revoke",
    "policy:read", "metrics:read", "dashboard:read"
}

# Operators can monitor and operate
allow if {
    "operator" in input.principal.roles
    input.principal.tenant_id == input.resource.tenant_id
    input.action in operator_actions
}

operator_actions := {
    "agent:read", "agent:start", "agent:stop",
    "team:read", "tool:read", "policy:read",
    "audit:read", "escalation:handle", "escalation:read",
    "metrics:read", "dashboard:read", "user:read"
}

# Viewers get read-only access
allow if {
    "viewer" in input.principal.roles
    input.principal.tenant_id == input.resource.tenant_id
    input.action in viewer_actions
}

viewer_actions := {
    "agent:read", "team:read", "tool:read",
    "escalation:read", "metrics:read", "dashboard:read"
}

# Cross-tenant access is always denied (defense-in-depth, p. 286)
deny if {
    input.principal.tenant_id != input.resource.tenant_id
    not "platform_admin" in input.principal.roles
}

# Reason for denial
reason := "Cross-tenant access denied" if {
    deny
}

reason := "Insufficient permissions" if {
    not allow
    not deny
}
```

---

## 4. API Key Management

### 4.1 Key Structure

API keys are hierarchically scoped: every key belongs to exactly one tenant, and may optionally be further restricted to a specific team or agent.

```
API Key Scope Hierarchy:

  Tenant-scoped key --> Access to all resources within the tenant
       |
  Team-scoped key --> Access only to resources owned by the specified team
       |
  Agent-scoped key --> Access only to a specific agent's API surface
```

### 4.2 Key Format

API keys follow the format `af_{scope}_{random}` where:
- `af_` -- prefix identifying AgentForge keys
- `{scope}` -- one of `tnt` (tenant), `tm` (team), or `agt` (agent)
- `{random}` -- 32-byte cryptographically random string, base62-encoded

Example: `af_tnt_7kBx9mQ2pR4vWzY1nH8cD6fJ3gL5sT0a`

Only the SHA-256 hash of the key is stored. The raw key is returned exactly once at creation time and never stored in plaintext.

### 4.3 APIKeyManager

```python
class APIKeyManager:
    """
    Manages API key lifecycle: generation, validation, rotation, scoping,
    and rate limiting. Keys are stored as SHA-256 hashes; raw values are
    returned only at creation time.
    """

    KEY_PREFIX_MAP = {
        APIKeyScope.TENANT: "af_tnt_",
        APIKeyScope.TEAM: "af_tm_",
        APIKeyScope.AGENT: "af_agt_"
    }

    def __init__(
        self,
        key_store: APIKeyStore,
        rate_limiter: RateLimiter,
        audit_logger: AuditLogger,
        encryption_key: bytes
    ):
        self.key_store = key_store
        self.rate_limiter = rate_limiter
        self.audit_logger = audit_logger
        self.encryption_key = encryption_key

    async def create_key(
        self,
        tenant_id: str,
        name: str,
        scope: APIKeyScope,
        scoped_resource_id: str | None,
        permissions: list[str],
        rate_limit: RateLimitConfig,
        expires_at: datetime | None,
        created_by: str
    ) -> APIKeyCreateResult:
        """
        Generate a new API key. Returns the raw key exactly once.
        Only the SHA-256 hash is persisted.
        """
        # Generate cryptographically secure random key
        raw_bytes = secrets.token_bytes(32)
        raw_key = self.KEY_PREFIX_MAP[scope] + base62_encode(raw_bytes)
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()

        api_key = APIKey(
            key_id=generate_uuid(),
            tenant_id=tenant_id,
            name=name,
            key_hash=key_hash,
            key_prefix=raw_key[:12],  # Store prefix for identification
            scope=scope,
            scoped_resource_id=scoped_resource_id,
            permissions=permissions,
            rate_limit=rate_limit,
            status=APIKeyStatus.ACTIVE,
            created_at=utcnow(),
            created_by=created_by,
            expires_at=expires_at,
            last_used_at=None,
            usage_count=0
        )

        await self.key_store.save(api_key)
        await self.rate_limiter.configure_key(api_key.key_id, rate_limit)

        await self.audit_logger.log(AuditEntry(
            event_type="api_key_created",
            tenant_id=tenant_id,
            actor_id=created_by,
            resource_type="api_key",
            resource_id=api_key.key_id,
            details={
                "name": name,
                "scope": scope.value,
                "scoped_resource_id": scoped_resource_id,
                "permissions": permissions,
                "expires_at": expires_at.isoformat() if expires_at else None
            }
        ))

        return APIKeyCreateResult(
            key_id=api_key.key_id,
            raw_key=raw_key,  # Returned once, never stored
            key_prefix=api_key.key_prefix,
            created_at=api_key.created_at,
            expires_at=api_key.expires_at
        )

    async def validate_key(self, raw_key: str) -> APIKeyValidationResult:
        """
        Validate an API key: check hash, expiry, status, and rate limit.
        Returns the associated principal context if valid.
        """
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        api_key = await self.key_store.get_by_hash(key_hash)

        if not api_key:
            return APIKeyValidationResult(valid=False, reason="key_not_found")

        if api_key.status != APIKeyStatus.ACTIVE:
            return APIKeyValidationResult(valid=False, reason=f"key_{api_key.status.value}")

        if api_key.expires_at and api_key.expires_at < utcnow():
            # Auto-expire the key
            api_key.status = APIKeyStatus.EXPIRED
            await self.key_store.save(api_key)
            return APIKeyValidationResult(valid=False, reason="key_expired")

        # Check rate limit
        rate_check = await self.rate_limiter.check(api_key.key_id)
        if not rate_check.allowed:
            return APIKeyValidationResult(
                valid=False,
                reason="rate_limit_exceeded",
                retry_after_seconds=rate_check.retry_after_seconds
            )

        # Update usage tracking
        api_key.last_used_at = utcnow()
        api_key.usage_count += 1
        await self.key_store.save(api_key)
        await self.rate_limiter.record_usage(api_key.key_id)

        return APIKeyValidationResult(
            valid=True,
            key_id=api_key.key_id,
            tenant_id=api_key.tenant_id,
            scope=api_key.scope,
            scoped_resource_id=api_key.scoped_resource_id,
            permissions=api_key.permissions
        )

    async def rotate_key(
        self,
        key_id: str,
        rotated_by: str,
        grace_period_hours: int = 24
    ) -> APIKeyCreateResult:
        """
        Rotate an API key: create a new key and mark the old one for
        deactivation after a grace period. Both keys work during the
        grace period to allow zero-downtime migration.
        """
        old_key = await self.key_store.get(key_id)
        if not old_key:
            raise APIKeyNotFoundError(key_id)

        # Create replacement key with same scope and permissions
        new_key_result = await self.create_key(
            tenant_id=old_key.tenant_id,
            name=f"{old_key.name} (rotated {utcnow().isoformat()})",
            scope=old_key.scope,
            scoped_resource_id=old_key.scoped_resource_id,
            permissions=old_key.permissions,
            rate_limit=old_key.rate_limit,
            expires_at=old_key.expires_at,
            created_by=rotated_by
        )

        # Schedule old key deactivation after grace period
        old_key.status = APIKeyStatus.ROTATING
        old_key.rotation_deadline = utcnow() + timedelta(hours=grace_period_hours)
        old_key.replaced_by = new_key_result.key_id
        await self.key_store.save(old_key)

        await self.audit_logger.log(AuditEntry(
            event_type="api_key_rotated",
            tenant_id=old_key.tenant_id,
            actor_id=rotated_by,
            resource_type="api_key",
            resource_id=key_id,
            details={
                "new_key_id": new_key_result.key_id,
                "grace_period_hours": grace_period_hours,
                "rotation_deadline": old_key.rotation_deadline.isoformat()
            }
        ))

        return new_key_result

    async def deactivate_all_for_tenant(self, tenant_id: str) -> int:
        """Deactivate all API keys for a suspended tenant. Returns count."""
        keys = await self.key_store.list_by_tenant(tenant_id, status=APIKeyStatus.ACTIVE)
        for key in keys:
            key.status = APIKeyStatus.REVOKED
            key.revoked_at = utcnow()
            key.revocation_reason = "tenant_suspended"
            await self.key_store.save(key)
        return len(keys)
```

### 4.4 Rate Limiting per Key

Each API key has an associated rate limit configuration:

```json
{
  "rate_limit": {
    "requests_per_minute": 60,
    "requests_per_hour": 1000,
    "requests_per_day": 10000,
    "burst_size": 10,
    "algorithm": "token_bucket",
    "scope": "per_key",
    "override_by_endpoint": {
      "/api/v1/agents/*/run": {
        "requests_per_minute": 10,
        "requests_per_hour": 100
      }
    }
  }
}
```

Rate limiting uses a token-bucket algorithm backed by Redis for distributed consistency. When a key exceeds its limit, the response includes `Retry-After` and `X-RateLimit-Remaining` headers.

---

## 5. Agent Identity & Authentication

### 5.1 Agent Identity Model

Every agent in the AgentForge platform has a cryptographic identity, enabling secure agent-to-agent communication as specified by the A2A protocol (p. 248). Agents authenticate using a combination of mTLS for transport-layer security and OAuth2 bearer tokens for application-layer authorization.

```
Agent Identity Stack:

  +---------------------------+
  | OAuth2 Bearer Token       |  Application-layer authz (permissions, scopes)
  +---------------------------+
  | mTLS Client Certificate   |  Transport-layer authn (identity verification)
  +---------------------------+
  | Agent Identity Certificate|  X.509 certificate with agent_id in SAN
  +---------------------------+
  | Service Account           |  Non-human principal linked to agent
  +---------------------------+
```

### 5.2 Agent Identity Certificate

Each agent is issued an X.509 certificate by the platform's internal Certificate Authority (CA). The certificate's Subject Alternative Name (SAN) encodes the agent's identity:

```json
{
  "certificate": {
    "subject": "CN=agent-research-alpha-001,O=AgentForge,OU=tenant-acme",
    "san": [
      "URI:spiffe://agentforge/tenant/acme/agent/research-alpha-001",
      "DNS:research-alpha-001.acme.agents.agentforge.internal"
    ],
    "issuer": "CN=AgentForge Internal CA,O=AgentForge",
    "validity": {
      "not_before": "2026-02-01T00:00:00Z",
      "not_after": "2026-05-01T00:00:00Z"
    },
    "key_usage": ["digital_signature", "key_encipherment"],
    "extended_key_usage": ["client_auth"]
  }
}
```

### 5.3 Agent-to-Agent Authentication (p. 248)

A2A communication uses a two-phase authentication model:

**Phase 1 -- mTLS handshake**: Both agents present their identity certificates during the TLS handshake. The receiving agent validates the certificate chain against the platform CA and extracts the sender's `agent_id` and `tenant_id` from the SAN.

**Phase 2 -- OAuth2 token validation**: The sending agent includes an OAuth2 bearer token in the `Authorization` header. This token encodes the agent's permissions, scopes, and tenant context. The receiving agent validates the token against the platform's token introspection endpoint.

```python
class AgentAuthenticator:
    """
    Handles agent-to-agent authentication using mTLS + OAuth2 (p. 248).
    Validates both transport-layer identity (certificate) and
    application-layer authorization (bearer token).
    """

    def __init__(
        self,
        ca_bundle_path: str,
        token_validator: TokenValidator,
        certificate_store: CertificateStore,
        audit_logger: AuditLogger
    ):
        self.ca_bundle = self._load_ca_bundle(ca_bundle_path)
        self.token_validator = token_validator
        self.certificate_store = certificate_store
        self.audit_logger = audit_logger

    async def authenticate_agent(
        self,
        client_certificate: X509Certificate,
        bearer_token: str
    ) -> AgentAuthResult:
        """
        Two-phase agent authentication (p. 248):
        1. Validate mTLS client certificate against platform CA
        2. Validate OAuth2 bearer token for permissions
        """
        # Phase 1: mTLS certificate validation
        cert_result = self._validate_certificate(client_certificate)
        if not cert_result.valid:
            await self.audit_logger.log(AuditEntry(
                event_type="agent_auth_cert_failed",
                tenant_id="unknown",
                actor_id=cert_result.claimed_agent_id or "unknown",
                resource_type="agent",
                resource_id="unknown",
                details={"reason": cert_result.reason},
                severity="high"
            ))
            return AgentAuthResult(authenticated=False, reason=cert_result.reason)

        agent_id = cert_result.agent_id
        tenant_id = cert_result.tenant_id

        # Phase 2: OAuth2 token validation
        token_result = await self.token_validator.validate(bearer_token)
        if not token_result.valid:
            await self.audit_logger.log(AuditEntry(
                event_type="agent_auth_token_failed",
                tenant_id=tenant_id,
                actor_id=agent_id,
                resource_type="agent",
                resource_id=agent_id,
                details={"reason": token_result.reason},
                severity="high"
            ))
            return AgentAuthResult(authenticated=False, reason=token_result.reason)

        # Cross-check: certificate identity must match token identity
        if token_result.subject_id != agent_id:
            await self.audit_logger.log(AuditEntry(
                event_type="agent_auth_identity_mismatch",
                tenant_id=tenant_id,
                actor_id=agent_id,
                resource_type="agent",
                resource_id=agent_id,
                details={
                    "cert_agent_id": agent_id,
                    "token_subject_id": token_result.subject_id
                },
                severity="critical"
            ))
            return AgentAuthResult(
                authenticated=False,
                reason="Certificate identity does not match token subject"
            )

        return AgentAuthResult(
            authenticated=True,
            agent_id=agent_id,
            tenant_id=tenant_id,
            permissions=token_result.permissions,
            scopes=token_result.scopes,
            certificate_expiry=cert_result.not_after,
            token_expiry=token_result.expires_at
        )

    def _validate_certificate(self, cert: X509Certificate) -> CertValidationResult:
        """Validate certificate chain against platform CA."""
        try:
            # Verify signature chain
            self.ca_bundle.verify(cert)

            # Check expiry
            if cert.not_after < utcnow():
                return CertValidationResult(
                    valid=False,
                    reason="Certificate expired",
                    claimed_agent_id=self._extract_agent_id(cert)
                )

            # Check revocation
            agent_id = self._extract_agent_id(cert)
            if self.certificate_store.is_revoked(cert.serial_number):
                return CertValidationResult(
                    valid=False,
                    reason="Certificate revoked",
                    claimed_agent_id=agent_id
                )

            tenant_id = self._extract_tenant_id(cert)

            return CertValidationResult(
                valid=True,
                agent_id=agent_id,
                tenant_id=tenant_id,
                not_after=cert.not_after
            )

        except CertificateVerificationError as e:
            return CertValidationResult(
                valid=False,
                reason=f"Certificate verification failed: {e}",
                claimed_agent_id=None
            )
```

### 5.4 Service Accounts

Service accounts are non-human principals used by agents, background jobs, and platform services. Each service account is:

- Bound to exactly one tenant (or the platform scope for infrastructure services)
- Assigned a role from the RBAC hierarchy
- Issued a long-lived OAuth2 client credential (client_id + client_secret)
- Subject to the same OPA policy evaluation as human users

```json
{
  "service_account": {
    "sa_id": "sa-agent-research-alpha-001",
    "tenant_id": "tenant-acme",
    "name": "Research Agent Alpha Service Account",
    "bound_agent_id": "agent-research-alpha-001",
    "role": "agent_developer",
    "client_id": "sa_7kBx9mQ2pR4vWzY1",
    "permissions": [
      "tool:read",
      "tool:assign",
      "agent:read"
    ],
    "created_at": "2026-01-15T10:00:00Z",
    "last_authenticated": "2026-02-27T14:00:00Z",
    "certificate_serial": "AF-CA-2026-00142"
  }
}
```

---

## 6. Permission Scoping for Tools

### 6.1 Least Privilege Integration (p. 288)

The IAM subsystem integrates directly with the Tool & MCP Manager to enforce the Principle of Least Privilege (p. 288). Every agent's tool access is governed by a `ToolPermissionSet` that defines exactly which tools the agent may use, with what parameters, and at what rate.

```python
class PermissionResolver:
    """
    Resolves the effective permissions for a given principal, taking into
    account role hierarchy, tenant scope, team scope, and tool-level
    restrictions. Integrates with OPA for policy evaluation and with the
    Tool & MCP Manager for tool-level least privilege (p. 288).
    """

    def __init__(
        self,
        opa_engine: OPAPolicyEngine,
        role_store: RoleStore,
        tool_permission_store: ToolPermissionStore,
        audit_logger: AuditLogger
    ):
        self.opa_engine = opa_engine
        self.role_store = role_store
        self.tool_permission_store = tool_permission_store
        self.audit_logger = audit_logger

    async def resolve_tool_permissions(
        self,
        agent_id: str,
        tenant_id: str
    ) -> ToolPermissionSet:
        """
        Resolve the complete set of tools an agent is authorized to use.
        Combines role-based permissions with explicit tool grants and
        tenant-level tool restrictions (p. 288).
        """
        # Get agent's service account and role
        service_account = await self.role_store.get_service_account(agent_id)
        if not service_account:
            return ToolPermissionSet(allowed_tools=[], denied_tools=["*"])

        # Get explicit tool grants for this agent
        explicit_grants = await self.tool_permission_store.get_grants(agent_id)

        # Get tenant-level tool restrictions
        tenant_restrictions = await self.tool_permission_store.get_tenant_restrictions(
            tenant_id
        )

        # Get team-level tool restrictions (if agent belongs to a team)
        team_restrictions = await self.tool_permission_store.get_team_restrictions(
            agent_id
        )

        # Compute effective permission set: intersection of all grant sets
        effective_tools = self._compute_effective_tools(
            explicit_grants=explicit_grants,
            tenant_restrictions=tenant_restrictions,
            team_restrictions=team_restrictions,
            role=service_account.role
        )

        return ToolPermissionSet(
            agent_id=agent_id,
            tenant_id=tenant_id,
            allowed_tools=effective_tools.allowed,
            denied_tools=effective_tools.denied,
            parameter_constraints=effective_tools.parameter_constraints,
            rate_limits=effective_tools.rate_limits,
            resolved_at=utcnow()
        )

    async def check_tool_access(
        self,
        agent_id: str,
        tenant_id: str,
        tool_name: str,
        tool_args: dict
    ) -> ToolAccessDecision:
        """
        Check whether an agent is authorized to invoke a specific tool
        with specific arguments. Called by the before_tool_callback
        in the Guardrail System (p. 295).
        """
        permission_set = await self.resolve_tool_permissions(agent_id, tenant_id)

        # Check if tool is in allowed set
        if tool_name not in permission_set.allowed_tools:
            await self.audit_logger.log(AuditEntry(
                event_type="tool_access_denied",
                tenant_id=tenant_id,
                actor_id=agent_id,
                resource_type="tool",
                resource_id=tool_name,
                details={"reason": "tool_not_in_allowed_set", "tool_args": tool_args},
                severity="high"
            ))
            return ToolAccessDecision(
                allowed=False,
                reason=f"Agent {agent_id} is not authorized to use tool '{tool_name}' (p. 288)"
            )

        # Check parameter constraints
        constraints = permission_set.parameter_constraints.get(tool_name)
        if constraints:
            violation = self._check_parameter_constraints(tool_args, constraints)
            if violation:
                await self.audit_logger.log(AuditEntry(
                    event_type="tool_param_violation",
                    tenant_id=tenant_id,
                    actor_id=agent_id,
                    resource_type="tool",
                    resource_id=tool_name,
                    details={"violation": violation, "tool_args": tool_args},
                    severity="medium"
                ))
                return ToolAccessDecision(
                    allowed=False,
                    reason=f"Parameter constraint violation: {violation}"
                )

        # Check tool-level rate limit
        rate_limit = permission_set.rate_limits.get(tool_name)
        if rate_limit:
            rate_check = await self._check_tool_rate_limit(agent_id, tool_name, rate_limit)
            if not rate_check.allowed:
                return ToolAccessDecision(
                    allowed=False,
                    reason=f"Tool rate limit exceeded: {rate_check.current}/{rate_limit.max_per_window}"
                )

        return ToolAccessDecision(allowed=True, reason="authorized")

    def _compute_effective_tools(
        self,
        explicit_grants: ToolGrants,
        tenant_restrictions: TenantToolRestrictions,
        team_restrictions: TeamToolRestrictions | None,
        role: str
    ) -> EffectiveToolSet:
        """
        Compute effective tool set as the intersection of all permission sources.
        An agent can only use a tool if:
        1. It is explicitly granted to the agent
        2. It is not restricted at the tenant level
        3. It is not restricted at the team level
        """
        allowed = set(explicit_grants.tools)

        # Remove tenant-denied tools
        allowed -= set(tenant_restrictions.denied_tools)

        # Remove team-denied tools
        if team_restrictions:
            allowed -= set(team_restrictions.denied_tools)

        return EffectiveToolSet(
            allowed=list(allowed),
            denied=list(set(tenant_restrictions.denied_tools)),
            parameter_constraints=explicit_grants.parameter_constraints,
            rate_limits=explicit_grants.rate_limits
        )
```

### 6.2 Tool Permission Grant Schema

```json
{
  "tool_permission_grant": {
    "grant_id": "tpg-uuid-001",
    "agent_id": "agent-research-alpha-001",
    "tenant_id": "tenant-acme",
    "tools": [
      {
        "tool_name": "web_search",
        "parameter_constraints": {},
        "rate_limit": {"max_per_minute": 10, "max_per_hour": 100}
      },
      {
        "tool_name": "read_database",
        "parameter_constraints": {
          "table_name": {"allowed_values": ["customers", "products"]},
          "limit": {"max_value": 100}
        },
        "rate_limit": {"max_per_minute": 5, "max_per_hour": 50}
      }
    ],
    "granted_by": "user-admin-001",
    "granted_at": "2026-02-15T10:00:00Z",
    "expires_at": "2026-08-15T10:00:00Z"
  }
}
```

---

## 7. Token-Based Session Management

### 7.1 JWT Token Structure

All authenticated sessions use JWT tokens with the following claims:

```json
{
  "header": {
    "alg": "RS256",
    "typ": "JWT",
    "kid": "agentforge-signing-key-2026-02"
  },
  "payload": {
    "iss": "https://auth.agentforge.io",
    "sub": "user-jane-001",
    "aud": "agentforge-api",
    "iat": 1740652800,
    "exp": 1740656400,
    "nbf": 1740652800,
    "jti": "jwt-uuid-001",
    "tenant_id": "tenant-acme",
    "roles": ["agent_developer"],
    "permissions": ["agent:create", "agent:read", "agent:update", "team:create"],
    "session_id": "sess-uuid-001",
    "principal_type": "user",
    "mfa_verified": true,
    "ip_address": "192.168.1.100"
  }
}
```

### 7.2 Token Lifecycle

```
                    +--------------------+
                    |  Login /           |
                    |  Authenticate      |
                    +--------+-----------+
                             |
                             v
                    +--------------------+
                    |  Issue             | Access token (1hr) + Refresh token (7d)
                    |  Token Pair        |
                    +--------+-----------+
                             |
              +--------------+--------------+
              |                             |
              v                             v
       +----------------+            +----------------+
       |  Access Token  |            |  Refresh       |
       |  (1 hour)      |            |  Token (7d)    |
       +--------+-------+            +--------+-------+
                |                             |
                v                             v
       +----------------+            +----------------+
       |  Expires --->  |----------->|  Refresh       | Issue new access token
       |  Token Refresh |            |  Endpoint      |
       +----------------+            +--------+-------+
                                              |
                                              v
                                     +----------------+
                                     |  Revocation    | Explicit logout or
                                     |  (Blacklist)   | security event
                                     +----------------+
```

### 7.3 Token Refresh

Token refresh follows a rotation model: each refresh produces a new access token **and** a new refresh token. The old refresh token is immediately invalidated to prevent replay attacks. If a previously invalidated refresh token is presented (refresh token reuse), the entire session family is revoked -- this indicates a potential token theft.

### 7.4 Token Revocation

Token revocation is handled via a distributed blacklist backed by Redis. When a token is revoked (explicit logout, password change, security incident), its `jti` claim is added to the blacklist with a TTL equal to the token's remaining lifetime.

```python
class TokenManager:
    """
    Manages JWT token issuance, validation, refresh, and revocation.
    Uses RS256 signing with rotatable key pairs.
    """

    def __init__(
        self,
        signing_key: RSAPrivateKey,
        verification_key: RSAPublicKey,
        key_id: str,
        revocation_store: RevocationStore,
        session_store: SessionStore,
        audit_logger: AuditLogger,
        access_token_ttl: int = 3600,       # 1 hour
        refresh_token_ttl: int = 604800     # 7 days
    ):
        self.signing_key = signing_key
        self.verification_key = verification_key
        self.key_id = key_id
        self.revocation_store = revocation_store
        self.session_store = session_store
        self.audit_logger = audit_logger
        self.access_token_ttl = access_token_ttl
        self.refresh_token_ttl = refresh_token_ttl

    async def issue_token_pair(
        self,
        principal: Principal,
        session_id: str,
        ip_address: str
    ) -> TokenPair:
        """Issue an access token + refresh token pair for an authenticated principal."""
        now = utcnow()

        access_token = self._sign_token({
            "iss": "https://auth.agentforge.io",
            "sub": principal.id,
            "aud": "agentforge-api",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(seconds=self.access_token_ttl)).timestamp()),
            "nbf": int(now.timestamp()),
            "jti": generate_uuid(),
            "tenant_id": principal.tenant_id,
            "roles": principal.roles,
            "permissions": principal.effective_permissions,
            "session_id": session_id,
            "principal_type": principal.type,
            "mfa_verified": principal.mfa_verified,
            "ip_address": ip_address
        })

        refresh_token = self._sign_token({
            "iss": "https://auth.agentforge.io",
            "sub": principal.id,
            "aud": "agentforge-refresh",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(seconds=self.refresh_token_ttl)).timestamp()),
            "jti": generate_uuid(),
            "session_id": session_id,
            "token_type": "refresh"
        })

        # Store session
        await self.session_store.create(Session(
            session_id=session_id,
            principal_id=principal.id,
            tenant_id=principal.tenant_id,
            created_at=now,
            expires_at=now + timedelta(seconds=self.refresh_token_ttl),
            ip_address=ip_address,
            status=SessionStatus.ACTIVE
        ))

        return TokenPair(
            access_token=access_token,
            refresh_token=refresh_token,
            token_type="Bearer",
            expires_in=self.access_token_ttl
        )

    async def validate_token(self, token: str) -> TokenValidationResult:
        """Validate a JWT token: signature, expiry, revocation status."""
        try:
            payload = jwt.decode(
                token,
                self.verification_key,
                algorithms=["RS256"],
                audience="agentforge-api",
                issuer="https://auth.agentforge.io"
            )

            # Check revocation blacklist
            if await self.revocation_store.is_revoked(payload["jti"]):
                return TokenValidationResult(valid=False, reason="token_revoked")

            # Check session status
            session = await self.session_store.get(payload["session_id"])
            if not session or session.status != SessionStatus.ACTIVE:
                return TokenValidationResult(valid=False, reason="session_inactive")

            return TokenValidationResult(
                valid=True,
                subject_id=payload["sub"],
                tenant_id=payload["tenant_id"],
                roles=payload["roles"],
                permissions=payload["permissions"],
                session_id=payload["session_id"],
                expires_at=datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
            )

        except jwt.ExpiredSignatureError:
            return TokenValidationResult(valid=False, reason="token_expired")
        except jwt.InvalidTokenError as e:
            return TokenValidationResult(valid=False, reason=f"invalid_token: {e}")

    async def refresh_token(self, refresh_token_str: str) -> TokenPair:
        """
        Refresh an access token using a refresh token.
        Implements rotation: old refresh token is invalidated,
        new refresh token is issued alongside new access token.
        """
        try:
            payload = jwt.decode(
                refresh_token_str,
                self.verification_key,
                algorithms=["RS256"],
                audience="agentforge-refresh",
                issuer="https://auth.agentforge.io"
            )

            # Check revocation
            if await self.revocation_store.is_revoked(payload["jti"]):
                # Refresh token reuse detected -- revoke entire session
                await self.revoke_session(payload["session_id"], reason="refresh_token_reuse")
                raise SecurityError("Refresh token reuse detected -- session revoked")

            # Invalidate old refresh token
            await self.revocation_store.revoke(
                payload["jti"],
                ttl_seconds=self.refresh_token_ttl
            )

            # Load principal and issue new pair
            session = await self.session_store.get(payload["session_id"])
            principal = await self._load_principal(payload["sub"])

            return await self.issue_token_pair(
                principal=principal,
                session_id=payload["session_id"],
                ip_address=session.ip_address
            )

        except jwt.ExpiredSignatureError:
            raise AuthenticationError("Refresh token expired -- re-authentication required")

    async def revoke_session(self, session_id: str, reason: str) -> None:
        """Revoke all tokens associated with a session."""
        session = await self.session_store.get(session_id)
        if session:
            session.status = SessionStatus.REVOKED
            session.revoked_at = utcnow()
            session.revocation_reason = reason
            await self.session_store.save(session)

            await self.audit_logger.log(AuditEntry(
                event_type="session_revoked",
                tenant_id=session.tenant_id,
                actor_id=session.principal_id,
                resource_type="session",
                resource_id=session_id,
                details={"reason": reason}
            ))
```

---

## 8. Audit Trail

### 8.1 Audit Logging Strategy

Every access control decision, authentication event, and authorization evaluation is recorded in an immutable, append-only audit log (p. 297). The audit log serves three purposes:

1. **Security forensics** -- trace the full history of access decisions for incident investigation.
2. **Compliance reporting** -- generate reports for SOC2, GDPR, and other regulatory frameworks.
3. **Anomaly detection** -- feed access patterns into the Observability Platform for behavioral analysis and alert triggering.

### 8.2 Audit Log Schema

```json
{
  "audit_entry": {
    "entry_id": "audit-uuid-001",
    "timestamp": "2026-02-27T14:32:10.123Z",
    "event_type": "authorization_decision",
    "tenant_id": "tenant-acme",
    "actor": {
      "id": "user-jane-001",
      "type": "user",
      "ip_address": "192.168.1.100",
      "session_id": "sess-uuid-001",
      "roles": ["agent_developer"]
    },
    "action": "agent:create",
    "resource": {
      "type": "agent",
      "id": "agent-new-001",
      "tenant_id": "tenant-acme"
    },
    "decision": {
      "allowed": true,
      "matched_policy": "agentforge.authz.developer_actions",
      "evaluation_latency_ms": 12,
      "cached": false
    },
    "context": {
      "trace_id": "trace-abc-123",
      "span_id": "span-def-456",
      "user_agent": "AgentForge-CLI/2.1.0",
      "request_id": "req-uuid-001"
    },
    "severity": "info",
    "integrity_hash": "sha256:a1b2c3d4..."
  }
}
```

### 8.3 AuditLogger

```python
class AuditLogger:
    """
    Immutable, append-only audit logger for all IAM events (p. 297).
    Writes to a durable store (PostgreSQL with append-only table) and
    emits events to the Event Bus for real-time processing. Supports
    structured queries for compliance reporting.
    """

    def __init__(
        self,
        audit_store: AuditStore,
        event_bus: EventBus,
        retention_days: int = 365,
        batch_size: int = 100,
        flush_interval_seconds: float = 1.0
    ):
        self.audit_store = audit_store
        self.event_bus = event_bus
        self.retention_days = retention_days
        self.buffer: list[AuditEntry] = []
        self.batch_size = batch_size
        self.flush_interval = flush_interval_seconds
        self.metrics = AuditMetrics()

    async def log(self, entry: AuditEntry) -> None:
        """
        Record an audit entry. Entries are buffered and flushed in batches
        for throughput. Critical-severity entries are flushed immediately.
        """
        # Assign entry ID and timestamp if not set
        if not entry.entry_id:
            entry.entry_id = generate_uuid()
        if not entry.timestamp:
            entry.timestamp = utcnow()

        # Compute integrity hash (SHA-256 of entry content)
        entry.integrity_hash = self._compute_hash(entry)

        self.metrics.entries_total.labels(
            event_type=entry.event_type,
            severity=entry.severity
        ).inc()

        # Critical entries flush immediately
        if entry.severity in ("critical", "high"):
            await self._flush_entry(entry)
            await self.event_bus.publish(
                channel=f"audit.{entry.tenant_id}.{entry.event_type}",
                event=entry.to_event()
            )
            return

        # Buffer non-critical entries
        self.buffer.append(entry)
        if len(self.buffer) >= self.batch_size:
            await self._flush_buffer()

    async def _flush_entry(self, entry: AuditEntry) -> None:
        """Write a single entry to the audit store immediately."""
        await self.audit_store.append(entry)

    async def _flush_buffer(self) -> None:
        """Flush the entry buffer to the audit store."""
        if not self.buffer:
            return
        entries = self.buffer[:]
        self.buffer.clear()
        await self.audit_store.append_batch(entries)
        for entry in entries:
            await self.event_bus.publish(
                channel=f"audit.{entry.tenant_id}.{entry.event_type}",
                event=entry.to_event()
            )

    async def query(
        self,
        tenant_id: str,
        filters: AuditQueryFilters
    ) -> AuditQueryResult:
        """
        Query audit log entries with structured filters.
        Used for compliance reporting and security investigations.
        """
        return await self.audit_store.query(
            tenant_id=tenant_id,
            event_types=filters.event_types,
            actor_ids=filters.actor_ids,
            resource_types=filters.resource_types,
            severity=filters.severity,
            start_time=filters.start_time,
            end_time=filters.end_time,
            limit=filters.limit,
            offset=filters.offset
        )

    async def generate_compliance_report(
        self,
        tenant_id: str,
        report_type: str,
        time_range: TimeRange
    ) -> ComplianceReport:
        """
        Generate a compliance report for a specific framework
        (SOC2, GDPR, HIPAA) over a time range.
        """
        entries = await self.audit_store.query(
            tenant_id=tenant_id,
            start_time=time_range.start,
            end_time=time_range.end,
            limit=None  # Fetch all entries in range
        )

        report_generator = ComplianceReportGenerator(report_type)
        return report_generator.generate(
            entries=entries.entries,
            tenant_id=tenant_id,
            time_range=time_range
        )

    def _compute_hash(self, entry: AuditEntry) -> str:
        """Compute SHA-256 integrity hash for tamper detection."""
        content = json.dumps(entry.dict(exclude={"integrity_hash"}), sort_keys=True)
        return hashlib.sha256(content.encode()).hexdigest()
```

### 8.4 Audit Event Types

| Event Type | Trigger | Severity | Retention |
|------------|---------|----------|-----------|
| `authentication_success` | Successful login / API key validation | info | 90 days |
| `authentication_failure` | Failed login / invalid credentials | high | 365 days |
| `authorization_decision` | Every OPA policy evaluation | info | 90 days |
| `authorization_denied` | OPA returned DENY | high | 365 days |
| `cross_tenant_access_denied` | Attempt to access another tenant's resource | critical | 365 days |
| `api_key_created` | New API key generated | info | 365 days |
| `api_key_rotated` | API key rotation initiated | info | 365 days |
| `api_key_revoked` | API key revoked (manual or automatic) | high | 365 days |
| `session_created` | New session started | info | 90 days |
| `session_revoked` | Session terminated (logout or security event) | info | 90 days |
| `tenant_created` | New tenant provisioned | info | Permanent |
| `tenant_suspended` | Tenant suspended | high | Permanent |
| `role_assigned` | Role assigned to a user | high | 365 days |
| `role_revoked` | Role removed from a user | high | 365 days |
| `tool_access_denied` | Agent denied access to a tool (p. 288) | high | 365 days |
| `tool_param_violation` | Agent tool call violated parameter constraints | medium | 180 days |
| `agent_auth_cert_failed` | Agent mTLS certificate validation failed (p. 248) | high | 365 days |
| `agent_auth_token_failed` | Agent OAuth2 token validation failed (p. 248) | high | 365 days |
| `agent_auth_identity_mismatch` | Certificate and token identities do not match | critical | 365 days |
| `policy_updated` | OPA policy bundle updated | info | 365 days |

---

## 9. Data Models

### 9.1 Tenant

```python
from pydantic import BaseModel, Field
from datetime import datetime
from enum import Enum
from typing import Optional


class TenantTier(str, Enum):
    FREE = "free"
    STANDARD = "standard"
    ENTERPRISE = "enterprise"


class TenantStatus(str, Enum):
    PROVISIONING = "provisioning"
    ACTIVE = "active"
    SUSPENDED = "suspended"
    PROVISIONING_FAILED = "provisioning_failed"
    DEACTIVATED = "deactivated"


class TenantConfig(BaseModel):
    max_agents: int = Field(default=10, description="Maximum number of agents")
    max_teams: int = Field(default=5, description="Maximum number of teams")
    max_api_keys: int = Field(default=20, description="Maximum number of API keys")
    max_concurrent_tasks: int = Field(default=50, description="Maximum concurrent agent tasks")
    storage_quota_gb: float = Field(default=10.0, description="Storage quota in GB")
    custom_domain: Optional[str] = Field(default=None, description="Custom domain for tenant")


class Tenant(BaseModel):
    tenant_id: str = Field(description="Unique tenant identifier (UUID)")
    name: str = Field(description="Human-readable tenant name")
    tier: TenantTier = Field(description="Subscription tier")
    status: TenantStatus = Field(description="Current tenant status")
    config: TenantConfig = Field(description="Tenant resource configuration")
    created_at: datetime = Field(description="Tenant creation timestamp")
    created_by: str = Field(description="Email of the user who created the tenant")
    suspended_at: Optional[datetime] = Field(default=None, description="When tenant was suspended")
    suspension_reason: Optional[str] = Field(default=None, description="Reason for suspension")
```

### 9.2 User

```python
class User(BaseModel):
    user_id: str = Field(description="Unique user identifier (UUID)")
    tenant_id: str = Field(description="Tenant this user belongs to")
    email: str = Field(description="User email address")
    name: str = Field(description="Display name")
    roles: list[str] = Field(description="Assigned roles")
    status: str = Field(description="active | suspended | deactivated")
    mfa_enabled: bool = Field(default=False, description="Whether MFA is enabled")
    created_at: datetime = Field(description="Account creation timestamp")
    last_login_at: Optional[datetime] = Field(default=None, description="Last successful login")
    failed_login_count: int = Field(default=0, description="Consecutive failed login attempts")
    locked_until: Optional[datetime] = Field(default=None, description="Account lock expiry")
```

### 9.3 Role

```python
class Role(BaseModel):
    role_id: str = Field(description="Role identifier (e.g., 'tenant_admin')")
    name: str = Field(description="Human-readable role name")
    description: str = Field(description="Role description")
    scope: str = Field(description="'global' or 'tenant'")
    permissions: list[str] = Field(description="List of resource:action permissions")
    inherits_from: Optional[str] = Field(default=None, description="Parent role in hierarchy")
    is_built_in: bool = Field(default=True, description="Whether this is a built-in role")
    created_at: datetime = Field(description="Role creation timestamp")
```

### 9.4 Permission

```python
class Permission(BaseModel):
    permission_id: str = Field(description="Permission identifier (e.g., 'agent:create')")
    resource_type: str = Field(description="Resource type (e.g., 'agent', 'team', 'tool')")
    action: str = Field(description="Action (e.g., 'create', 'read', 'update', 'delete')")
    description: str = Field(description="Human-readable description")
    requires_mfa: bool = Field(default=False, description="Whether MFA is required")
    is_sensitive: bool = Field(default=False, description="Whether this is a sensitive operation")
```

### 9.5 APIKey

```python
class APIKeyScope(str, Enum):
    TENANT = "tenant"
    TEAM = "team"
    AGENT = "agent"


class APIKeyStatus(str, Enum):
    ACTIVE = "active"
    ROTATING = "rotating"
    EXPIRED = "expired"
    REVOKED = "revoked"


class RateLimitConfig(BaseModel):
    requests_per_minute: int = Field(default=60)
    requests_per_hour: int = Field(default=1000)
    requests_per_day: int = Field(default=10000)
    burst_size: int = Field(default=10)


class APIKey(BaseModel):
    key_id: str = Field(description="Unique key identifier (UUID)")
    tenant_id: str = Field(description="Owning tenant")
    name: str = Field(description="Human-readable key name")
    key_hash: str = Field(description="SHA-256 hash of the raw key")
    key_prefix: str = Field(description="First 12 characters for identification")
    scope: APIKeyScope = Field(description="Scope level: tenant, team, or agent")
    scoped_resource_id: Optional[str] = Field(default=None, description="Team or agent ID")
    permissions: list[str] = Field(description="Allowed permissions for this key")
    rate_limit: RateLimitConfig = Field(description="Rate limit configuration")
    status: APIKeyStatus = Field(description="Current key status")
    created_at: datetime = Field(description="Key creation timestamp")
    created_by: str = Field(description="User who created the key")
    expires_at: Optional[datetime] = Field(default=None, description="Key expiry time")
    last_used_at: Optional[datetime] = Field(default=None, description="Last usage timestamp")
    usage_count: int = Field(default=0, description="Total usage count")
    replaced_by: Optional[str] = Field(default=None, description="Replacement key ID during rotation")
    rotation_deadline: Optional[datetime] = Field(default=None, description="Rotation grace period deadline")
    revoked_at: Optional[datetime] = Field(default=None, description="When the key was revoked")
    revocation_reason: Optional[str] = Field(default=None, description="Reason for revocation")
```

### 9.6 AuditEntry

```python
class AuditActor(BaseModel):
    id: str = Field(description="Actor identifier")
    type: str = Field(description="user | agent | service_account | system")
    ip_address: Optional[str] = Field(default=None)
    session_id: Optional[str] = Field(default=None)
    roles: list[str] = Field(default_factory=list)


class AuditResource(BaseModel):
    type: str = Field(description="Resource type")
    id: str = Field(description="Resource identifier")
    tenant_id: str = Field(description="Resource tenant")


class AuditDecision(BaseModel):
    allowed: bool = Field(description="Whether the action was allowed")
    matched_policy: str = Field(default="", description="OPA policy that matched")
    evaluation_latency_ms: float = Field(default=0.0)
    cached: bool = Field(default=False)


class AuditEntry(BaseModel):
    entry_id: str = Field(default_factory=generate_uuid, description="Unique entry ID")
    timestamp: datetime = Field(default_factory=utcnow, description="Event timestamp")
    event_type: str = Field(description="Event type (see Section 8.4)")
    tenant_id: str = Field(description="Tenant context")
    actor: Optional[AuditActor] = Field(default=None, description="Who performed the action")
    actor_id: str = Field(description="Actor identifier (shorthand)")
    action: Optional[str] = Field(default=None, description="Permission checked")
    resource: Optional[AuditResource] = Field(default=None, description="Target resource")
    resource_type: str = Field(default="", description="Resource type (shorthand)")
    resource_id: str = Field(default="", description="Resource ID (shorthand)")
    decision: Optional[AuditDecision] = Field(default=None, description="Authorization decision")
    details: dict = Field(default_factory=dict, description="Additional event-specific details")
    severity: str = Field(default="info", description="info | medium | high | critical")
    context: dict = Field(default_factory=dict, description="Trace context")
    integrity_hash: Optional[str] = Field(default=None, description="SHA-256 integrity hash")
```

### 9.7 Session

```python
class SessionStatus(str, Enum):
    ACTIVE = "active"
    EXPIRED = "expired"
    REVOKED = "revoked"


class Session(BaseModel):
    session_id: str = Field(description="Unique session identifier")
    principal_id: str = Field(description="Authenticated principal")
    tenant_id: str = Field(description="Tenant context")
    created_at: datetime = Field(description="Session start time")
    expires_at: datetime = Field(description="Session expiry time")
    last_activity_at: Optional[datetime] = Field(default=None, description="Last activity timestamp")
    ip_address: str = Field(description="Client IP address")
    user_agent: Optional[str] = Field(default=None, description="Client user agent")
    status: SessionStatus = Field(description="Current session status")
    revoked_at: Optional[datetime] = Field(default=None)
    revocation_reason: Optional[str] = Field(default=None)
```

### 9.8 ServiceAccount

```python
class ServiceAccount(BaseModel):
    sa_id: str = Field(description="Service account identifier")
    tenant_id: str = Field(description="Owning tenant")
    name: str = Field(description="Human-readable name")
    bound_agent_id: Optional[str] = Field(default=None, description="Bound agent ID")
    role: str = Field(description="Assigned role")
    client_id: str = Field(description="OAuth2 client ID")
    permissions: list[str] = Field(description="Explicit permissions")
    created_at: datetime = Field(description="Creation timestamp")
    last_authenticated: Optional[datetime] = Field(default=None, description="Last auth timestamp")
    certificate_serial: Optional[str] = Field(default=None, description="Bound certificate serial")
    status: str = Field(default="active", description="active | suspended | deleted")
```

---

## 10. API Endpoints

### 10.1 Authentication

```
POST   /api/v1/auth/login                    Authenticate with email + password; returns token pair
POST   /api/v1/auth/login/mfa                Complete MFA challenge
POST   /api/v1/auth/token/refresh             Refresh access token using refresh token
POST   /api/v1/auth/logout                    Revoke current session
POST   /api/v1/auth/agent                     Agent authentication (mTLS + OAuth2, p. 248)
```

### 10.2 Tenant Management

```
POST   /api/v1/tenants                        Create a new tenant (Platform Admin only)
GET    /api/v1/tenants                         List tenants (Platform Admin only)
GET    /api/v1/tenants/{tenant_id}             Get tenant details
PUT    /api/v1/tenants/{tenant_id}             Update tenant configuration
POST   /api/v1/tenants/{tenant_id}/suspend     Suspend tenant (Platform Admin only)
POST   /api/v1/tenants/{tenant_id}/reactivate  Reactivate suspended tenant
DELETE /api/v1/tenants/{tenant_id}             Deactivate tenant (soft delete)
```

### 10.3 User Management

```
POST   /api/v1/users                           Create user within current tenant
GET    /api/v1/users                            List users in current tenant
GET    /api/v1/users/{user_id}                  Get user details
PUT    /api/v1/users/{user_id}                  Update user
DELETE /api/v1/users/{user_id}                  Deactivate user (soft delete)
POST   /api/v1/users/{user_id}/roles            Assign role to user
DELETE /api/v1/users/{user_id}/roles/{role_id}  Revoke role from user
POST   /api/v1/users/{user_id}/mfa/enable       Enable MFA for user
```

### 10.4 API Key Management

```
POST   /api/v1/api-keys                        Create a new API key
GET    /api/v1/api-keys                         List API keys for current tenant
GET    /api/v1/api-keys/{key_id}                Get API key metadata (not the raw key)
POST   /api/v1/api-keys/{key_id}/rotate         Rotate API key
DELETE /api/v1/api-keys/{key_id}                Revoke API key
```

### 10.5 Role & Permission Management

```
GET    /api/v1/roles                            List all roles
GET    /api/v1/roles/{role_id}                  Get role with permissions
GET    /api/v1/permissions                      List all permissions
```

### 10.6 Service Accounts

```
POST   /api/v1/service-accounts                 Create service account
GET    /api/v1/service-accounts                  List service accounts
GET    /api/v1/service-accounts/{sa_id}          Get service account details
DELETE /api/v1/service-accounts/{sa_id}          Delete service account
POST   /api/v1/service-accounts/{sa_id}/rotate-secret  Rotate client secret
```

### 10.7 Audit

```
GET    /api/v1/audit/entries                     Query audit log with filters
GET    /api/v1/audit/entries/{entry_id}          Get specific audit entry
POST   /api/v1/audit/reports                     Generate compliance report
GET    /api/v1/audit/reports/{report_id}         Download compliance report
```

### 10.8 Agent Certificates

```
POST   /api/v1/certificates/issue                Issue agent identity certificate
GET    /api/v1/certificates                       List certificates for current tenant
POST   /api/v1/certificates/{serial}/revoke       Revoke a certificate
GET    /api/v1/certificates/{serial}/status        Check certificate revocation status
```

Total: **38 endpoints** across 8 endpoint groups.

---

## 11. Metrics & Alerts

### 11.1 Metrics

The following metrics are emitted to the Observability Platform for dashboard visualization and alerting (p. 305):

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `iam.auth.attempts_total` | Counter | `method`, `result` | Authentication attempts (success/failure) |
| `iam.auth.latency_ms` | Histogram | `method` | Authentication latency |
| `iam.authz.evaluations_total` | Counter | `action`, `result` | OPA authorization evaluations |
| `iam.authz.latency_ms` | Histogram | `action`, `cached` | OPA evaluation latency |
| `iam.authz.cache_hit_rate` | Gauge | -- | OPA result cache hit rate |
| `iam.api_keys.active_count` | Gauge | `tenant_id`, `scope` | Active API keys per tenant |
| `iam.api_keys.usage_total` | Counter | `key_id`, `tenant_id` | API key usage count |
| `iam.api_keys.rate_limit_exceeded_total` | Counter | `key_id`, `tenant_id` | Rate limit violations |
| `iam.sessions.active_count` | Gauge | `tenant_id` | Active sessions per tenant |
| `iam.sessions.revocations_total` | Counter | `tenant_id`, `reason` | Session revocations |
| `iam.audit.entries_total` | Counter | `event_type`, `severity` | Audit log entries by type |
| `iam.audit.flush_latency_ms` | Histogram | -- | Audit log write latency |
| `iam.certificates.active_count` | Gauge | `tenant_id` | Active agent certificates |
| `iam.certificates.expiring_soon` | Gauge | `tenant_id` | Certificates expiring within 7 days |
| `iam.cross_tenant.blocked_total` | Counter | `requesting_tenant` | Cross-tenant access attempts blocked |
| `iam.opa.policy_reload_total` | Counter | -- | OPA policy reloads |

### 11.2 Alert Rules

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| `AuthFailureSpike` | `iam.auth.attempts_total{result="failure"}` > 50 in 5min | High | Slack + PagerDuty. Possible brute-force attack. |
| `OPALatencyDegradation` | `iam.authz.latency_ms` p99 > 100ms for 5min | Medium | Slack. OPA performance issue -- check policy complexity. |
| `OPAUnreachable` | `iam.authz.evaluations_total` drops to 0 for 30s | Critical | PagerDuty. Fail-closed mode active -- all requests denied. |
| `CrossTenantAttempt` | `iam.cross_tenant.blocked_total` > 0 | Critical | PagerDuty + Slack. Potential security breach attempt. |
| `APIKeyRateLimitStorm` | `iam.api_keys.rate_limit_exceeded_total` > 100 in 5min | High | Slack. Possible abuse or misconfigured integration. |
| `CertificateExpiryWarning` | `iam.certificates.expiring_soon` > 0 | Medium | Slack. Agent certificates need rotation. |
| `AuditLogFlushFailure` | `iam.audit.flush_latency_ms` p99 > 5000ms | High | PagerDuty. Audit store write performance degraded. |
| `SessionRevocationSpike` | `iam.sessions.revocations_total{reason="security_event"}` > 10 in 5min | Critical | PagerDuty. Possible active security incident. |
| `RefreshTokenReuse` | `iam.sessions.revocations_total{reason="refresh_token_reuse"}` > 0 | Critical | PagerDuty + Slack. Token compromise detected. |

### 11.3 Dashboard Panels

The Observability Platform (subsystem #5) provides the following pre-built panels for IAM monitoring:

1. **Authentication Overview** -- real-time login success/failure rates, trending over time.
2. **Authorization Decisions** -- OPA evaluation volume, allow/deny ratio, latency percentiles.
3. **API Key Activity** -- usage by key, rate limit violations, key rotation status.
4. **Tenant Health** -- active tenants, resource utilization per tenant, cross-tenant block events.
5. **Session Management** -- active sessions, revocations, session duration distribution.
6. **Certificate Lifecycle** -- active certificates, upcoming expirations, revocation events.
7. **Audit Activity** -- log volume by event type and severity, compliance report status.

---

## 12. Failure Modes & Mitigations

The IAM subsystem follows the Error Triad classification (p. 205) for categorizing failure modes: **Transient** (retry with backoff), **Logic** (re-evaluate configuration), and **Unrecoverable** (escalate to human operator via HITL, p. 213).

### 12.1 Failure Mode Table

| Failure Mode | Impact | Detection | Mitigation | Error Triad Category (p. 205) |
|-------------|--------|-----------|------------|-------------------------------|
| OPA service unavailable | All authorization checks fail | Health check timeout; zero evaluations metric | Fail-closed: deny all requests; alert operations; OPA runs as sidecar with local policy cache | Transient -- retry with backoff |
| OPA policy bundle corrupt | Authorization decisions may be incorrect | Policy reload failure event; validation error | Reject corrupt bundle; keep previous valid bundle; alert operations | Logic -- re-evaluate |
| JWT signing key compromised | All tokens potentially forged | External security alert; anomalous token patterns | Emergency key rotation; revoke all active sessions; re-issue tokens | Unrecoverable -- escalate (p. 213) |
| Audit store write failure | Audit entries lost or delayed | Write error count > 0; flush latency spike | Buffer entries in memory; retry with exponential backoff; fail-closed for critical operations | Transient -- retry |
| Redis (rate limiter) unavailable | Rate limiting not enforced | Connection error; zero rate limit checks | Fall back to in-process rate limiter with conservative defaults; alert operations | Transient -- retry |
| Certificate Authority unavailable | Cannot issue new agent certificates | Certificate issuance failure count > 0 | Existing certificates remain valid; queue issuance requests; alert operations | Transient -- retry |
| Token revocation store unavailable | Revoked tokens may still be accepted | Connection error to Redis | Use short-lived access tokens (1hr max); alert operations; fall back to session store check | Transient -- retry |
| Brute-force authentication attack | Account lockout; resource exhaustion | Auth failure spike alert | Account lockout after 5 failures; progressive delay; IP-based rate limiting; CAPTCHA escalation | Logic -- automatic mitigation |
| Cross-tenant data leak via code defect | Tenant isolation violation | Red-team testing; audit log anomaly detection | Row-level security at database; middleware enforcement; integration tests; bug bounty program | Unrecoverable -- escalate |
| Refresh token theft/reuse | Session compromise | Refresh token reuse detection (rotation model) | Revoke entire session family; notify user; require re-authentication with MFA | Unrecoverable -- escalate |

### 12.2 Fail-Closed Principle

Consistent with the Guardrail System's fail-closed principle (p. 214), the IAM subsystem denies access whenever a security check cannot be completed. This applies to:

- OPA evaluation timeout or error -- DENY
- Token validation failure -- DENY
- Audit log write failure for critical operations -- BLOCK the operation
- Rate limiter unavailable -- apply conservative in-process limit

```
                              +------------------+
                              |  Security Check  |
                              +--------+---------+
                                       |
                          +------------+-------------+
                          |            |             |
                       Success       Failure      Timeout
                          |            |             |
                          v            v             v
                        ALLOW        DENY          DENY
                                   (log +        (log +
                                    alert)        alert)
```

### 12.3 Degradation Modes

| Degradation Level | Trigger | Behavior | Recovery |
|-------------------|---------|----------|----------|
| **Normal** | All systems healthy | Full IAM enforcement with caching | N/A |
| **Degraded -- Cache Only** | OPA unreachable for < 60s | Serve cached authorization decisions; deny uncached requests | Auto-recover when OPA reconnects |
| **Degraded -- Essential Only** | OPA unreachable for > 60s | Allow only Platform Admin and Tenant Admin roles; deny all other access | Manual intervention required |
| **Emergency Lockdown** | Security incident detected | Revoke all sessions; disable all API keys except Platform Admin; require MFA for all access | Manual recovery by Platform Admin |

### 12.4 Fallback Handler

```python
class IAMFallbackChain:
    """
    Fallback handlers for IAM component failures.
    Each fallback degrades gracefully while maintaining security invariants.
    Mirrors the GuardrailFallbackChain pattern from subsystem #4.
    """

    async def authorize_with_fallback(
        self,
        principal: Principal,
        action: str,
        resource: Resource
    ) -> AuthorizationDecision:
        """Try authorization methods in order of capability, falling back on failure."""

        # Level 1: Full OPA evaluation
        try:
            return await self.opa_engine.evaluate(principal, action, resource)
        except OPAError as e:
            await log_fallback("opa_evaluation_failed", error=e)

        # Level 2: Cached decision lookup
        try:
            cached = self.opa_engine.cache.get(
                f"{principal.id}:{action}:{resource.resource_id}"
            )
            if cached:
                return cached
        except Exception as e:
            await log_fallback("cache_lookup_failed", error=e)

        # Level 3: Role-based static check (no OPA, no cache)
        try:
            return self._static_role_check(principal, action)
        except Exception as e:
            await log_fallback("static_role_check_failed", error=e)

        # Level 4: Fail-closed -- deny everything (p. 214)
        await log_fallback("all_authz_methods_failed", severity="critical")
        return AuthorizationDecision(
            allowed=False,
            principal_id=principal.id,
            action=action,
            resource_id=resource.resource_id,
            reason="All authorization methods failed -- fail-closed default applied",
            matched_policy="system.fail_closed",
            evaluated_at=utcnow()
        )

    def _static_role_check(
        self, principal: Principal, action: str
    ) -> AuthorizationDecision:
        """
        Minimal role check without OPA. Only allows Platform Admin
        and Tenant Admin roles during degraded operation.
        """
        allowed_roles = {"platform_admin", "tenant_admin"}
        has_privileged_role = bool(set(principal.roles) & allowed_roles)

        return AuthorizationDecision(
            allowed=has_privileged_role,
            principal_id=principal.id,
            action=action,
            resource_id="degraded_mode",
            reason="Static role check (OPA degraded)" if has_privileged_role
                   else "Denied: only admin roles allowed in degraded mode",
            matched_policy="system.degraded_mode",
            evaluated_at=utcnow()
        )
```

---

## 13. Integration Points

### 13.1 Event Bus Integration

The IAM subsystem publishes the following events to the platform Event Bus for consumption by other subsystems:

| Event | Channel | Consumers | Payload |
|-------|---------|-----------|---------|
| `iam.auth.success` | `events.{tenant_id}.iam.auth` | Observability, Audit | Principal ID, method, timestamp |
| `iam.auth.failure` | `events.{tenant_id}.iam.auth` | Observability, Guardrail | Principal attempt, reason, IP |
| `iam.authz.denied` | `events.{tenant_id}.iam.authz` | Guardrail, Observability | Principal, action, resource, reason |
| `iam.cross_tenant.blocked` | `events.global.iam.security` | Guardrail, Observability | Requesting tenant, target tenant |
| `iam.session.revoked` | `events.{tenant_id}.iam.session` | All subsystems | Session ID, reason |
| `iam.tenant.suspended` | `events.global.iam.tenant` | All subsystems | Tenant ID, reason |
| `iam.api_key.rotated` | `events.{tenant_id}.iam.apikey` | External Integrations Hub | Key ID, new key prefix |
| `iam.certificate.expiring` | `events.{tenant_id}.iam.cert` | Agent Builder, Observability | Certificate serial, agent ID, expiry date |

### 13.2 Observability Platform Integration

IAM metrics (Section 11.1) are exported to the Observability Platform via OpenTelemetry. Additionally, every IAM operation is instrumented with distributed tracing:

- Each authentication/authorization request creates a span linked to the parent trace.
- OPA evaluation latency is recorded as a child span.
- Audit log writes are recorded as spans for latency tracking.

### 13.3 Guardrail System Integration

The IAM subsystem integrates with the Guardrail System (Subsystem #4) at two critical points:

1. **Tool access control**: The `PermissionResolver` (Section 6) feeds tool permission sets into the Guardrail System's `before_tool_callback` (p. 295). When the guardrail agent intercepts a tool call, it queries the IAM subsystem to verify the calling agent has the required tool permission.

2. **HITL escalation authorization**: When the Guardrail System routes an escalation to a human reviewer (p. 213), the IAM subsystem verifies that the reviewer has the `escalation:handle` permission for the relevant tenant.

```
Guardrail System                          IAM & Access Control
      |                                          |
      |  -- before_tool_callback fires -->       |
      |  -- check_tool_access(agent, tool) -->   |
      |                                          |
      |  <-- ToolAccessDecision (ALLOW/DENY) --  |
      |                                          |
      |  -- escalation routed to reviewer -->    |
      |  -- validate_reviewer_permission() -->   |
      |                                          |
      |  <-- AuthorizationDecision -----------   |
```

### 13.4 Agent Builder Integration

The Agent Builder (Subsystem #1) integrates with IAM for:

- **Agent creation**: Creating a new agent automatically provisions a service account and identity certificate.
- **Agent deletion**: Deleting an agent revokes its service account, certificates, and associated API keys.
- **Agent Card publication**: The A2A Agent Card (p. 243) includes the agent's authentication configuration, which IAM generates.

### 13.5 External Integrations Hub

The External Integrations Hub (Subsystem #11) relies on IAM for:

- **API key scoping**: External integrations use team-scoped or agent-scoped API keys with restricted permissions.
- **OAuth2 token exchange**: When integrations need to call external APIs on behalf of a tenant, IAM manages the OAuth2 token exchange flow.

### 13.6 Cost & Resource Manager

The Cost & Resource Manager (Subsystem #9) consumes IAM tenant data for:

- **Quota enforcement**: Tenant-level resource quotas (max agents, max teams, storage) are defined in the IAM tenant configuration and enforced by the Cost & Resource Manager.
- **Usage attribution**: API key usage metrics are attributed to tenants for billing purposes.

---

## 14. Security Hardening

### 14.1 Password Policy

- Minimum 12 characters, requiring at least one uppercase, one lowercase, one digit, and one special character.
- Passwords are hashed with Argon2id (memory-hard) with a minimum of 64 MB memory cost.
- Password history (last 10) is stored to prevent reuse.
- Account lockout after 5 consecutive failed attempts, with progressive backoff (1min, 5min, 15min, 1hr, 24hr).

### 14.2 MFA Enforcement

- MFA is optional per-tenant but required for Platform Admin and Tenant Admin roles.
- Supports TOTP (RFC 6238) and WebAuthn/FIDO2.
- MFA verification status is encoded in the JWT token (`mfa_verified` claim).
- Sensitive operations (role assignment, API key creation, tenant suspension) require MFA re-verification even if the session was established with MFA.

### 14.3 Key Rotation Schedule

| Key Type | Rotation Frequency | Grace Period | Automation |
|----------|-------------------|--------------|------------|
| JWT signing keys | 90 days | 7 days (both old and new keys accepted) | Automated |
| Agent certificates | 90 days | 14 days | Automated with alert |
| API keys | On demand + recommended every 90 days | 24 hours (configurable) | Semi-automated (alert + one-click rotation) |
| OAuth2 client secrets | 180 days | 48 hours | Automated with alert |
| OPA policy bundles | On every policy change | Immediate (hot-reload) | Automated |

### 14.4 Network Security

- All internal communication uses mTLS (p. 248).
- API Gateway terminates external TLS and re-encrypts for internal communication.
- OPA runs as a sidecar container within the IAM service pod, communicating over localhost to avoid network exposure.
- Redis for rate limiting and token revocation uses TLS-encrypted connections with mutual authentication.

---

## 15. Testing Strategy

### 15.1 Unit Tests

- OPA policy evaluation with known-good and known-bad inputs for every role and permission combination.
- Token issuance, validation, refresh, and revocation lifecycle.
- API key generation, rotation, and expiry.
- Tenant isolation in the repository layer (verify cross-tenant queries fail).

### 15.2 Integration Tests

- End-to-end authentication flow: login, receive tokens, make authorized request, refresh token, logout.
- Agent-to-agent authentication with mTLS + OAuth2 (p. 248).
- Cross-tenant access prevention: attempt to access another tenant's resource via API, verify 403.
- Rate limiting: exceed rate limit, verify 429 response with `Retry-After` header.
- API key rotation: verify both old and new keys work during grace period, old key fails after deadline.

### 15.3 Security Tests

- Brute-force lockout: verify account locks after 5 failed attempts.
- Token forgery: verify tokens signed with wrong key are rejected.
- Refresh token reuse: verify entire session is revoked on reuse detection.
- Cross-tenant injection: verify SQL injection and parameter manipulation cannot bypass tenant isolation.
- Certificate spoofing: verify certificates not signed by platform CA are rejected.

### 15.4 Red-Team Scenarios (p. 298)

- Attempt to escalate from Viewer to Tenant Admin using crafted API requests.
- Attempt to access another tenant's data by manipulating `tenant_id` in request payloads.
- Attempt to use an expired or revoked token/API key.
- Attempt to bypass rate limiting through key cycling.
- Attempt to forge agent identity certificates.

---

*References: Guardrails/Safety (p. 285-301), Principle of Least Privilege (p. 288), A2A Security -- mTLS + OAuth2 (p. 248), HITL (p. 207-215), Exception Handling & Error Triad (p. 201-210), CrewAI Policy Evaluation (p. 292), before_tool_callback (p. 295), Evaluation & Monitoring (p. 301-314), Agent Card (p. 243), Defense in Depth (p. 286), Timeout with Safe Default (p. 214).*
