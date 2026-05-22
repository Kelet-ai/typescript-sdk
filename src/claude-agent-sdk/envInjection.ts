/**
 * OTLP env-var construction + merge helpers for the Claude Agent SDK.
 *
 * Two layers, asymmetric with the Python SDK on purpose:
 *
 * Layer A — populate `process.env` (`populateProcessEnv`)
 *   Mutates the host process's `process.env`. Used at `configure()` time
 *   to set the OTLP keys *if missing*. NEVER overrides a non-empty
 *   existing value, because `process.env` is process-wide state — silently
 *   replacing an OTEL endpoint set for Sentry/Datadog/etc. would clobber
 *   the host's other pipelines. When we *don't* override, we log a
 *   one-shot WARN naming the conflicting keys so the user can tell CC
 *   telemetry is going somewhere other than Kelet.
 *
 * Layer B — merge into `ClaudeAgentOptions.env` (`mergeIntoOptions`)
 *   Surgical correction path. The JS SDK's subprocess env construction
 *   has a quirk: if the caller passes `options.env`, the spawned `claude`
 *   sees ONLY `options.env` — `process.env` is not merged in. So a user
 *   who passes `options.env` for unrelated reasons would silently lose
 *   Layer A's `process.env` injection. Layer B re-adds the keys into
 *   `options.env` set-if-missing, so user-supplied keys still win
 *   per-call.
 *
 * Resource attributes — long-running CC propagation channel
 * ---------------------------------------------------------
 * A CC subprocess can run for hours. Kelet's observation context
 * (`agenticSession` id, end-user identity, metadata) has to ride along
 * the **entire** subprocess lifetime, not just the host-side wrapper
 * span window. The mechanism is `OTEL_RESOURCE_ATTRIBUTES`: an env var
 * attached at spawn time. Every span/log CC's SDK emits during that
 * subprocess run carries those keys as **resource attributes**. Set
 * once, attached forever, no host-side state.
 *
 * Naming follows GenAI semconv (so generic OTel tooling reads the keys
 * without special-casing):
 *
 * - `gen_ai.conversation.id` — Kelet session id (the workflow finalizer
 *   uses it as a session_id override on `runs.session_id`).
 * - `enduser.id` — the human end-user the agent acts on behalf of. We
 *   do **not** write to `user.id` because CC's own SDK already stamps
 *   that with its anonymous installation/device identifier; overwriting
 *   it would silently collide. The two coexist as separate semconv slots.
 * - `metadata.<k>` — arbitrary key/value pairs from
 *   `agenticSession({ metadata })`.
 *
 * The lone Kelet-prefixed exception is `kelet.project` (no semconv
 * equivalent for tenant project).
 *
 * Layer B is the only injection site for resource attributes — the
 * AsyncLocalStorage-backed Kelet context only exists during the
 * `agenticSession` callback frame, which is exactly when `wrapQuery`
 * runs `mergeIntoOptions`. Layer A (process-wide injection at
 * `configure()` time) does NOT touch `OTEL_RESOURCE_ATTRIBUTES` —
 * there's no Kelet context at startup.
 *
 * @module claude-agent-sdk/envInjection
 */

import type { KeletConfig } from '../config';
import { getMetadata, getSessionId, getUserId } from '../context';

/**
 * Every env key Claude Code reads to enable native telemetry and produce
 * un-redacted log content. Three groups, all required for Kelet's
 * ingestion contract to hold:
 *
 * - **OTLP transport (7 keys)** — turn telemetry on and route all three
 *   signals at the Kelet endpoint with auth.
 * - **Trace-export gate (1 key)** — `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`,
 *   added in CC 2.1.146; without it the CLI emits logs + metrics but
 *   installs no trace exporter at all, silently dropping every span.
 * - **Log-content gates (4 keys)** — `OTEL_LOG_*`. CC redacts these
 *   payloads by default; Kelet's CC ingestion correlates the
 *   `api_response_body` log records to llm_request spans to extract
 *   assistant text and tool calls — leaving redaction on means every
 *   assistant message comes through as `<REDACTED>` and the extracted
 *   session is empty.
 *
 * Order is informative only — callers iterate as a set.
 */
export const CC_OTLP_ENV_KEYS = [
  // OTLP transport
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  // Trace-export gate (CC 2.1.146+)
  'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
  // Log-content gates — Kelet's ingestion needs the un-redacted bodies
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_LOG_TOOL_CONTENT',
  'OTEL_LOG_RAW_API_BODIES',
] as const;

export type CcEnv = Record<(typeof CC_OTLP_ENV_KEYS)[number], string>;

/**
 * Build the full OTLP env dict for the spawned `claude` subprocess.
 *
 * Values are derived from the supplied {@link KeletConfig} so a config
 * change between import and call is reflected.
 */
export function buildCcEnv(config: KeletConfig): CcEnv {
  return {
    // OTLP transport
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: config.apiUrl,
    OTEL_EXPORTER_OTLP_HEADERS: `authorization=${config.apiKey},x-kelet-project=${config.project}`,
    // CC 2.1.146+ gates trace export behind this beta flag — without it
    // the CLI ships logs + metrics but installs no span exporter at all,
    // so every span is silently dropped.
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    // CC's OTLP logs default to redacting these payloads. Kelet's
    // ingestion workflow correlates `api_response_body` records to
    // llm_request spans to extract assistant text + tool calls; leaving
    // redaction on means assistant messages come through as `<REDACTED>`
    // and the extracted session is empty.
    OTEL_LOG_USER_PROMPTS: '1',
    OTEL_LOG_TOOL_DETAILS: '1',
    OTEL_LOG_TOOL_CONTENT: '1',
    OTEL_LOG_RAW_API_BODIES: '1',
  };
}

// One-shot WARN dedupe — keys we've already warned about for this process.
const _warnedKeys = new Set<string>();

/**
 * Reset the warned-keys cache. For testing only.
 * @internal
 */
export function _resetWarnedKeys(): void {
  _warnedKeys.clear();
}

/**
 * Layer A: set Kelet's seven OTLP keys on `process.env` IF missing/empty.
 *
 * Returns `{ injected, deferred }` so callers can decide whether to log:
 * - `injected` — keys we successfully set (process.env had no value).
 * - `deferred` — keys we did NOT set because process.env already had a
 *   different non-empty value (host's existing OTLP backend wins).
 *
 * Empty-string env values are treated as unset (some shell configs export
 * empty defaults and the user expects us to inject anyway).
 *
 * One-shot WARN per process: when `deferred.length > 0`, the caller logs
 * exactly one message naming the deferred keys + the opt-out flag.
 */
export function populateProcessEnv(config: KeletConfig): {
  injected: string[];
  deferred: string[];
} {
  const cc = buildCcEnv(config);
  const injected: string[] = [];
  const deferred: string[] = [];
  for (const key of CC_OTLP_ENV_KEYS) {
    const existing = process.env[key];
    const desired = cc[key];
    if (!existing || existing.length === 0) {
      process.env[key] = desired;
      injected.push(key);
    } else if (existing !== desired) {
      // Host has a different value — defer (do NOT override) so we don't
      // clobber whatever Sentry/Datadog/custom-collector pipeline is wired
      // into the host process. Re-route via `options.env` (Layer B) to
      // force CC routing.
      if (!_warnedKeys.has(key)) {
        deferred.push(key);
      }
    }
    // If existing === desired, no-op silently.
  }
  // Mark deferred so we don't warn again next call.
  for (const key of deferred) {
    _warnedKeys.add(key);
  }
  return { injected, deferred };
}

/**
 * Format the one-shot WARN text shown when Layer A defers to existing env.
 *
 * Mirrors the Python message but inverted: TypeScript does NOT override,
 * Python does. The message difference reflects that.
 */
export function formatDeferredWarning(deferred: string[]): string {
  const keys = [...deferred].sort().join(', ');
  return (
    '[kelet] OTLP env vars are already set in process.env for a different ' +
    `backend (${keys}). Kelet did NOT override them; CC telemetry will route ` +
    'to that backend instead of Kelet. To route CC telemetry to Kelet, unset ' +
    'the conflicting env vars before calling configure(), or pass per-call ' +
    'options.env to ClaudeAgentOptions. Pass injectCcTelemetry: false to ' +
    'suppress this warning.'
  );
}

/**
 * Layer B: merge Kelet's seven OTLP keys into `options.env` set-if-missing.
 *
 * Mutates `options.env` in place. If `options.env` is undefined, builds
 * a fresh dict. User-supplied keys always win — we never override what
 * the caller put in `options.env` themselves, because that's the explicit
 * per-call escape hatch.
 *
 * Also merges Kelet's observation-context **resource attributes** into
 * `OTEL_RESOURCE_ATTRIBUTES` (per-key precedence — caller's keys keep
 * their values, ours fill in for missing entries). Read at call time
 * from the AsyncLocalStorage-backed Kelet context, so this only fires
 * when invoked inside `agenticSession`.
 *
 * Returns the (possibly-newly-created) env dict so the caller can reassign
 * to `options.env` when it was undefined.
 */
export function mergeIntoOptions(
  optionsEnv: Record<string, string> | undefined,
  config: KeletConfig
): Record<string, string> {
  const cc = buildCcEnv(config);
  const merged: Record<string, string> = { ...(optionsEnv ?? {}) };
  for (const key of CC_OTLP_ENV_KEYS) {
    if (!merged[key]) {
      merged[key] = cc[key];
    }
  }

  // Resource attributes — read Kelet ALS context synchronously and
  // compose. Per-key merge: caller's value (in optionsEnv) wins, but
  // missing keys still get our entries appended.
  const keletPairs = buildKeletResourceAttrs({ project: config.project });
  if (Object.keys(keletPairs).length > 0) {
    merged[OTEL_RESOURCE_ATTRIBUTES_KEY] = mergeResourceAttributes({
      callerValue: merged[OTEL_RESOURCE_ATTRIBUTES_KEY],
      keletPairs,
    });
  }

  return merged;
}

// ---------------------------------------------------------------------------
// OTEL_RESOURCE_ATTRIBUTES — encode/parse helpers
// ---------------------------------------------------------------------------
//
// Format (per CC monitoring-usage docs and the OTel spec):
//     key1=value1,key2=value2,...
//
// Allowed unencoded values: US-ASCII excluding control characters,
// whitespace, double-quotes, commas, semicolons, and backslashes.
// Anything outside that set must be percent-encoded per RFC 3986
// (`encodeURIComponent`). Keys are constants so they never need encoding;
// values are user-supplied so they always do.
// ---------------------------------------------------------------------------

/** OTLP resource-attribute env var name (fixed by the OTel spec). */
export const OTEL_RESOURCE_ATTRIBUTES_KEY = 'OTEL_RESOURCE_ATTRIBUTES';

/** Resource-attribute key constants (semconv-aligned). */
export const RA_SESSION_ID = 'gen_ai.conversation.id';
export const RA_ENDUSER_ID = 'enduser.id';
export const RA_AGENT_NAME = 'gen_ai.agent.name';
export const RA_KELET_PROJECT = 'kelet.project';
export const RA_METADATA_PREFIX = 'metadata.';

/**
 * 16 KiB total cap on the resource-attribute value. Env-var size
 * limits vary by platform (~128 KiB on Linux ARG_MAX, smaller on
 * macOS/Windows); 16 KiB is well under any of them and large enough
 * for normal session/user/agent + dozens of metadata kwargs.
 */
const RESOURCE_ATTRS_BYTE_CAP = 16 * 1024;

// Per-process one-shot WARN dedupe for resource-attr build failures.
// Separate from `_warnedKeys` (which tracks Layer A defers) because
// these are encoding/cap failures, not host-conflict warnings.
const _warnedResourceAttrKeys = new Set<string>();

/**
 * Reset the resource-attr WARN cache. For testing only.
 * @internal
 */
export function _resetResourceAttrWarnedKeys(): void {
  _warnedResourceAttrKeys.clear();
}

/** Coerce a value to a percent-encoded string (RFC 3986). */
function encodeValue(value: unknown): string {
  // Mirror the Python `_encode_value`: prefer the actual string; coerce
  // primitives via String(); for objects that throw in their `toString`,
  // the call site catches and skips the key.
  const s = typeof value === 'string' ? value : String(value);
  return encodeURIComponent(s);
}

/** Parse an `OTEL_RESOURCE_ATTRIBUTES` string into `{ key: encodedValue }`. */
function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1);
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

/** Format `{ key: encodedValue }` back into the env-var string. */
function formatResourceAttributes(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

/**
 * Build the `{ key: encodedValue }` dict from the Kelet ALS context.
 *
 * Per-key try/catch isolation: a single value that throws during
 * `String(value)` or `encodeURIComponent` does NOT take down the whole
 * resource-attribute payload. Bad keys are skipped with a one-shot
 * WARNING; well-formed keys are still included.
 *
 * Returns `{}` when no Kelet context is active — outside any
 * `agenticSession` block, no resource attributes are appended. CC's
 * own `session.id` then continues to be the implicit grouping id and
 * the workflow extractor falls through to its today-behavior
 * `"claude_code"` agent name.
 *
 * @internal
 */
export function buildKeletResourceAttrs(opts?: {
  project?: string;
}): Record<string, string> {
  const pairs: Record<string, string> = {};

  const tryAdd = (key: string, value: unknown): void => {
    try {
      pairs[key] = encodeValue(value);
    } catch {
      if (!_warnedResourceAttrKeys.has(key)) {
        _warnedResourceAttrKeys.add(key);
        console.warn(
          `[kelet] failed to encode ${key} for OTEL_RESOURCE_ATTRIBUTES; ` +
            'key will be skipped on the spawned subprocess'
        );
      }
    }
  };

  const sessionId = getSessionId();
  const userId = getUserId();
  const metadata = getMetadata();

  // Outside any agenticSession block, none of the ALS getters return a
  // value — bail early so we emit no resource attributes (matches Python's
  // `test_b_no_resource_attributes_outside_session`). Without this guard
  // `kelet.project` from `config.project` would always fire regardless of
  // whether a Kelet context exists, which is wrong: the resource-attr
  // payload is meant to mark the subprocess as belonging to a Kelet
  // session, and outside a session there is nothing to mark.
  if (sessionId === undefined && userId === undefined && !metadata) {
    return pairs;
  }

  if (sessionId !== undefined) tryAdd(RA_SESSION_ID, sessionId);
  if (userId !== undefined) tryAdd(RA_ENDUSER_ID, userId);
  // Project propagation: stamp `kelet.project` from the config when a
  // Kelet context is active. (Python only stamps it when its per-session
  // override is set — TS has no per-session override yet, so we always
  // include the config value when in-session, which is strictly more
  // permissive but harmless: the caller can always override it via
  // `OTEL_RESOURCE_ATTRIBUTES` on `options.env`.)
  if (opts?.project !== undefined) tryAdd(RA_KELET_PROJECT, opts.project);
  if (metadata) {
    for (const [k, v] of Object.entries(metadata)) {
      tryAdd(`${RA_METADATA_PREFIX}${k}`, v);
    }
  }

  return enforceSizeCap(pairs);
}

/**
 * Drop `metadata.*` entries until the formatted value is under the cap.
 *
 * Core keys (`gen_ai.conversation.id`, `enduser.id`, `gen_ai.agent.name`,
 * `kelet.project`) are kept even if dropping every metadata entry
 * doesn't bring the total under the cap — those are observation-grouping
 * signals the workflow extractor needs.
 */
function enforceSizeCap(
  pairs: Record<string, string>,
  capBytes = RESOURCE_ATTRS_BYTE_CAP
): Record<string, string> {
  const size = (d: Record<string, string>): number =>
    Buffer.byteLength(formatResourceAttributes(d), 'utf-8');

  if (size(pairs) <= capBytes) return pairs;

  const out = { ...pairs };
  const metadataKeysInOrder = Object.keys(out).filter((k) =>
    k.startsWith(RA_METADATA_PREFIX)
  );
  let dropped = 0;
  while (metadataKeysInOrder.length > 0 && size(out) > capBytes) {
    const lastKey = metadataKeysInOrder.pop();
    if (lastKey !== undefined) {
      delete out[lastKey];
      dropped += 1;
    }
  }

  if (dropped > 0) {
    const capWarnKey = '__resource_attrs_cap__';
    if (!_warnedResourceAttrKeys.has(capWarnKey)) {
      _warnedResourceAttrKeys.add(capWarnKey);
      console.warn(
        `[kelet] OTEL_RESOURCE_ATTRIBUTES exceeded ${capBytes} bytes; ` +
          `dropped ${dropped} metadata.* entries from CC subprocess env`
      );
    }
  }
  return out;
}

/**
 * Compose caller's `OTEL_RESOURCE_ATTRIBUTES` value with Kelet's pairs.
 *
 * Per-key precedence: caller's keys keep their original values, Kelet's
 * fill in for any missing entries. Returns the formatted env-var string.
 *
 * @internal
 */
export function mergeResourceAttributes(opts: {
  callerValue: string | undefined;
  keletPairs: Record<string, string>;
}): string {
  const callerPairs = parseResourceAttributes(opts.callerValue);
  const merged: Record<string, string> = { ...callerPairs };
  for (const [k, v] of Object.entries(opts.keletPairs)) {
    if (!(k in merged)) {
      merged[k] = v;
    }
  }
  return formatResourceAttributes(merged);
}

/**
 * Format the soft warning when user opts out of injection without setting
 * `CLAUDE_CODE_ENABLE_TELEMETRY` themselves. Mirrors the Python soft warning
 * — closes the "I disabled injection and forgot to configure CC telemetry
 * myself" hole.
 */
export function formatOptOutSoftWarning(): string {
  return (
    '[kelet] injectCcTelemetry is false but CLAUDE_CODE_ENABLE_TELEMETRY ' +
    "isn't set in process.env — Claude Code won't emit OTLP. Set the CC OTLP " +
    'env vars yourself (see CC_OTLP_ENV_KEYS), or remove the ' +
    'injectCcTelemetry: false flag to let Kelet inject them.'
  );
}
