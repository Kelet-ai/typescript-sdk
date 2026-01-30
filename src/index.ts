/**
 * Kelet TypeScript SDK
 *
 * Minimal SDK for Kelet AI observability, integrating with Vercel AI SDK
 * telemetry via OpenTelemetry.
 *
 * @example
 * ```typescript
 * import { KeletExporter, signal, SignalSource, SignalVote } from 'kelet';
 * import { NodeSDK } from '@opentelemetry/sdk-node';
 *
 * // 1. Set up tracing
 * const exporter = new KeletExporter({
 *   apiKey: process.env.KELET_API_KEY,
 *   project: 'my-project',
 * });
 *
 * const sdk = new NodeSDK({ traceExporter: exporter });
 * sdk.start();
 *
 * // 2. Send user feedback signals
 * await signal({
 *   source: SignalSource.EXPLICIT,
 *   sessionId: 'session-123',
 *   vote: SignalVote.UPVOTE,
 * });
 * ```
 *
 * @packageDocumentation
 */

export { KeletExporter, type KeletExporterOptions } from './exporter';
export { signal, SignalError, type SignalOptions } from './signal';
export { configure, type KeletConfig, type KeletConfigOptions } from './config';
export { SignalSource, SignalVote } from './types';
