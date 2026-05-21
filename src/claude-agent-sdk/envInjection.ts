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
 * @module claude-agent-sdk/envInjection
 */

import type { KeletConfig } from '../config';

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
  return merged;
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
