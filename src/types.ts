/**
 * Signal models for Kelet SDK.
 * @module types
 */

/**
 * Kind of signal — what type of observation this is.
 *
 * @example
 * ```typescript
 * import { SignalKind } from 'kelet';
 *
 * await signal({
 *   kind: SignalKind.FEEDBACK,
 *   source: SignalSource.HUMAN,
 *   sessionId: 'session-123',
 *   score: 0.0,
 * });
 * ```
 */
export const SignalKind = {
  /** User feedback (thumbs up/down, ratings). */
  FEEDBACK: 'feedback',
  /** User edited the AI output. */
  EDIT: 'edit',
  /** System or application event. */
  EVENT: 'event',
  /** Numeric metric measurement. */
  METRIC: 'metric',
  /** Custom/untyped signal. */
  ARBITRARY: 'arbitrary',
} as const;

export type SignalKind = (typeof SignalKind)[keyof typeof SignalKind];

/**
 * Source of the signal — who/what generated it.
 *
 * @example
 * ```typescript
 * import { SignalSource } from 'kelet';
 *
 * await signal({
 *   kind: SignalKind.FEEDBACK,
 *   source: SignalSource.HUMAN,
 *   sessionId: 'session-123',
 * });
 * ```
 */
export const SignalSource = {
  /** Signal from a human user. */
  HUMAN: 'human',
  /** Signal from a labeling process. */
  LABEL: 'label',
  /** Synthetically generated signal. */
  SYNTHETIC: 'synthetic',
} as const;

export type SignalSource = (typeof SignalSource)[keyof typeof SignalSource];
