/**
 * SDK setup with automatic OTEL pipeline configuration.
 * @module setup
 */

import { trace } from '@opentelemetry/api';
import { logs as logsApi } from '@opentelemetry/api-logs';
import {
  configure as setConfig,
  resolveConfig,
  setSharedConfig,
  type KeletConfig,
  type KeletConfigOptions,
} from './config';
import { KeletSpanProcessor } from './processor';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import {
  SimpleSpanProcessor,
  BasicTracerProvider,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  LoggerProvider,
  BatchLogRecordProcessor,
  type LogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

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
  /**
   * If `true`, re-raise errors on missing credentials instead of warning and
   * disabling telemetry. Missing `KELET_API_KEY` or `KELET_PROJECT` logs a
   * single warning and installs a no-op; `signal()` becomes a silent no-op
   * while `agenticSession()` still runs the callback with context but no
   * spans are exported.
   * @default false
   */
  strict?: boolean;
}

let _configured = false;
let _provider: BasicTracerProvider | undefined;
let _loggerProvider: LoggerProvider | undefined;
const _activeProcessors: SpanProcessor[] = [];
const _activeLogProcessors: LogRecordProcessor[] = [];
let _exitHooksRegistered = false;
let _warnedDisabled = false;

/**
 * Reset the warn-once flag. For testing only.
 * @internal
 */
export function _resetSetupWarnState(): void {
  _warnedDisabled = false;
}

function _registerExitHooks(): void {
  if (_exitHooksRegistered) return;
  _exitHooksRegistered = true;

  // Natural event-loop drain: async hook allowed, so span exporters can flush.
  // We deliberately do NOT register SIGINT/SIGTERM handlers — attaching a listener
  // suppresses Node's default exit-on-signal, and calling process.exit() from a
  // library would override the host app's graceful-shutdown logic. Callers who
  // want to flush on signals should install their own handler that awaits
  // shutdown() before exiting.
  process.once('beforeExit', () => {
    void shutdown();
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
 * Missing credentials are non-fatal by default: if `KELET_API_KEY` or
 * `KELET_PROJECT` cannot be resolved from args or env vars, `configure()`
 * logs a single warning and returns without installing the SDK. `signal()`
 * becomes a silent no-op; `agenticSession()` still runs the callback with
 * context but no spans are exported. Pass `strict: true` to fail-fast
 * instead (re-throws the original error).
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
  const { tracerProvider, spanProcessor, strict = false, ...configOptions } = options;

  // Always store partial config (for resolveConfig() priority chain etc.)
  setConfig(configOptions);

  if (_configured) return;

  let config: KeletConfig;
  try {
    config = resolveConfig(configOptions);
  } catch (err) {
    if (strict) throw err;
    if (!_warnedDisabled) {
      _warnedDisabled = true;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[kelet] Telemetry disabled: ${message} Host app will continue running; ` +
          `signal() becomes a silent no-op. Pass strict: true to configure() to fail-fast instead.`
      );
    }
    return;
  }

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
    // Newer @opentelemetry/exporter-trace-otlp-http serializers dereference
    // ``span.resource`` during export; a provider built without an explicit
    // Resource crashes with ``Cannot read properties of undefined (reading
    // 'name')``. Stamp a minimal Resource with a sensible service.name
    // default derived from the Kelet project slug.
    const resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: config.project || 'kelet',
      'kelet.project': config.project,
    });
    _provider = new BasicTracerProvider({ resource });
    _provider.addSpanProcessor(processor);
    _provider.register();
  }

  _activeProcessors.push(processor);

  // Install a LoggerProvider so the reasoning observer can emit OTLP log
  // records to Kelet (Claude Code redacts thinking text in its native OTLP,
  // so observer-emitted events go through this side channel). Mirror the
  // trace exporter: same base URL, same auth, different path (``/api/logs``).
  try {
    const logExporter = new OTLPLogExporter({
      url: `${config.apiUrl}/api/logs`,
      headers: {
        Authorization: config.apiKey,
        'X-Kelet-Project': config.project,
      },
    });
    const logProcessor = new BatchLogRecordProcessor(logExporter);
    _loggerProvider = new LoggerProvider({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: config.project || 'kelet',
        'kelet.project': config.project,
      }),
    });
    _loggerProvider.addLogRecordProcessor(logProcessor);
    logsApi.setGlobalLoggerProvider(_loggerProvider);
    _activeLogProcessors.push(logProcessor);
  } catch (err) {
    console.warn('[kelet] failed to install LoggerProvider:', err);
  }

  _autoInstallReasoningObserver();

  _registerExitHooks();
  _configured = true;
}

/**
 * Best-effort auto-install of the ``kelet.reasoning`` observer on
 * ``@anthropic-ai/claude-agent-sdk`` if it's resolvable. Failure is swallowed
 * — the host app doesn't depend on the SDK being installed.
 */
function _autoInstallReasoningObserver(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@anthropic-ai/claude-agent-sdk');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { installReasoningObserver } = require('./claude-agent-sdk');
    installReasoningObserver(sdk);
  } catch {
    // claude-agent-sdk not installed, or installer failed — silent.
  }
}

/**
 * Shut down the Kelet SDK and flush any pending spans.
 *
 * Called automatically on `beforeExit` (natural event-loop drain). Call it
 * manually from your own signal handlers or before an explicit `process.exit(N)`
 * — the SDK intentionally does not install signal handlers, so as not to
 * override the host app's graceful-shutdown logic.
 *
 * Errors from individual processors are logged and swallowed (best-effort).
 *
 * @example
 * ```typescript
 * // Flush on SIGINT/SIGTERM from your own handler:
 * process.on('SIGTERM', async () => {
 *   await shutdown();
 *   process.exit(143);
 * });
 * ```
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

  const logProcessors = _activeLogProcessors.splice(0, _activeLogProcessors.length);
  for (const processor of logProcessors) {
    try {
      await processor.shutdown();
    } catch (err) {
      console.warn('[kelet] log processor shutdown failed:', err);
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

  const loggerProvider = _loggerProvider;
  _loggerProvider = undefined;
  if (loggerProvider) {
    try {
      await loggerProvider.shutdown();
    } catch (err) {
      console.warn('[kelet] logger provider shutdown failed:', err);
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
  _activeLogProcessors.length = 0;
  _warnedDisabled = false;
  if (_provider) {
    void _provider.shutdown();
    _provider = undefined;
  }
  if (_loggerProvider) {
    void _loggerProvider.shutdown();
    _loggerProvider = undefined;
  }
  trace.disable();
  logsApi.disable();
}
