/**
 * OpenTelemetry exporter for Kelet.
 * @module exporter
 */

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { type KeletConfigOptions, resolveConfig, setSharedConfig } from './config';

/**
 * Options for KeletExporter.
 */
export type KeletExporterOptions = KeletConfigOptions;

/**
 * OpenTelemetry trace exporter for Kelet.
 *
 * Extends OTLPTraceExporter with Kelet-specific configuration.
 * Use with Vercel AI SDK's telemetry configuration or any OpenTelemetry setup.
 *
 * @example
 * ```typescript
 * import { KeletExporter } from 'kelet';
 * import { NodeSDK } from '@opentelemetry/sdk-node';
 *
 * const exporter = new KeletExporter({
 *   apiKey: 'your-api-key',
 *   project: 'my-project',
 * });
 *
 * const sdk = new NodeSDK({
 *   traceExporter: exporter,
 * });
 * sdk.start();
 * ```
 *
 * @example
 * ```typescript
 * // With Vercel AI SDK
 * import { KeletExporter } from 'kelet';
 * import { experimental_telemetry } from 'ai';
 *
 * const exporter = new KeletExporter();
 *
 * const result = await generateText({
 *   model: openai('gpt-4'),
 *   prompt: 'Hello!',
 *   experimental_telemetry: {
 *     isEnabled: true,
 *   },
 * });
 * ```
 */
export class KeletExporter extends OTLPTraceExporter {
  constructor(options: KeletExporterOptions = {}) {
    const config = resolveConfig(options);

    super({
      url: `${config.apiUrl}/api/traces`,
      headers: {
        Authorization: config.apiKey,
        'X-Kelet-Project': config.project,
      },
    });

    // Share config with signal() and other SDK functions
    setSharedConfig(config);
  }
}
