/**
 * Signal models for Kelet SDK.
 * @module types
 */

/**
 * Source of the signal (feedback).
 *
 * @example
 * ```typescript
 * import { SignalSource } from 'kelet';
 *
 * await signal({
 *   source: SignalSource.EXPLICIT,
 *   sessionId: 'session-123',
 *   vote: SignalVote.UPVOTE,
 * });
 * ```
 */
export const SignalSource = {
  /** Signal was triggered implicitly (e.g., user copy, auto-detect). */
  IMPLICIT: 'IMPLICIT',
  /** Signal was triggered explicitly by user action (e.g., thumbs up/down). */
  EXPLICIT: 'EXPLICIT',
} as const;

export type SignalSource = (typeof SignalSource)[keyof typeof SignalSource];

/**
 * Vote type for signals.
 *
 * @example
 * ```typescript
 * import { SignalVote } from 'kelet';
 *
 * await signal({
 *   source: SignalSource.EXPLICIT,
 *   sessionId: 'session-123',
 *   vote: SignalVote.DOWNVOTE,
 *   explanation: 'Response was incorrect',
 * });
 * ```
 */
export const SignalVote = {
  /** Positive feedback (thumbs up). */
  UPVOTE: 'UPVOTE',
  /** Negative feedback (thumbs down). */
  DOWNVOTE: 'DOWNVOTE',
} as const;

export type SignalVote = (typeof SignalVote)[keyof typeof SignalVote];
