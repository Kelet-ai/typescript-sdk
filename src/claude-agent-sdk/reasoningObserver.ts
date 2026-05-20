/**
 * Observe `@anthropic-ai/claude-agent-sdk` streams + emit `kelet.reasoning`
 * OTLP log records.
 *
 * Combined with env-injection in a single wrapper per attribute — used by
 * the shim (`kelet/claude-agent-sdk/shim`) and the loader
 * (`kelet/claude-agent-sdk/register`) where `installReasoningObserver`
 * in `index.ts` can't reach because the module namespace is already frozen.
 *
 * @module claude-agent-sdk/reasoningObserver
 */

import type { KeletConfig } from '../config';
import { buildCcEnv, mergeIntoOptions } from './envInjection';
import { observeAssistantMessage, REASONING_EVENT_NAME } from './streamObserver';

export { REASONING_EVENT_NAME } from './streamObserver';

/**
 * Scope name the Kelet server accepts on /api/logs. Must start with
 * `com.anthropic.claude_code` so the server's CC filter lets the record
 * through. Changing this string is a breaking change on the ingestion
 * contract.
 */
export const REASONING_SCOPE_NAME = 'com.anthropic.claude_code.kelet_reasoning';

// Minimal Logger surface — the actual implementation comes from
// @opentelemetry/api-logs / sdk-logs at runtime. Kept as a structural
// type so the optional peer deps don't break consumers who only need
// env-injection (Layer A).
export interface MinimalLogger {
  emit(record: {
    body: string;
    attributes?: Record<string, unknown>;
    eventName?: string;
  }): void;
}

let _logger: MinimalLogger | null = null;
let _injectCcTelemetry = true;

/**
 * Override the module-level logger. Called by `installClaudeAgentSDK` when
 * it provisions a dedicated LoggerProvider for the integration.
 */
export function setLogger(logger: MinimalLogger | null): void {
  _logger = logger;
}

/** Reset to no logger — emissions silently no-op. */
export function resetLogger(): void {
  _logger = null;
}

/** Toggle the env-injection flag. */
export function setInjectCcTelemetry(value: boolean): void {
  _injectCcTelemetry = value;
}

/** Reset env-injection flag (for testing). */
export function resetInjectCcTelemetry(): void {
  _injectCcTelemetry = true;
}

// ---------------------------------------------------------------------------
// Env injection — Layer B applied at call time (shim / register / namespace)
// ---------------------------------------------------------------------------

interface AgentOptionsLike {
  env?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Install env-injection on options before forwarding the call.
 *
 * Pure no-op when:
 * - the injection flag is off,
 * - no Kelet config is resolvable (configure() not called).
 */
function injectEnvIntoOptions(
  options: AgentOptionsLike | null,
  configResolver: () => KeletConfig | null
): void {
  if (!_injectCcTelemetry) return;
  if (options === null) return;
  const config = configResolver();
  if (config === null) return;
  options.env = mergeIntoOptions(options.env, config);
}

// ---------------------------------------------------------------------------
// Stream observer — delegates to streamObserver.observeAssistantMessage so
// ThinkingBlock extraction logic lives in exactly one place.
// ---------------------------------------------------------------------------

function makeEmitCallback(logger: MinimalLogger): (attrs: Record<string, string>) => void {
  return (attrs) => {
    try {
      logger.emit({
        body: REASONING_EVENT_NAME,
        attributes: attrs,
        eventName: REASONING_EVENT_NAME,
      });
    } catch {
      // Defensive — observer failures must never propagate to user code.
    }
  };
}

/**
 * Pass-through async iterable that observes each yielded item for
 * ThinkingBlocks before forwarding it to the consumer.
 *
 * Reuses `observeAssistantMessage` from `streamObserver.ts` — single source
 * of truth for ThinkingBlock extraction logic.
 */
function observeAsyncIterable<T>(inner: AsyncIterable<T>): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      let stickySessionId: string | undefined;
      const logger = _logger;
      const emit = logger !== null ? makeEmitCallback(logger) : null;
      for await (const item of inner) {
        try {
          if (emit !== null) {
            stickySessionId = observeAssistantMessage(item, emit, stickySessionId);
          }
        } catch {
          // Defensive — observer failures must never propagate to user code.
        }
        yield item;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Wrapper — combined env-injection + reasoning observer. Used at install
// time to replace `query` export with a patched version.
// ---------------------------------------------------------------------------

/**
 * Wrap `query()` — combined env-injection + observer.
 *
 * The TS SDK's `query()` signature is `query({ prompt, options? })` — a
 * single object argument. Options is at `args[0].options`, not `args[1]`.
 */
export function wrapQuery<F extends (...args: unknown[]) => AsyncIterable<unknown>>(
  original: F,
  configResolver: () => KeletConfig | null,
  ClaudeAgentOptionsCtor: (new () => AgentOptionsLike) | null
): F {
  const wrapped = function (this: unknown, ...args: unknown[]): AsyncIterable<unknown> {
    // The TS SDK query signature: query({ prompt, options? })
    // options is nested inside the first arg, not a separate positional arg.
    const firstArg = args[0];
    if (typeof firstArg === 'object' && firstArg !== null) {
      const params = firstArg as Record<string, unknown>;
      // Materialize options if absent — use the constructor when available
      // (preserves the SDK's class shape), otherwise fall back to a plain
      // object so env injection still runs when the constructor is unavailable.
      if (params['options'] === undefined || params['options'] === null) {
        params['options'] = ClaudeAgentOptionsCtor !== null
          ? new ClaudeAgentOptionsCtor()
          : {};
      }
      const opts = params['options'];
      if (typeof opts === 'object' && opts !== null) {
        injectEnvIntoOptions(opts as AgentOptionsLike, configResolver);
      }
    }
    const inner = original.apply(this, args);
    return observeAsyncIterable(inner);
  };
  return wrapped as unknown as F;
}

// Re-export env-injection helpers + scope/event names so tests can
// import from a single module path.
export { buildCcEnv };
