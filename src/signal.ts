/**
 * Signal submission for Kelet SDK.
 * @module signal
 */

import { resolveConfig } from './config';
import type { SignalSource, SignalVote } from './types';

/** Retry configuration */
const MAX_RETRIES = 3;
const RETRY_BACKOFF_BASE_MS = 500;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Options for signal submission.
 */
export interface SignalOptions {
  /** Signal source (IMPLICIT or EXPLICIT). */
  source: SignalSource;
  /** Session identifier. Either sessionId or traceId is required. */
  sessionId?: string;
  /** Trace identifier. Either sessionId or traceId is required. */
  traceId?: string;
  /** Vote type (UPVOTE or DOWNVOTE). */
  vote?: SignalVote;
  /** User explanation for the feedback. */
  explanation?: string;
  /** Name of the trigger (e.g., "declined", "user_copy"). */
  triggerName?: string;
  /** Selected text or content. */
  selection?: string;
  /** Corrected version of the AI output. Can be string or object (serialized to JSON). */
  correction?: string | Record<string, unknown>;
}

/**
 * HTTP error with status code.
 */
export class SignalError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseText: string
  ) {
    super(message);
    this.name = 'SignalError';
  }
}

/**
 * Submit a signal (user feedback) for an AI session.
 *
 * Signals provide feedback on AI responses, enabling continuous improvement.
 * They can be linked to sessions via sessionId or traceId.
 *
 * Includes retry logic with exponential backoff for transient failures.
 *
 * @param options - Signal options including source and identifier
 * @throws {Error} If neither sessionId nor traceId is provided
 * @throws {SignalError} If the request fails after retries
 *
 * @example
 * ```typescript
 * import { signal, SignalSource, SignalVote } from 'kelet';
 *
 * // Explicit user feedback
 * await signal({
 *   source: SignalSource.EXPLICIT,
 *   sessionId: 'session-123',
 *   vote: SignalVote.UPVOTE,
 *   explanation: 'Great response!',
 * });
 *
 * // Implicit feedback with trace
 * await signal({
 *   source: SignalSource.IMPLICIT,
 *   traceId: 'trace-abc',
 *   triggerName: 'user_copy',
 *   selection: 'copied text',
 * });
 * ```
 */
export async function signal(options: SignalOptions): Promise<void> {
  const { source, sessionId, traceId, vote, explanation, triggerName, selection, correction } =
    options;

  // Validate identifier
  if (!sessionId && !traceId) {
    throw new Error('Either sessionId or traceId required.');
  }

  const config = resolveConfig();

  // Build URL
  const url = `${config.apiUrl}/api/projects/${config.project}/signal`;

  // Serialize correction if object
  let resolvedCorrection: string | undefined;
  if (correction !== undefined) {
    resolvedCorrection =
      typeof correction === 'string' ? correction : JSON.stringify(correction);
  }

  // Build payload (snake_case for API)
  const payload: Record<string, unknown> = {
    source,
  };
  if (sessionId !== undefined) payload.session_id = sessionId;
  if (traceId !== undefined) payload.trace_id = traceId;
  if (vote !== undefined) payload.vote = vote;
  if (explanation !== undefined) payload.explanation = explanation;
  if (triggerName !== undefined) payload.trigger_name = triggerName;
  if (selection !== undefined) payload.selection = selection;
  if (resolvedCorrection !== undefined) payload.correction = resolvedCorrection;

  // Retry with exponential backoff
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: config.apiKey,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        return;
      }

      // Check if retryable
      if (!RETRYABLE_STATUS_CODES.has(response.status)) {
        const responseText = await response.text();
        throw new SignalError(
          `Signal request failed with status ${response.status}`,
          response.status,
          responseText
        );
      }

      // Retryable error - continue loop
      const responseText = await response.text();
      lastError = new SignalError(
        `Signal request failed with status ${response.status}`,
        response.status,
        responseText
      );

      // Wait before retry (exponential backoff)
      if (attempt < MAX_RETRIES - 1) {
        const waitTime = RETRY_BACKOFF_BASE_MS * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    } catch (error) {
      // Network errors are retryable
      if (error instanceof SignalError) {
        throw error; // Non-retryable HTTP error
      }

      lastError = error instanceof Error ? error : new Error(String(error));

      // Wait before retry
      if (attempt < MAX_RETRIES - 1) {
        const waitTime = RETRY_BACKOFF_BASE_MS * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
  }

  // All retries exhausted
  if (lastError) {
    throw lastError;
  }
}
