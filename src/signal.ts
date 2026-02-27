/**
 * Signal submission for Kelet SDK.
 * @module signal
 */

import { resolveConfig } from './config';
import { getSessionId, getTraceId as getContextTraceId } from './context';
import type { SignalKind, SignalSource } from './types';

/** Retry configuration */
const MAX_RETRIES = 3;
const RETRY_BACKOFF_BASE_MS = 500;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Options for signal submission.
 */
export interface SignalOptions {
  /** Signal kind (feedback, edit, event, metric, arbitrary). */
  kind: SignalKind;
  /** Signal source (human, label, synthetic). */
  source: SignalSource;
  /** Session identifier. Either sessionId or traceId is required. */
  sessionId?: string;
  /** Trace identifier. Either sessionId or traceId is required. */
  traceId?: string;
  /** Name of the trigger (e.g., "thumbs_down", "user_copy"). */
  triggerName?: string;
  /** Score value (0.0 to 1.0). */
  score?: number;
  /** Text content (feedback text, diff, reasoning, etc.). */
  value?: string;
  /** Confidence level (0.0 to 1.0). */
  confidence?: number;
  /** Additional metadata. */
  metadata?: Record<string, unknown>;
  /** Event timestamp. */
  timestamp?: Date | string;
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
 * Submit a signal for an AI session.
 *
 * Signals provide observations about AI responses, enabling continuous improvement.
 * They can be linked to sessions via sessionId or traceId.
 *
 * Includes retry logic with exponential backoff for transient failures.
 *
 * @param options - Signal options including kind, source, and identifier
 * @throws {Error} If neither sessionId nor traceId is provided
 * @throws {Error} If score or confidence is outside 0-1 range
 * @throws {SignalError} If the request fails after retries
 *
 * @example
 * ```typescript
 * import { signal, SignalKind, SignalSource } from 'kelet';
 *
 * // User feedback
 * await signal({
 *   kind: SignalKind.FEEDBACK,
 *   source: SignalSource.HUMAN,
 *   sessionId: 'session-123',
 *   score: 1.0,
 *   value: 'Great response!',
 *   triggerName: 'thumbs_up',
 * });
 *
 * // Metric signal
 * await signal({
 *   kind: SignalKind.METRIC,
 *   source: SignalSource.SYNTHETIC,
 *   traceId: 'trace-abc',
 *   score: 0.85,
 *   triggerName: 'accuracy',
 * });
 * ```
 */
export async function signal(options: SignalOptions): Promise<void> {
  const { kind, source, triggerName, score, value, confidence, metadata, timestamp } = options;

  // Validate score range
  if (score !== undefined && (score < 0 || score > 1)) {
    throw new Error('score must be between 0 and 1 (inclusive)');
  }

  // Validate confidence range
  if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
    throw new Error('confidence must be between 0 and 1 (inclusive)');
  }

  // Resolve identifiers: explicit param → context → error
  const sessionId = options.sessionId ?? getSessionId();
  const traceId = options.traceId ?? getContextTraceId();

  // Validate identifier
  if (!sessionId && !traceId) {
    throw new Error('Either sessionId or traceId required. Use agenticSession() or pass explicitly.');
  }

  const config = resolveConfig();

  // Build URL
  const url = `${config.apiUrl}/api/projects/${config.project}/signal`;

  // Build payload (snake_case for API)
  const payload: Record<string, unknown> = {
    kind,
    source,
  };
  if (sessionId !== undefined) payload.session_id = sessionId;
  if (traceId !== undefined) payload.trace_id = traceId;
  if (triggerName !== undefined) payload.trigger_name = triggerName;
  if (score !== undefined) payload.score = score;
  if (value !== undefined) payload.value = value;
  if (confidence !== undefined) payload.confidence = confidence;
  if (metadata !== undefined) payload.metadata = metadata;
  if (timestamp !== undefined) {
    payload.timestamp = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
  }

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
