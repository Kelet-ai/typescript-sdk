/**
 * Install a ``kelet.reasoning`` observer on ``@anthropic-ai/claude-agent-sdk``.
 *
 * Claude Code v2.1.119+ natively emits OTLP traces, logs, and metrics when
 * users set ``CLAUDE_CODE_ENABLE_TELEMETRY=1`` + ``OTEL_EXPORTER_OTLP_*`` env
 * vars themselves (see the contract doc). The only piece Kelet still needs
 * to capture is reasoning text, because Claude Code redacts ``thinking`` in
 * its own OTLP payloads. We do that here: wrap the SDK's message-stream
 * factories, scan ``AssistantMessage.content[]`` for ``ThinkingBlock``
 * entries, and emit one ``kelet.reasoning`` log record per block on the
 * global OTel logger provider.
 *
 * No subprocess proxy, no env injection, no parent span, no ContextManager
 * probe. Logs go through the ``LoggerProvider`` that ``configure()`` wires
 * up alongside the ``TracerProvider``.
 *
 * ## Usage
 *
 * ```ts
 * import { installReasoningObserver } from 'kelet/claude-agent-sdk';
 * import * as sdk from '@anthropic-ai/claude-agent-sdk';
 *
 * installReasoningObserver(sdk);
 *
 * for await (const msg of sdk.query({ prompt: 'hello' })) {
 *   // msg is yielded exactly as the SDK would yield it.
 * }
 * ```
 *
 * @module claude-agent-sdk
 */

import type { Logger } from '@opentelemetry/api-logs';
import { logs as logsApi, SeverityNumber } from '@opentelemetry/api-logs';
import { observeAssistantMessage, REASONING_EVENT_NAME } from './streamObserver';

/**
 * Scope name the Kelet server accepts on ``/api/logs``. The server filter
 * is ``scope.name.startsWith('com.anthropic.claude_code')`` — anything
 * else is warn-and-dropped before reaching the CC ingestion workflow.
 * Changing this string is a breaking change on the ingestion contract.
 */
export const REASONING_SCOPE_NAME = 'com.anthropic.claude_code.kelet_reasoning';

// Integration-scoped logger override — when ``configure()`` provisions
// a dedicated ``LoggerProvider`` (to avoid clobbering the host app's
// global provider), it registers that provider here and the wrapper
// resolves its logger against it instead of the OTel global.
let _scopedLogger: Logger | null = null;

/**
 * Register a ``Logger`` resolved from an integration-scoped provider.
 * Called by ``configure()`` when it builds its own ``LoggerProvider``
 * rather than installing one on the OTel global. No-op for unit tests
 * that wire their own ``logsApi.setGlobalLoggerProvider``.
 */
export function setReasoningLogger(logger: Logger | null): void {
  _scopedLogger = logger;
}

/** Minimal shape of ``query()`` arguments. */
interface QueryArgsLike {
  prompt?: unknown;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * An async iterable of SDK messages. The SDK's ``Query`` type also carries
 * ``interrupt``, ``setPermissionMode``, etc.; we preserve those via passthrough.
 */
interface MessageStream extends AsyncIterable<unknown> {
  [key: string]: unknown;
}

/** Minimal shape of ``ClaudeSDKClient`` from the SDK. */
interface ClaudeSDKClientLike {
  query(...args: unknown[]): unknown;
  receiveMessages?(...args: unknown[]): unknown;
  receiveResponse?(...args: unknown[]): unknown;
  [key: string]: unknown;
}

/** Constructor signature for ``ClaudeSDKClient``. */
type ClaudeSDKClientCtor = new (options?: Record<string, unknown>) => ClaudeSDKClientLike;

/** The shape of the ``@anthropic-ai/claude-agent-sdk`` module surface. */
export interface ClaudeAgentSDKModule {
  query: (args: QueryArgsLike) => MessageStream;
  ClaudeSDKClient?: ClaudeSDKClientCtor;
  [key: string]: unknown;
}

/** Sentinel so double-install is a no-op. */
const WRAPPED_MARKER: unique symbol = Symbol.for('kelet.claude_agent_sdk.observed');

function getLogger(): Logger {
  // Prefer the integration-scoped logger when ``configure()`` provisioned
  // one. Falls back to the OTel global for unit tests and for hosts that
  // wire their own ``logsApi.setGlobalLoggerProvider`` upstream of us.
  if (_scopedLogger !== null) return _scopedLogger;
  return logsApi.getLogger(REASONING_SCOPE_NAME);
}

/**
 * Wrap a message-stream factory so each yielded ``AssistantMessage`` is
 * observed for ``ThinkingBlock``s. Non-iterator properties on the returned
 * stream (``interrupt``, ``setPermissionMode``, etc.) are preserved.
 */
function wrapStream(factory: () => MessageStream): MessageStream {
  const source = factory();
  const logger = getLogger();

  async function* iterate(): AsyncGenerator<unknown, void, unknown> {
    let stickySessionId: string | undefined;
    try {
      for await (const item of source) {
        try {
          stickySessionId = observeAssistantMessage(
            item,
            (attrs) => {
              logger.emit({
                severityNumber: SeverityNumber.INFO,
                body: REASONING_EVENT_NAME,
                attributes: { ...attrs, 'event.name': REASONING_EVENT_NAME },
              });
            },
            stickySessionId,
          );
        } catch {
          // Never let observer failures break user iteration.
        }
        yield item;
      }
    } finally {
      // Propagate early-termination (consumer ``break`` / ``throw``) to
      // the underlying source so it can release any resources it holds.
      // TS runtime already calls ``source.return()`` on the outer
      // generator when the wrapped iterator is torn down, but an
      // explicit ``source.return?.()`` guards against sources that
      // only expose ``return`` via their async-iterator protocol.
      const sourceIter = (source as { return?: () => Promise<unknown> }).return;
      if (typeof sourceIter === 'function') {
        try {
          await sourceIter.call(source);
        } catch {
          // Defensive — source cleanup failures are not user-visible.
        }
      }
    }
  }

  const wrappedStream = iterate() as unknown as MessageStream;

  // Forward non-iterator properties (interrupt(), setPermissionMode(), ...)
  // from the underlying stream onto the wrapped one.
  for (const key of Object.keys(source)) {
    if (key in wrappedStream) continue;
    const value = (source as Record<string, unknown>)[key];
    if (typeof value === 'function') {
      (wrappedStream as Record<string, unknown>)[key] = (value as Function).bind(source);
    } else {
      (wrappedStream as Record<string, unknown>)[key] = value;
    }
  }

  return wrappedStream;
}

/**
 * Install the reasoning observer on the given SDK module. Mutates the module
 * in-place (best for ``import * as sdk`` consumers). Safe to call multiple
 * times — a sentinel short-circuits re-instrumentation.
 *
 * @param sdk The imported SDK module (``import * as sdk from '...'``).
 * @returns The same module, with ``query`` / ``ClaudeSDKClient`` wrapped.
 */
export function installReasoningObserver<T extends ClaudeAgentSDKModule>(sdk: T): T {
  if ((sdk as unknown as Record<symbol, unknown>)[WRAPPED_MARKER]) {
    return sdk;
  }

  const origQuery = sdk.query.bind(sdk);
  // Use rest args so a future SDK that accepts multiple positionals
  // (Python's ``ClaudeSDKClient.query(prompt, session_id)`` precedent)
  // doesn't silently lose arguments to the wrapper. TS
  // ``ClaudeAgentSDKModule.query`` is typed single-arg but we forward
  // via an ``unknown[]`` rest to survive SDK evolution.
  (sdk as unknown as Record<string, unknown>).query = (
    ...args: unknown[]
  ): MessageStream => {
    return wrapStream(() =>
      (origQuery as unknown as (...a: unknown[]) => MessageStream)(...args),
    );
  };

  const OriginalClient: ClaudeSDKClientCtor | undefined = sdk.ClaudeSDKClient;
  if (typeof OriginalClient === 'function') {
    // Alias to a non-undefined local — TS narrowing doesn't flow into nested
    // class scopes, and the ``override`` methods below dereference the proto.
    const Base: ClaudeSDKClientCtor = OriginalClient;
    class ObservedClient extends (Base as unknown as new (
      ...a: unknown[]
    ) => ClaudeSDKClientLike) {
      override query(...args: unknown[]): unknown {
        // Some SDK versions return a stream from query(); others return void
        // and expose messages via receiveMessages(). ``wrapMaybeStream`` is
        // the passthrough-or-wrap helper shared with the other overrides.
        return wrapMaybeStream(super.query(...args));
      }

      override receiveMessages(...args: unknown[]): unknown {
        return invokeAndMaybeWrap(Base.prototype, 'receiveMessages', this, args);
      }

      override receiveResponse(...args: unknown[]): unknown {
        return invokeAndMaybeWrap(Base.prototype, 'receiveResponse', this, args);
      }
    }
    (sdk as unknown as Record<string, unknown>).ClaudeSDKClient = ObservedClient;
  }

  Object.defineProperty(sdk, WRAPPED_MARKER, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return sdk;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in (value as Record<symbol, unknown>)
  );
}

/**
 * If ``value`` is async-iterable, wrap it through ``wrapStream`` so yielded
 * ``AssistantMessage``s get observed. Otherwise return it unchanged.
 *
 * Consolidates the pattern the three ``ClaudeSDKClient`` method overrides
 * used to repeat inline.
 */
function wrapMaybeStream(value: unknown): unknown {
  if (isAsyncIterable(value)) {
    return wrapStream(() => value as MessageStream);
  }
  return value;
}

/**
 * Look up ``method`` on ``proto``, invoke it with ``self`` + ``args``, and
 * thread the result through ``wrapMaybeStream``. Returns ``undefined`` when
 * the method isn't defined on the prototype — matches the pre-refactor
 * behaviour where ``receiveMessages``/``receiveResponse`` could be absent
 * on older SDK versions.
 */
function invokeAndMaybeWrap(
  proto: ClaudeSDKClientLike,
  method: 'receiveMessages' | 'receiveResponse',
  self: unknown,
  args: unknown[],
): unknown {
  const fn = proto[method];
  if (typeof fn !== 'function') return undefined;
  return wrapMaybeStream(fn.apply(self, args));
}

export { observeAssistantMessage, REASONING_EVENT_NAME } from './streamObserver';

/**
 * @deprecated Use {@link installReasoningObserver} instead. Kept as a thin
 * forward so v2 consumers who imported ``wrapClaudeAgentSDK`` from
 * ``kelet/claude-agent-sdk`` don't break; it now simply installs the
 * reasoning observer without the old wrapper's env injection or span setup.
 */
export function wrapClaudeAgentSDK<T extends ClaudeAgentSDKModule>(sdk: T): T {
  return installReasoningObserver(sdk);
}
