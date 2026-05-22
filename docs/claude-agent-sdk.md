# Claude Agent SDK (TypeScript)

Kelet observability for [`@anthropic-ai/claude-agent-sdk`](https://docs.anthropic.com/en/api/agent-sdk/overview)
— captures every `query()` / `ClaudeSDKClient` call, preserves extended
thinking (which Claude Code otherwise redacts), and lets Claude Code's
native OTLP pipeline flow straight into your Kelet session.

## Version floor

- **Claude Code CLI**: v2.1.119 or later (`claude --version`).
- **@anthropic-ai/claude-agent-sdk**: `>= 0.1.0` (tested against `0.1.77`).

> **Known quirk (`@anthropic-ai/claude-agent-sdk@0.1.77`)**: this release
> bundles Claude Code `2.0.77`, which is below the 2.1.119 OTLP floor. The
> bundled CLI will not emit native traces. To get traces, install a newer
> CLI globally (`npm install -g @anthropic-ai/claude-code`) and point the
> SDK at it via `options.pathToClaudeCodeExecutable`.

## Install

```bash
bun add kelet @anthropic-ai/claude-agent-sdk
# or
npm install kelet @anthropic-ai/claude-agent-sdk
```

## Configure

```ts
import { configure } from 'kelet';
import * as sdk from '@anthropic-ai/claude-agent-sdk';

configure({ apiKey: process.env.KELET_API_KEY, project: 'production' });

for await (const msg of sdk.query({ prompt: 'Hello, Claude' })) {
  console.log(msg);
}
```

`configure()` auto-detects `@anthropic-ai/claude-agent-sdk` at import time
and installs the reasoning observer on the module. You call `sdk.query()` /
`new sdk.ClaudeSDKClient(...)` directly — no wrapping step required.

If you prefer to install the observer explicitly (e.g. for testability),
use the low-level API:

```ts
import { installReasoningObserver } from 'kelet/claude-agent-sdk';
import * as sdk from '@anthropic-ai/claude-agent-sdk';

installReasoningObserver(sdk);
```

The `wrapClaudeAgentSDK(sdk)` export is kept as a deprecated alias for
`installReasoningObserver(sdk)` so v2 call sites keep compiling.

## Two layers of telemetry

1. **Claude Code's native OTLP** — emits `claude_code.interaction`,
   `claude_code.llm_request`, `claude_code.tool` spans + log events for
   hooks, skills, compaction, permission-mode changes, etc. Enable it by
   setting the OTEL env vars before your process starts:

   ```bash
   export CLAUDE_CODE_ENABLE_TELEMETRY=1
   export OTEL_LOGS_EXPORTER=otlp
   export OTEL_METRICS_EXPORTER=otlp
   export OTEL_TRACES_EXPORTER=otlp
   export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
   export OTEL_EXPORTER_OTLP_ENDPOINT=$KELET_API_URL  # default: https://api.kelet.ai
   export OTEL_EXPORTER_OTLP_HEADERS="authorization=$KELET_API_KEY,x-kelet-project=$KELET_PROJECT"
   ```

   Kelet's SDK does NOT set these — the host app owns its subprocess env.

2. **Kelet reasoning observer** — installed by `configure()`. Captures
   `ThinkingBlock` text from the SDK's in-process message stream (Claude
   Code redacts reasoning in its OTLP) and emits it as a parallel
   `kelet.reasoning` OTLP log record.

3. **`claude_code.sdk_query` wrapper span** — emitted automatically around
   each `query()` invocation under the Kelet scope
   `kelet.claude_agent_sdk`. The span exists purely as a temporal envelope
   so multiple CC subprocesses started inside one logical workflow re-unify
   into a single Kelet session. (The `WRAPPER_BRACKETED_MARKER` symbol is an
   internal sentinel that prevents double-bracketing when `configure()`'s
   namespace patch and the lower-level `installReasoningObserver` both run
   in the same process.)

## Session grouping

Kelet's session id and Claude Code's session id are **two different
abstractions**:

| | Kelet `agenticSession({ sessionId })` | CC `session.id` (span attribute) |
|---|---|---|
| **Purpose** | Observation grouping ("show me everything this user did") | State lifetime ("this conversation has this much context") |
| **Lifetime** | Whatever you wrap | Per `query()` invocation by default |
| **Set by** | `kelet.agenticSession({ sessionId })` | CC subprocess (always fresh UUID per call) |

A single Kelet session **wraps** zero, one, or many CC sessions. Wrapping
multiple `query()` calls in one `agenticSession({ sessionId: "S" })` block
makes `runs.session_id = "S"` for every CC interaction inside the block —
even though CC mints a fresh `session.id` per call:

```ts
import { agenticSession, configure } from 'kelet';
import * as sdk from '@anthropic-ai/claude-agent-sdk';

configure({ apiKey: '...', project: 'prod' });

await agenticSession({ sessionId: 'planner-2026-05-22' }, async () => {
  for await (const m of sdk.query({ prompt: 'Plan the migration' })) {
    /* ... */
  }
  for await (const m of sdk.query({ prompt: 'Now write the scripts' })) {
    /* ... */
  }
});
// Both queries surface as one Kelet session "planner-2026-05-22",
// even though CC emits two distinct session.id UUIDs internally.
```

**Without** `agenticSession`, CC's own per-call `session.id` is the
implicit grouping id (each `query()` becomes its own row in the sessions
table — that's the documented behavior). CC's own state-lifetime semantics
are never overridden; we only attach an observation tag.

### How the propagation works

Multi-`query()` re-unification works because Kelet injects
`OTEL_RESOURCE_ATTRIBUTES` into the `claude` subprocess's env at spawn
time. CC's own SDK then stamps those keys on the OTLP `Resource` of every
span and log it emits. The workflow extractor reads them to override
`runs.session_id` and enrich `runs.metadata`.

The injected keys (when the corresponding ContextVar is set) are
GenAI-semconv-aligned:

| Resource attr | Source |
|---|---|
| `gen_ai.conversation.id` | `agenticSession({ sessionId })` |
| `enduser.id` | `agenticSession({ userId })` |
| `gen_ai.agent.name` | `kelet.agent({ name }, …)` |
| `metadata.<k>` | `agenticSession({ metadata: {…} })` |
| `kelet.project` | `configure({ project })` |

Because resource attrs are set once at subprocess spawn, they survive the
entire CC subprocess lifetime — including hours-long agent loops where
the wrapping `query()` returned to the host long ago. New `query()` calls
inside a different `kelet.agent({ name: "other" }, ...)` block spawn a
fresh subprocess that picks up the updated identity.

## Identity propagation

Kelet's `agenticSession({ userId: '…' })` maps to OpenTelemetry GenAI
semconv's `enduser.id` resource attribute — the human end-user the agent
acts on behalf of. This is **distinct** from CC's own `user.id` span
attribute, which is CC's anonymous installation/device identifier (always
emitted, useful for fleet-level rollups). The two coexist on every CC
trace; `runs.metadata` carries `enduser.id` so per-customer rollups stay
separate from CC fleet metrics. CC's installation `user.id` is never
promoted into `runs.metadata`.

If you set `OTEL_RESOURCE_ATTRIBUTES` yourself on
`options.env`, your value wins — Kelet only appends keys you didn't
already provide.

## Trace-graph linkage

Per CC's monitoring-usage docs, the Agent SDK reads `TRACEPARENT` and
`TRACESTATE` from its own inherited env, so the wrapper span is
automatically the parent of `claude_code.interaction` in the trace graph.
You don't need to inject anything yourself. The resource-attribute layer
covers cross-process *grouping* (which Kelet session do these CC spans
belong to?); the trace-graph parentage covers cross-process *causality*
(what host-side call kicked off this CC interaction?).

## What flows into Kelet

| Source | What it becomes |
|---|---|
| `claude_code.interaction` span | Session envelope |
| `claude_code.llm_request` span | `COMPLETION` run |
| `claude_code.tool` span | `TOOL` sub-run folded into the owning completion |
| `hook_execution_start` + `_complete` log events | `HOOK` run |
| `skill_activated` log event | `SKILL` run |
| `compaction` log event | `COMPACTION` run |
| `permission_mode_changed` log event | `PERMISSION_MODE_CHANGE` run |
| `kelet.reasoning` log event | Thinking text attached to the owning completion |

## Known limitations

**Multi-turn sessions in TS SDK v0.1.77**: the TypeScript SDK does not
expose a persistent `ClaudeSDKClient` — every `sdk.query({prompt})` call
spawns a fresh `claude` subprocess with a brand-new `session.id` and
`trace_id`. With `agenticSession(...)`, all those subprocesses still
re-unify into one Kelet session (Slice C resource-attr propagation
works for both `query()` and the upcoming `ClaudeSDKClient`). Without
`agenticSession`, each subprocess surfaces as its own Kelet session row.

Workarounds until Anthropic ships `ClaudeSDKClient` in the TS SDK:
- Wrap your multi-turn flow in `agenticSession({ sessionId: '…' }, …)`
  — Kelet aggregates the per-call CC subprocesses into one session id
  on the `runs` rows.
- Pass an explicit `sessionId: 'your-uuid'` in `options` to every
  `query()` call — Claude Code v2.1.119+ honours this and reuses the same
  subprocess session across calls (this is CC's state lifetime knob, not
  Kelet's observation knob — they compose).
- Use the Python SDK for any conversation where session-level aggregation
  matters AND you want CC-level state continuity (it exposes
  `ClaudeSDKClient` with `receive_messages` / `receive_response`).

**Mid-stream `kelet.agent({...})` change**: `OTEL_RESOURCE_ATTRIBUTES`
is set once at CC subprocess spawn and is immutable for that
subprocess's life. Switching to a different `kelet.agent({ name: '…' },
…)` block while a previously-spawned CC stream is still iterating does
NOT relabel that subprocess's resource attribute. New `query()` calls
inside the new agent block start fresh subprocesses that pick up the
updated `gen_ai.agent.name`.

**CC subprocesses spawned by Bash/MCP/hooks don't inherit OTEL_* vars**
— per CC monitoring-usage docs, "Claude Code does not pass `OTEL_*`
environment variables to the subprocesses it spawns." Bash commands and
MCP server processes started inside a CC session are NOT instrumented;
`claude_code.tool` spans for them carry only tool-level data, not nested
OTel from the subprocess.

## See also

- The Kelet Claude Agent SDK integration docs, above, describe everything public consumers need. Exact server-side attribute contracts are implementation details of the Kelet ingestion pipeline.
