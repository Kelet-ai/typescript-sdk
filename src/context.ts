/**
 * Agentic session context for Kelet SDK.
 *
 * Uses AsyncLocalStorage to propagate session/user IDs through async call chains.
 * @module context
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Attributes } from '@opentelemetry/api';
import { context as otelContext, propagation, trace } from '@opentelemetry/api';

/** OpenTelemetry attribute key for session/conversation ID. */
export const SESSION_ID_ATTR = 'gen_ai.conversation.id';

/** OpenTelemetry attribute key for user ID. */
export const USER_ID_ATTR = 'user.id';

/** OpenTelemetry attribute key for agent name. */
export const AGENT_NAME_ATTR = 'gen_ai.agent.name';

/** Options for agenticSession. */
export interface AgenticSessionOptions {
  /** Session identifier — groups spans and signals. */
  sessionId: string;
  /** Optional user identifier. */
  userId?: string;
  /** Optional project override — overrides the global project for this session's spans. */
  project?: string;
}

interface SessionStore {
  sessionId: string;
  userId?: string;
  project?: string;
}

interface AgentStore {
  agentName: string;
}

/**
 * Internal storage for session context.
 * @internal
 */
export const _sessionStorage = new AsyncLocalStorage<SessionStore>();

/**
 * Internal storage for agent context.
 * @internal
 */
export const _agentStorage = new AsyncLocalStorage<AgentStore>();

/**
 * Run a callback within an agentic session context.
 *
 * @param options - Session options (sessionId required, userId and project optional)
 * @param fn - Callback to run within the session context
 * @returns The return value of the callback
 *
 * @example
 * ```typescript
 * await agenticSession({ sessionId: 'sess-123', userId: 'user-1', project: 'my-project' }, async () => {
 *   await signal({ kind: SignalKind.FEEDBACK, source: SignalSource.HUMAN, score: 1.0 });
 * });
 * ```
 */
export function agenticSession<T>(options: AgenticSessionOptions, fn: () => T): T {
  // Merge with existing baggage so nested sessions preserve outer keys they don't override
  const activeBag = propagation.getBaggage(otelContext.active());
  const allEntries: Record<string, { value: string }> = {};
  if (activeBag) {
    for (const [key, entry] of activeBag.getAllEntries()) {
      allEntries[key] = { value: entry.value };
    }
  }
  allEntries['kelet.session_id'] = { value: options.sessionId };
  if (options.userId) allEntries['kelet.user_id'] = { value: options.userId };
  if (options.project) allEntries['kelet.project'] = { value: options.project };
  const bag = propagation.createBaggage(allEntries);
  const ctx = propagation.setBaggage(otelContext.active(), bag);
  return _sessionStorage.run(
    { sessionId: options.sessionId, userId: options.userId, project: options.project },
    () => otelContext.with(ctx, fn)
  );
}

/**
 * Get the current session ID from the agenticSession context.
 * @returns Session ID or undefined if not inside an agenticSession.
 */
export function getSessionId(): string | undefined {
  return _sessionStorage.getStore()?.sessionId;
}

/**
 * Get the current user ID from the agenticSession context.
 * @returns User ID or undefined if not set or not inside an agenticSession.
 */
export function getUserId(): string | undefined {
  return _sessionStorage.getStore()?.userId;
}

/**
 * Get the current project override from the agenticSession context.
 * @returns Project override or undefined if not set or not inside an agenticSession.
 */
export function getProjectOverride(): string | undefined {
  return _sessionStorage.getStore()?.project;
}

/**
 * Get the current agent name from the withAgent context.
 * @returns Agent name or undefined if not inside a withAgent call.
 */
export function getAgentName(): string | undefined {
  return _agentStorage.getStore()?.agentName;
}

/**
 * Get the current trace ID from the active OpenTelemetry span.
 * @returns Trace ID or undefined if no active span.
 */
export function getTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const traceId = span.spanContext().traceId;
  // OTEL uses "0000..." as the invalid trace ID
  if (traceId === '00000000000000000000000000000000') return undefined;
  return traceId;
}

/** Options for withAgent. */
export interface WithAgentOptions {
  /** Agent name stamped as gen_ai.agent.name on the span. */
  name: string;
}

/**
 * Run a callback within an agent span context.
 *
 * Creates an OTEL span with gen_ai.agent.name and invoke_agent operation.
 * All LLM calls inside the callback will be children of this span.
 *
 * @param options - Agent options (name required)
 * @param fn - Callback to run within the agent span
 * @returns The return value of the callback
 *
 * @example
 * ```typescript
 * await agenticSession({ sessionId: 's1' }, async () => {
 *   await withAgent({ name: 'support-bot' }, async () => {
 *     await anthropic.messages.create(...)
 *   })
 * })
 * ```
 */
export function withAgent<T>(options: WithAgentOptions, fn: () => T): T {
  const tracer = trace.getTracer('kelet');
  const attrs: Attributes = {
    'gen_ai.operation.name': 'invoke_agent',
    [AGENT_NAME_ATTR]: options.name,
  };
  const store = _sessionStorage.getStore();
  if (store?.sessionId) attrs[SESSION_ID_ATTR] = store.sessionId;
  if (store?.userId) attrs[USER_ID_ATTR] = store.userId;

  const span = tracer.startSpan(`agent ${options.name}`, { attributes: attrs });
  return otelContext.with(
    trace.setSpan(otelContext.active(), span),
    () => _agentStorage.run({ agentName: options.name }, () => {
      try {
        const result = fn();
        if (result instanceof Promise) {
          return (result as Promise<unknown>).finally(() => span.end()) as T;
        }
        span.end();
        return result;
      } catch (e) {
        span.end();
        throw e;
      }
    })
  );
}
