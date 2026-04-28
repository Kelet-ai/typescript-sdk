/**
 * SDK setup with automatic OTEL pipeline configuration.
 * @module setup
 */

import { trace } from '@opentelemetry/api';
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
  // Build an integration-scoped ``LoggerProvider`` for the reasoning
  // observer. Previously ``configure()`` called
  // ``logsApi.setGlobalLoggerProvider(_loggerProvider)`` which clobbered
  // whatever the host app (Datadog, Sentry, Grafana, etc.) had already
  // wired on the OTel global — the Kelet ingestion path never needed a
  // global provider since the reasoning observer in
  // ``src/claude-agent-sdk/index.ts`` can resolve its logger against a
  // module-local reference.
  //
  // The global slot is left alone. Host apps that want Kelet reasoning
  // logs to ALSO land in their provider can route them there by
  // attaching an extra ``LogRecordProcessor`` to it upstream of
  // ``configure()``; the Kelet-scoped provider is an additional sink,
  // not a replacement.
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
    _activeLogProcessors.push(logProcessor);
    _wireReasoningLogger(_loggerProvider);
  } catch (err) {
    console.warn('[kelet] failed to install LoggerProvider:', err);
  }

  _autoInstallReasoningObserver();

  _registerExitHooks();
  _configured = true;
}

/**
 * Resolve a ``Logger`` under the Kelet CC scope against ``provider`` and
 * register it with the reasoning observer so emissions go through the
 * integration-scoped provider instead of the OTel global.
 *
 * This keeps the global slot available for host applications that wire
 * their own logging pipelines (Datadog, Sentry, Grafana, etc.). Without
 * this, ``logsApi.setGlobalLoggerProvider(kelet)`` would silently lose
 * whatever provider the host installed.
 */
function _wireReasoningLogger(provider: LoggerProvider): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { REASONING_SCOPE_NAME, setReasoningLogger } = require('./claude-agent-sdk');
    const scopedLogger = provider.getLogger(REASONING_SCOPE_NAME);
    setReasoningLogger(scopedLogger);
  } catch (err) {
    // Don't break setup() — reasoning emissions will fall back to
    // ``logsApi.getLogger(...)`` which resolves against the global
    // provider (usually no-op in tests). Keep the error visible under
    // ``KELET_DEBUG`` so the fallback isn't silent in development.
    if (process.env.KELET_DEBUG) {
      console.warn('[kelet] failed to wire scoped reasoning logger:', err);
    }
  }
}

/**
 * Best-effort auto-install of the ``kelet.reasoning`` observer on
 * ``@anthropic-ai/claude-agent-sdk`` if it's resolvable. Failure is
 * swallowed — the host app doesn't depend on the SDK being installed.
 *
 * Note: ``require()`` inside ESM throws ``ERR_REQUIRE_ESM`` under strict
 * Node resolution when the target module is ESM-only. The catch swallows
 * that silently in production (graceful degradation: users call
 * ``installReasoningObserver(sdk)`` explicitly instead), but we surface
 * the error under ``KELET_DEBUG`` so the failure mode is visible when
 * users debug why reasoning observability seemed to no-op.
 */
function _autoInstallReasoningObserver(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@anthropic-ai/claude-agent-sdk');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { installReasoningObserver } = require('./claude-agent-sdk');
    installReasoningObserver(sdk);
  } catch (err) {
    if (process.env.KELET_DEBUG) {
      console.warn(
        '[kelet] auto-install of reasoning observer skipped. Call ' +
          'installReasoningObserver(sdk) explicitly if @anthropic-ai/claude-agent-sdk ' +
          'is installed. Cause:',
        err,
      );
    }
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
    // Unregister the scoped reasoning logger so the observer falls back
    // to the global provider on subsequent emits (usually no-op post-
    // shutdown, which is what we want).
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { setReasoningLogger } = require('./claude-agent-sdk');
      setReasoningLogger(null);
    } catch {
      // claude-agent-sdk entrypoint may not be importable in all envs
      // (e.g. during ``shutdown()`` after a failed ``configure()``).
    }
    void _loggerProvider.shutdown();
    _loggerProvider = undefined;
  }
  trace.disable();
  // NOTE: we deliberately DO NOT call ``logsApi.disable()``. That
  // resets the OTel global LoggerProvider to no-op, which would
  // clobber whatever the host app had wired there. The Kelet SDK
  // never set the global, so there's nothing for us to reset.
}
