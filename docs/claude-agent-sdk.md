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
`trace_id`. Kelet aggregates runs per-session in the DB, but each subprocess
ends up in its own session bag, so a multi-turn conversation surfaces as N
separate Kelet sessions instead of one.

Workarounds until Anthropic ships `ClaudeSDKClient` in the TS SDK:
- Pass an explicit `sessionId: 'your-uuid'` in `options` to every
  `query()` call — Claude Code v2.1.119+ honours this and reuses the same
  subprocess session across calls.
- Use the Python SDK for any conversation where session-level aggregation
  matters (it exposes `ClaudeSDKClient` with `receive_messages` /
  `receive_response`).

## See also

- The Kelet Claude Agent SDK integration docs, above, describe everything public consumers need. Exact server-side attribute contracts are implementation details of the Kelet ingestion pipeline.
