/**
 * Emit `claude_code.sdk_query` wrapper spans around CC SDK invocations.
 *
 * The Kelet server's CC ingestion path groups OTLP records per CC
 * `session.id` (each `query()` invocation gets a fresh session.id from
 * Claude Code, which refuses to reuse one). For host applications that
 * make multiple `query()` calls in one logical workflow, this naturally
 * splits the workflow across multiple Kelet sessions — losing the parent
 * context the user actually cares about.
 *
 * To re-unify, both Kelet SDKs emit a wrapper span under scope
 * `kelet.claude_agent_sdk` named `claude_code.sdk_query`. The span's
 * time-window covers the whole CC subprocess lifetime; the server's
 * `_attach_kelet_sdk_wrappers_to_cc_groups` matcher uses the wrapper to
 * attribute every contained CC interaction span to the same Kelet session
 * group, so multi-`query()` workflows surface as a single coherent
 * session in extraction output.
 *
 * The wrapper span carries no per-turn payload — extraction reads the CC
 * `claude_code.interaction` / `claude_code.llm_request` spans for that.
 * The wrapper exists only as a temporal envelope that the server uses
 * during the per-session grouping pass.
 *
 * When started inside an active `agenticSession({...})` block, the wrapper
 * span automatically inherits `gen_ai.conversation.id` (and the other
 * Kelet ContextVars) on its **span attributes** because Kelet's global
 * `KeletSpanProcessor.onStart` stamps every in-context span as it's
 * created. This is a useful debugging signal — the wrapper span's
 * attributes show which Kelet session id was active at the wrap site —
 * but it is **not** the canonical cross-process grouping signal. That
 * lives on each emitted CC span's **resource attributes**, set once at
 * subprocess spawn via `OTEL_RESOURCE_ATTRIBUTES` env injection (see
 * `envInjection.ts`). The workflow extractor reads the resource attrs,
 * not the wrapper span attrs.
 *
 * @module claude-agent-sdk/wrapperSpan
 */

import type { Span, Tracer } from '@opentelemetry/api';
import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * Scope name + span name that the Kelet server's
 * `_attach_kelet_sdk_wrappers_to_cc_groups` matches on. Changing
 * either is a breaking change on the server's grouping contract.
 */
export const WRAPPER_SCOPE_NAME = 'kelet.claude_agent_sdk';
export const WRAPPER_SPAN_NAME = 'claude_code.sdk_query';

/**
 * Sentinel placed on a `query`-replacement function once its iteration
 * is already bracketed by a `claude_code.sdk_query` wrapper span.
 *
 * Both install paths can run in the same process during `configure()`:
 * Layer B (`installClaudeAgentSDK` → `wrapQuery`) replaces `mod.query`
 * first, then Layer A (`installReasoningObserver`) wraps the same module
 * via namespace mutation. Without this sentinel each user `query()`
 * call would emit two overlapping wrapper spans — confusing the server
 * reconciler. Whichever layer brackets first stamps the function; the
 * other detects the stamp and skips its own bracket.
 */
export const WRAPPER_BRACKETED_MARKER: unique symbol = Symbol.for(
  'kelet.claude_agent_sdk.bracketed',
);

/** True when `fn` has already been bracketed with a wrapper span. */
export function isBracketed(fn: unknown): boolean {
  return (
    typeof fn === 'function' &&
    (fn as unknown as Record<symbol, unknown>)[WRAPPER_BRACKETED_MARKER] === true
  );
}

/** Mark `fn` so the other install layer skips re-bracketing. */
export function markBracketed(fn: unknown): void {
  if (typeof fn !== 'function') return;
  try {
    Object.defineProperty(fn, WRAPPER_BRACKETED_MARKER, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  } catch {
    // Frozen function (extremely rare) — graceful degrade. The other
    // layer's check returns false; double-bracket is the worst case.
  }
}

/**
 * Resolve the wrapper tracer once per call. We resolve at call time (not
 * module import) because `kelet.configure()` may install the
 * TracerProvider after this module is imported via the entry-point
 * registration. Resolving lazily means the wrapper picks up the
 * configured provider.
 */
function getTracer(): Tracer {
  return trace.getTracer(WRAPPER_SCOPE_NAME);
}

/**
 * Start a `claude_code.sdk_query` span on the Kelet wrapper tracer.
 *
 * Returns the span so the caller can end it when the bracketed work
 * finishes. Failures fall back to a span object whose `end()` is a
 * no-op — wrapper bugs never break the user's iteration.
 */
function startWrapperSpan(): Span | null {
  try {
    return getTracer().startSpan(WRAPPER_SPAN_NAME);
  } catch {
    // Defensive — provider misconfiguration must never break user code.
    return null;
  }
}

/** End a wrapper span, swallowing any errors. */
function endWrapperSpan(span: Span | null): void {
  if (span === null) return;
  try {
    span.end();
  } catch {
    // Defensive — span teardown must never propagate.
  }
}

/**
 * Wrap an async iterable so the iteration runs while a wrapper span is
 * active. The span starts before the first item is requested and ends
 * when the iterator closes (normal exhaustion or early break / throw).
 *
 * Used to bracket the entire iteration of `claude_agent_sdk.query`. The
 * reasoning observer's loop runs underneath this — both wrappers compose
 * because the observer also yields one item at a time.
 */
export function bracketAsyncIterable<T>(
  source: AsyncIterable<T>,
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      const span = startWrapperSpan();
      try {
        for await (const item of source) {
          yield item;
        }
      } catch (err) {
        // Surface iteration failures on the wrapper span so the
        // server's session reconciler / observability tools can see
        // the bracket failed. The user iterator's error semantics are
        // preserved by re-throwing.
        if (span !== null) {
          try {
            span.recordException(err as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
          } catch {
            // Defensive — span attribute mutation must never break user code.
          }
        }
        throw err;
      } finally {
        endWrapperSpan(span);
      }
    },
  };
}

// NOTE: `@anthropic-ai/claude-agent-sdk@0.3.x` no longer ships a
// `ClaudeSDKClient` class — `query()` is the only entry point. If a
// future major adds back a stateful client, mirror the Python SDK's
// `openClientWrapperSpan`/`closeClientWrapperSpan` helpers here so the
// span covers the whole connect→disconnect window rather than a single
// `query()` iteration.
