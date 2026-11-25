# QORVYNA HTTP API reference

This is a source-aligned reference for the primary application routes, not a complete OpenAPI schema. Check the named route handler and Zod/action definitions for authoritative request fields and response shape before adding clients. All requests are same-origin unless the route is explicitly server-to-server.

## Authentication and request conventions

- Browser: authenticated Firebase session cookie, established by the session route. Mutating browser requests must have an allowed Origin/Fetch-Metadata context.
- Native clients: verified Firebase bearer ID token. Some device-aware routes additionally accept QORVYNA device credentials with explicit scopes. Device credentials are not account/admin tokens.
- Server-to-server automation: `Authorization: Bearer <AUTOMATION_WORKER_SECRET>` only at the worker endpoint.
- JSON errors use stable machine codes; RPC uses `{ success, data, error }`. Do not treat a 2xx result from a client-side optimistic update as durable provider/hardware success.
- Never place API keys, session tokens, OAuth refresh tokens or service credentials in query strings.

## Primary routes

| Method and route | Auth | Purpose / notes |
|---|---|---|
| `POST /api/auth/session` | Firebase ID token in request, CSRF/origin checked | Exchange sign-in identity for httpOnly server session. `DELETE` clears the session; verify live revocation semantics before using as global sign-out. |
| `POST /api/rpc` | User session or permitted scoped device bearer | Typed application action dispatcher. Body: `{ action, ...actionArgs }`; action schemas, ownership checks and role checks are server-side. Success `{success:true,data}`; failure `{success:false,error:{code,message},...}`. See `src/app/api/rpc/route.ts` for complete action registry. |
| `POST /api/ai` | User session / permitted device | Main AI gateway. Body actions include `chat`, `scan`, and `health`; chat may stream SSE when requested. `health` reports configuration only and never calls inference; `unknown` is not evidence of availability. Provider errors are surfaced, not replaced with fabricated completions. |
| `GET /api/models` | User session | Returns account-available provider/model descriptors and the caller's selected preference; keys and internal provider endpoint credentials are not returned. Catalog failures report unavailable rather than invented models. |
| `POST /api/build` | User session or verified Firebase ID token; CSRF checked | Start build/preview/publish tasks from persisted project context; accepts prompt, project/conversation identifiers and explicit actions. Can stream progress using `Accept: text/event-stream`. |
| `GET /api/build?run_id=…` | Owner session | Read an owned persisted build run and deployment status. `GET /api/build?project_id=…` reads latest owned run/deployment overview. |
| `DELETE /api/build?run_id=…` | Owner session; CSRF checked | Request cooperative cancellation for an active owned build. Does not fabricate terminal success. |
| `GET /api/agent/tools` | User session | List registered tool descriptors. |
| `POST /api/agent/tools` | User session; CSRF + tool authorization | Execute one registered tool through the guarded tool gateway; risk/approval/ownership policies apply. This does not provide arbitrary shell execution. |
| `GET /api/projects/{id}/preview/{path?}` | Owner session | Serve actual persisted project files through the authenticated restricted preview route. |
| `GET /api/projects/{id}/zip` | Owner session | Export the owned project as an archive. |
| `GET /api/devices` | User / device with `devices:read` | List devices owned by the authenticated account. |
| `DELETE /api/devices?id={id}` | User / device with `devices:write`; CSRF checked | Revoke an owned paired account-device credential. This is not an ESP32 actuator operation. |
| `POST /api/devices/pairing/create` | User session; CSRF checked | Create a short-lived signed QR challenge; QR does not contain a permanent access credential. |
| `POST /api/devices/pairing/complete` | Authenticated scanner; CSRF checked | Consume a pairing challenge and issue a one-time display of scoped device credential. The owner identity must match the signed challenge. |
| `POST /api/jobs/automations` | Worker bearer secret | Run a bounded due-automation batch. `AUTOMATION_WORKER_SECRET` must be configured; no cookie/CORS browser authorization is used. |
| `POST /api/upload-signature` | User session; CSRF checked | Request a narrowly-scoped, short-lived Cloudinary upload signature. Actual upload goes directly to Cloudinary; server validates purpose/ownership. |
| `GET /api/health` | Public, no secrets in response | Firebase is checked live; AI liveness is unknown without inference. May return 503 if Firebase is unavailable or unconfigured. This is not an authenticated end-to-end workflow. |
| `POST /api/vercel/deploy` | User session; CSRF + explicit approval | Create/monitor a real provider deployment when Vercel credentials exist. Provider readiness is required; production deployment requires explicit approval. |
| GitHub routes under `/api/github/*` | User session/OAuth state; mutation CSRF as applicable | GitHub connect/callback/status/repository/preview/push operations. OAuth tokens stay server-side and encrypted; disconnect deletes the local connection but does not revoke the grant at GitHub. `POST /api/github/preview` compares selected files at a fixed HEAD and returns a ten-minute review token; `POST /api/github/push` requires that token and consumes it once before an expected-HEAD commit. Same-repository PR creation is available via `POST /api/github/pull-requests/preview` and `POST /api/github/pull-requests/create`, with separate approval and a one-use review. Branches can change between preflight and creation; inspect the PR before merging. `GET /api/github/pull-requests` lists PRs and `GET /api/github/pull-requests/inspect` inspects one PR and its file page; both are authenticated, rate-limited and no-store. `POST /api/github/pull-requests/merge/preview` issues a one-use review, and `POST /api/github/pull-requests/merge/execute` performs an explicitly confirmed merge using GitHub's expected head SHA. The base SHA cannot be checked atomically by GitHub. Full pull and formal PR review APIs are not implemented. |
| `POST /api/export/pdf`, certificate PDF routes | User/ownership checks | Generate owned document/certificate export. Verify route-level owner/role checks before extending. |
| `POST /api/account/delete`, `GET /api/account/export` | User session; delete CSRF | Account data deletion/export operations with explicit confirmation/auth boundary. |

## Example: build status

```http
GET /api/build?run_id=RUN_ID
Cookie: __session=...
```

The response reads the persisted run; frontend progress is not a substitute for run state. A run can be pending, running, failed, cancelled or succeeded. Only a succeeded run with verified deployment details should be shown as live.

## Example: automation worker

```http
POST /api/jobs/automations
Authorization: Bearer <AUTOMATION_WORKER_SECRET>
Content-Type: application/json

{"limit":10}
```

Response includes `checked_at`, `attempted`, `succeeded` and per-item outcomes. The worker process must be configured with an explicit HTTPS `QORVYNA_WORKER_TARGET_URL` (the earlier name `MATRIX_WORKER_TARGET_URL` is still read).

## Streaming

`/api/ai` and `/api/build` can emit server-sent events for streaming/progress. Clients should handle network interruption, cancellation, terminal provider/build errors, and reconnect by reading persisted conversation/run state. Do not infer completion solely from a partial stream.

## API gaps

A versioned OpenAPI schema, stable public third-party API guarantees, webhook signing framework, external OAuth deployment integrations beyond implemented providers, and a dedicated ESP32/MQTT command API are not present. New APIs should include authentication, CSRF where cookie-mutating, Zod validation, ownership, rate limits, structured errors, audit logging for privileged changes, and regression tests.

Provider timeouts, shared-key quota behavior, streaming fallback and the limitations of the existing public health probes are described in [docs/AI_PROVIDER_ROUTING.md](docs/AI_PROVIDER_ROUTING.md).
