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
  type SpanProcessor,
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
  /**
   * Use this SpanProcessor instead of creating the default Kelet one.
   * Useful for wrapping or filtering the default processor (e.g., for
   * self-referential monitoring scenarios where you want to gate exports
   * on an active session context).
   */
  spanProcessor?: SpanProcessor;
}

let _configured = false;
let _provider: BasicTracerProvider | undefined;
const _activeProcessors: SpanProcessor[] = [];
let _exitHooksRegistered = false;

function _registerExitHooks(): void {
  if (_exitHooksRegistered) return;
  _exitHooksRegistered = true;

  // Natural event-loop drain: async hook allowed, so span exporters can flush.
  process.once('beforeExit', () => {
    void shutdown();
  });

  // Signals. Our handler suppresses the default exit, so we must re-exit manually.
  process.once('SIGINT', async () => {
    try {
      await shutdown();
    } finally {
      process.exit(130);
    }
  });
  process.once('SIGTERM', async () => {
    try {
      await shutdown();
    } finally {
      process.exit(143);
    }
  });
}

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
  const { tracerProvider, spanProcessor, ...configOptions } = options;

  // Always store config (for signal(), resolveConfig(), etc.)
  setConfig(configOptions);

  // Set up OTEL pipeline (once)
  if (!_configured) {
    try {
      const config = resolveConfig(configOptions);
      setSharedConfig(config);

      let processor: SpanProcessor;
      if (spanProcessor !== undefined) {
        // Use provided processor — skips creating default exporter/KeletSpanProcessor
        processor = spanProcessor;
      } else {
        const exporter = new OTLPTraceExporter({
          url: `${config.apiUrl}/api/traces`,
          headers: {
            Authorization: config.apiKey,
            'X-Kelet-Project': config.project,
          },
        });

        // Cast needed due to duplicate @opentelemetry/sdk-trace-base versions in OTEL packages
        processor = new KeletSpanProcessor(new SimpleSpanProcessor(exporter as unknown as SpanExporter), {
          project: config.project,
        });
      }

      if (tracerProvider) {
        tracerProvider.addSpanProcessor(processor);
      } else {
        _provider = new BasicTracerProvider();
        _provider.addSpanProcessor(processor);
        _provider.register();
      }

      _activeProcessors.push(processor);
      _registerExitHooks();
      _configured = true;
    } catch {
      // Config not fully resolvable (e.g., no API key) — just store for later
    }
  }
}

/**
 * Shut down the Kelet SDK and flush any pending spans.
 *
 * Called automatically on `beforeExit`, `SIGINT`, and `SIGTERM`. Safe to call
 * manually — useful before an explicit `process.exit(N)`, which Node does not
 * expose an async hook for.
 *
 * Errors from individual processors are logged and swallowed (best-effort),
 * matching the Python SDK's `atexit` behavior.
 */
export async function shutdown(): Promise<void> {
  const processors = _activeProcessors.splice(0, _activeProcessors.length);
  for (const processor of processors) {
    try {
      await processor.shutdown();
    } catch (err) {
      console.warn('[kelet] processor shutdown failed:', err);
    }
  }

  // Capture and null out synchronously so a concurrent second shutdown() call
  // won't double-await the same provider instance.
  const provider = _provider;
  _provider = undefined;
  if (provider) {
    try {
      await provider.shutdown();
    } catch (err) {
      console.warn('[kelet] provider shutdown failed:', err);
    }
  }

  _configured = false;
}

/**
 * Reset setup state. Used for testing.
 * @internal
 */
export function resetSetup(): void {
  _configured = false;
  _activeProcessors.length = 0;
  if (_provider) {
    void _provider.shutdown();
    _provider = undefined;
  }
  trace.disable();
}
