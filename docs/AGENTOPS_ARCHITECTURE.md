# CloudCampBD AgentOps & Governed Coding Architecture (QORVYNA AI by OKGS)

## 1. AgentOps Control Center & Runtime Engine (`src/lib/agentops/*`)
QORVYNA AI's AgentOps layer instruments live AI orchestrations (`src/app/api/ai/route.ts`), governed tool executions (`src/lib/server/tool-gateway.ts`), checkpointed agent builds (`src/lib/server/agent-tasks.ts`), and the Built-in AI Terminal (`src/app/api/terminal/route.ts`) using non-invasive adapters:

- **Execution Lifecycle & Recursive Loop Graph**: Tracks root and child executions (`parentExecutionId`, `depth`, `stepCount`, `recursionDepth`), state transitions (`queued` → `planning` → `running` → `waiting_approval` / `paused` → `completed` / `failed` / `circuit_open` / `cancelled`), model/provider steps, tool-call timelines, fallback routes, and checkpoint recoveries.
- **Intelligent Circuit Breaker (`src/lib/agentops/circuit-breaker.ts`)**: Evaluates live executions against configurable guardrails:
  - Identical / near-identical tool-call repetition (`normalizedArgsSignature` window),
  - Repetitive reasoning signatures,
  - Maximum recursion depth & step ceiling,
  - Maximum retry ceiling & provider failure bursts,
  - Token budget exhaustion (`maxTotalTokens`) and wall-clock timeout (`maxDurationMs`),
  - Cooldown window with explicit operator reset (`reset_circuit_breaker`) that never destroys user conversations or project files.
- **Human-in-the-Loop Governance (`src/lib/agentops/governance.ts`)**:
  - Supports `pause`, `resume`, `cancel`, `approve_tool`, `reject_tool`, `override_decision`, `reset_circuit_breaker`, and `edit_controlled_memory`.
  - Enforces strict authentication, ownership (`execution.userId === actorId` or verified `system.settings` admin RBAC), and CSRF validation (`mutationCsrfResponse`) on `/api/agentops/executions/[id]/control`.
  - Rejects attempts to modify protected namespaces (`system.*`, `prompt.*`, `credentials.*`, `auth.*`, `token.*`, `secret.*`, `rbac.*`, `admin.*`) and writes immutable governance audit records.
- **OpenTelemetry-Compatible Observability (`src/lib/agentops/telemetry.ts`)**:
  - Emits W3C-compatible 128-bit `traceId` and 64-bit `spanId` hierarchies (`agent.execution`, `gen_ai.chat`, `agent.tool.*`, `agent.fallback`) and exports OTLP/JSON (`resourceSpans` / `scopeSpans`) via `GET /api/agentops/telemetry?format=otlp`.
  - Scrubs bearer tokens, API keys (`gsk_`, `sk-`, `ghp_`, `github_pat_`, `AIza`, `AQ.Ab` Gemini auth keys), private keys, and optionally emails before persistence or export.
  - Supports configurable sampling/overhead and bounded retention pruning (`pruneRetention`) wired into `/api/jobs/maintenance`.
- **Agent Evaluation & Token Economics (`src/lib/agentops/evaluation.ts`)**:
  - Computes task success/failure/circuit-trip rates, P50/P95 latency, per-model/provider token usage, tool reliability, and reproducible benchmark runs (`POST /api/agentops/evaluations`).
  - Clearly distinguishes `provider_reported` vs `estimated` vs `unpriced` token costs derived from `MODEL_REGISTRY`, and reports `roiEstimate: null` whenever verified baseline outcome data is absent.

## 2. Built-in AI Terminal (`qsh`) & Coding Workspace (`src/lib/terminal/engine.ts`)
- Accessible at `/terminal` (`src/app/(app)/terminal/page.tsx`) and backed by `/api/terminal`.
- Executes allowlisted workspace commands (`help`, `pwd`, `whoami`, `env`, `ls`, `cat`, `head`, `stat`, `grep`, `validate`, `js`, `run`, `touch`, `write`, `mv`, `rm`) inside an `ExecutionGateway` session (`acquireExecutionEnvironment`) over the caller's owned Firestore `projects` files with compare-and-swap (`expected_revision`) protection.
- Blocks shell-chaining metacharacters (`;`, `&&`, `||`, `|`, `` ` ``, `$()`, `>`, `<`), never spawns host OS binaries, evaluates JavaScript inside a 350ms `node:vm` compartment (`codeGeneration` disabled, no `process`/`require`/`fetch`), requires explicit Human-in-the-Loop confirmation before `rm`, and previews multi-file AI patches as unified diffs before applying.
