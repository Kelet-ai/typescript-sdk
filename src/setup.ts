/**
 * SDK setup with automatic OTEL pipeline configuration.
 * @module setup
 */

import { trace } from '@opentelemetry/api';
import {
  configure as setConfig,
  resolveConfig,
  setSharedConfig,
  type KeletConfigOptions,
} from './config';
import { KeletSpanProcessor } from './processor';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  SimpleSpanProcessor,
  BasicTracerProvider,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';

/**
 * Options for {@link configure}.
 */
export interface ConfigureOptions extends KeletConfigOptions {
  /**
   * Existing TracerProvider to add the Kelet span processor to.
   * Must have an `addSpanProcessor` method (e.g., BasicTracerProvider or NodeTracerProvider).
   * If omitted, a new BasicTracerProvider is created and registered globally.
   */
  tracerProvider?: BasicTracerProvider;
}

let _configured = false;
let _provider: BasicTracerProvider | undefined;

/**
 * Configure the Kelet SDK and set up the OTEL tracing pipeline.
 *
 * This is the recommended way to initialize Kelet. It:
 * 1. Stores global config for `signal()` and other SDK functions
 * 2. Creates a KeletExporter + KeletSpanProcessor
 * 3. Registers with an existing or new TracerProvider
 *
 * If the config is not fully resolvable (e.g., no API key available),
 * only step 1 runs — the OTEL pipeline is not created.
 *
 * @param options - Configuration and optional TracerProvider
 *
 * @example
 * ```typescript
 * import { configure } from 'kelet';
 *
 * // Simplest setup — creates provider automatically
 * configure({
 *   apiKey: process.env.KELET_API_KEY,
 *   project: 'production',
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With an existing provider
 * import { configure } from 'kelet';
 * import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
 *
 * const provider = new NodeTracerProvider();
 * provider.register();
 *
 * configure({
 *   apiKey: process.env.KELET_API_KEY,
 *   project: 'production',
 *   tracerProvider: provider,
 * });
 * ```
 */
export function configure(options: ConfigureOptions = {}): void {
  const { tracerProvider, ...configOptions } = options;

  // Always store config (for signal(), resolveConfig(), etc.)
  setConfig(configOptions);

  // Set up OTEL pipeline (once)
  if (!_configured) {
    try {
      const config = resolveConfig(configOptions);
      setSharedConfig(config);

      const exporter = new OTLPTraceExporter({
        url: `${config.apiUrl}/api/traces`,
        headers: {
          Authorization: config.apiKey,
          'X-Kelet-Project': config.project,
        },
      });

      // Cast needed due to duplicate @opentelemetry/sdk-trace-base versions in OTEL packages
      const processor = new KeletSpanProcessor(new SimpleSpanProcessor(exporter as unknown as SpanExporter), {
        project: config.project,
      });

      if (tracerProvider) {
        tracerProvider.addSpanProcessor(processor);
      } else {
        _provider = new BasicTracerProvider();
        _provider.addSpanProcessor(processor);
        _provider.register();
      }

      _configured = true;
    } catch {
      // Config not fully resolvable (e.g., no API key) — just store for later
    }
  }
}

/**
 * Reset setup state. Used for testing.
 * @internal
 */
export function resetSetup(): void {
  _configured = false;
  if (_provider) {
    void _provider.shutdown();
    _provider = undefined;
  }
  trace.disable();
}
