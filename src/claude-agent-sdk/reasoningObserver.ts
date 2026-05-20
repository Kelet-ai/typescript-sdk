/**
 * Observe `@anthropic-ai/claude-agent-sdk` streams + emit `kelet.reasoning`
 * OTLP log records.
 *
 * Mirrors the Python `_reasoning_observer` module: scans yielded
 * `AssistantMessage` envelopes for `ThinkingBlock` content (which Claude
 * Code redacts in its native OTLP) and emits one log record per block.
 *
 * Combined with env-injection in a single wrapper per attribute — `wrapt`
 * stacking ambiguity matters in JS too (the import-in-the-middle Hook
 * runs once per export).
 *
 * @module claude-agent-sdk/reasoningObserver
 */

import type { KeletConfig } from '../config';
import { buildCcEnv, formatDeferredWarning, mergeIntoOptions } from './envInjection';

/**
 * Scope name the Kelet server accepts on /api/logs. Must start with
 * `com.anthropic.claude_code` so the server's CC filter lets the record
 * through. Changing this string is a breaking change on the ingestion
 * contract.
 */
export const REASONING_SCOPE_NAME = 'com.anthropic.claude_code.kelet_reasoning';

/**
 * Body string the Kelet workflow matches on to discriminate reasoning
 * records from other CC log events.
 */
export const REASONING_EVENT_NAME = 'kelet.reasoning';

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
// Reasoning extraction — duck-typed against both the Python-shape envelope
// (msg.content[]) and the TS-shape envelope (msg.message.content[]).
// ---------------------------------------------------------------------------

interface ThinkingBlockLike {
  thinking?: unknown;
  signature?: unknown;
}

interface AssistantMessageLike {
  content?: unknown;
  message_id?: unknown;
  session_id?: unknown;
  message?: {
    content?: unknown;
    id?: unknown;
    message_id?: unknown;
    session_id?: unknown;
  };
}

function iterThinkingBlocks(msg: AssistantMessageLike): unknown[] | null {
  if (Array.isArray(msg.content)) return msg.content;
  if (msg.message && Array.isArray(msg.message.content)) return msg.message.content;
  return null;
}

function extractMessageId(msg: AssistantMessageLike): string | null {
  const top = msg.message_id;
  if (typeof top === 'string' && top.length > 0) return top;
  if (msg.message) {
    const inner = msg.message.id ?? msg.message.message_id;
    if (typeof inner === 'string' && inner.length > 0) return inner;
  }
  return null;
}

function extractSessionId(msg: AssistantMessageLike): string | null {
  const top = msg.session_id;
  if (typeof top === 'string' && top.length > 0) return top;
  if (msg.message) {
    const inner = msg.message.session_id;
    if (typeof inner === 'string' && inner.length > 0) return inner;
  }
  return null;
}

/**
 * Emit one `kelet.reasoning` log record per ThinkingBlock in `msg`.
 *
 * Returns the session id observed on `msg` (or null) so the caller can
 * cache it across the stream — early messages can arrive before the SDK
 * populates session_id, and the workflow filter requires it.
 */
function emitReasoning(msg: AssistantMessageLike, stickySessionId: string | null): string | null {
  if (_logger === null) return extractSessionId(msg);
  const blocks = iterThinkingBlocks(msg);
  if (blocks === null) return null;
  const messageId = extractMessageId(msg);
  const sessionId = extractSessionId(msg) ?? stickySessionId;
  for (const blockUnknown of blocks) {
    if (typeof blockUnknown !== 'object' || blockUnknown === null) continue;
    const block = blockUnknown as ThinkingBlockLike;
    const thinking = block.thinking;
    if (typeof thinking !== 'string') continue;
    const signature = typeof block.signature === 'string' ? block.signature : '';
    const attributes: Record<string, unknown> = {
      'reasoning.text': thinking,
      'reasoning.signature': signature,
    };
    if (messageId) attributes['reasoning.message_id'] = messageId;
    if (sessionId) attributes['session.id'] = sessionId;
    try {
      _logger.emit({
        body: REASONING_EVENT_NAME,
        attributes,
        eventName: REASONING_EVENT_NAME,
      });
    } catch {
      // Defensive: never propagate observer failures into user iteration.
    }
  }
  return extractSessionId(msg);
}

// ---------------------------------------------------------------------------
// Wrapper — combined env-injection + reasoning observer. Used at install
// time to replace `query` and `ClaudeSDKClient` exports with patched
// versions.
// ---------------------------------------------------------------------------

interface AgentOptionsLike {
  env?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Resolve options from positional/named args. Returns the (possibly newly
 * created) options object so the caller can mutate `options.env` before
 * forwarding.
 */
function resolveOptions(
  args: unknown[],
  argIndex: number,
  ClaudeAgentOptionsCtor: (new () => AgentOptionsLike) | null
): AgentOptionsLike | null {
  let options = args[argIndex];
  // The JS query() takes options as the second arg `query(prompt, options)`.
  // ClaudeSDKClient takes options at index 0.
  if (options === undefined || options === null) {
    if (ClaudeAgentOptionsCtor === null) return null;
    options = new ClaudeAgentOptionsCtor();
    args[argIndex] = options;
  }
  if (typeof options !== 'object' || options === null) return null;
  return options as AgentOptionsLike;
}

/**
 * Install env-injection on options before forwarding the call.
 *
 * Pure no-op when:
 * - the injection flag is off,
 * - no Kelet config is resolvable (configure() not called).
 *
 * On the first call where `process.env` has a different value than what
 * Kelet would inject AND `options.env` doesn't override, we'd already have
 * warned at Layer A — Layer B only set-if-missing on `options.env` so it
 * never warns.
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

/**
 * Wrap `query()` — combined env-injection + observer.
 *
 * Signature matches the JS SDK: `query(prompt, options?)` returns an async
 * iterable of `AssistantMessage`. We mutate `options.env` before
 * forwarding, then observe each yielded message for ThinkingBlocks.
 */
export function wrapQuery<F extends (...args: unknown[]) => AsyncIterable<unknown>>(
  original: F,
  configResolver: () => KeletConfig | null,
  ClaudeAgentOptionsCtor: (new () => AgentOptionsLike) | null
): F {
  const wrapped = function (this: unknown, ...args: unknown[]): AsyncIterable<unknown> {
    // Resolve / materialize options (positional index 1 — after prompt).
    const options = resolveOptions(args, 1, ClaudeAgentOptionsCtor);
    injectEnvIntoOptions(options, configResolver);
    const inner = original.apply(this, args);
    return observeAsyncIterable(inner);
  };
  return wrapped as unknown as F;
}

/**
 * Wrap `ClaudeSDKClient` — env-injection at construction, observer when
 * the client's stream methods are called.
 *
 * The class is wrapped via subclassing: the constructor calls super with
 * mutated options, and `receive_messages` / `receive_response` are
 * overridden to interpose the observer iterator.
 */
export function wrapClaudeSDKClient<T extends new (options?: AgentOptionsLike) => object>(
  Original: T,
  configResolver: () => KeletConfig | null,
  ClaudeAgentOptionsCtor: (new () => AgentOptionsLike) | null
): T {
  const Wrapped = class extends (Original as unknown as new (
    options?: AgentOptionsLike
  ) => Record<string, unknown>) {
    constructor(options?: AgentOptionsLike) {
      const args: unknown[] = [options];
      const opts = resolveOptions(args, 0, ClaudeAgentOptionsCtor);
      injectEnvIntoOptions(opts, configResolver);
      super(args[0] as AgentOptionsLike | undefined);
    }
    receive_messages(...args: unknown[]): AsyncIterable<unknown> {
      const fn = lookupOnPrototypeChain(Original.prototype, 'receive_messages');
      if (typeof fn !== 'function') {
        return (async function* () {
          /* empty — upstream class does not expose this method */
        })();
      }
      return observeAsyncIterable(fn.apply(this, args));
    }
    receive_response(...args: unknown[]): AsyncIterable<unknown> {
      const fn = lookupOnPrototypeChain(Original.prototype, 'receive_response');
      if (typeof fn !== 'function') {
        return (async function* () {
          /* empty — upstream class does not expose this method */
        })();
      }
      return observeAsyncIterable(fn.apply(this, args));
    }
  };
  return Wrapped as unknown as T;
}

/**
 * Walk the prototype chain looking for ``name``. Returns the function
 * if found (anywhere in the chain — including base classes), or
 * ``undefined``. Bare ``proto[name]`` only inspects the immediate
 * prototype, which misses inherited methods.
 */
function lookupOnPrototypeChain(
  proto: object,
  name: string
): ((...args: unknown[]) => AsyncIterable<unknown>) | undefined {
  let current: object | null = proto;
  while (current !== null && current !== Object.prototype) {
    const value = (current as Record<string, unknown>)[name];
    if (typeof value === 'function') {
      return value as (...args: unknown[]) => AsyncIterable<unknown>;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

/**
 * Pass-through async iterable that observes each yielded item for
 * ThinkingBlocks before forwarding it to the consumer.
 */
function observeAsyncIterable<T>(inner: AsyncIterable<T>): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      let stickySessionId: string | null = null;
      for await (const item of inner) {
        try {
          const updated = emitReasoning(item as AssistantMessageLike, stickySessionId);
          if (updated) stickySessionId = updated;
        } catch {
          // Defensive — observer failures must never propagate to user code.
        }
        yield item;
      }
    },
  };
}

// Re-export the env-injection helpers + scope/event names so tests can
// import from a single module path.
export { buildCcEnv, formatDeferredWarning };
