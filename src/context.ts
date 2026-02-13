/**
 * Agentic session context for Kelet SDK.
 *
 * Uses AsyncLocalStorage to propagate session/user IDs through async call chains.
 * @module context
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';

/** OpenTelemetry attribute key for session/conversation ID. */
export const SESSION_ID_ATTR = 'gen_ai.conversation.id';

/** OpenTelemetry attribute key for user ID. */
export const USER_ID_ATTR = 'user.id';

/** Options for agenticSession. */
export interface AgenticSessionOptions {
  /** Session identifier — groups spans and signals. */
  sessionId: string;
  /** Optional user identifier. */
  userId?: string;
}

interface SessionStore {
  sessionId: string;
  userId?: string;
}

/**
 * Internal storage for session context.
 * @internal
 */
export const _sessionStorage = new AsyncLocalStorage<SessionStore>();

/**
 * Run a callback within an agentic session context.
 *
 * All spans created and signals sent inside the callback will automatically
 * inherit the session and user IDs.
 *
 * @param options - Session options (sessionId required, userId optional)
 * @param fn - Callback to run within the session context
 * @returns The return value of the callback
 *
 * @example
 * ```typescript
 * import { agenticSession, signal, SignalSource, SignalVote } from 'kelet';
 *
 * await agenticSession({ sessionId: 'sess-123', userId: 'user-1' }, async () => {
 *   // signal() auto-resolves sessionId from context
 *   await signal({ source: SignalSource.EXPLICIT, vote: SignalVote.UPVOTE });
 * });
 * ```
 */
export function agenticSession<T>(options: AgenticSessionOptions, fn: () => T): T {
  const store: SessionStore = {
    sessionId: options.sessionId,
    userId: options.userId,
  };
  return _sessionStorage.run(store, fn);
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
