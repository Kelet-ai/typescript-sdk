/**
 * Kelet TypeScript SDK
 *
 * Minimal SDK for Kelet AI observability, integrating with Vercel AI SDK
 * telemetry via OpenTelemetry.
 *
 * @example
 * ```typescript
 * import { configure, agenticSession, signal, SignalKind, SignalSource } from 'kelet';
 *
 * // 1. Configure (sets up exporter + span processor + provider)
 * configure({
 *   apiKey: process.env.KELET_API_KEY,
 *   project: 'my-project',
 * });
 *
 * // 2. Group work under a session
 * await agenticSession({ sessionId: 'session-123', userId: 'user-1' }, async () => {
 *   // signal() auto-resolves sessionId from context
 *   await signal({ kind: SignalKind.FEEDBACK, source: SignalSource.HUMAN, score: 1.0 });
 * });
 * ```
 *
 * @packageDocumentation
 */

export { KeletExporter, type KeletExporterOptions } from './exporter';
export { signal, SignalError, type SignalOptions } from './signal';
export { type KeletConfig, type KeletConfigOptions } from './config';
export { configure, shutdown, type ConfigureOptions } from './setup';
export { SignalKind, SignalSource } from './types';
export {
  agenticSession,
  getSessionId,
  getUserId,
  getMetadata,
  getTraceId,
  SESSION_ID_ATTR,
  USER_ID_ATTR,
  type AgenticSessionOptions,
} from './context';
export { KeletSpanProcessor, type KeletSpanProcessorOptions } from './processor';
