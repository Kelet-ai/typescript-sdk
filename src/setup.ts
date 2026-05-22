/**
 * SDK setup with automatic OTEL pipeline configuration.
 * @module setup
 */

import { type ContextManager, trace } from '@opentelemetry/api';
// Static import of our own sibling module — always ESM-resolvable — so
// ``_autoInstallReasoningObserver`` doesn't reach for ``require()`` on
// our own code. The third-party ``@anthropic-ai/claude-agent-sdk``
// remains an optional dynamic lookup (see ``_autoInstallReasoningObserver``).
import {
  buildKeletLoggerProvider,
  installReasoningObserver,
  REASONING_SCOPE_NAME,
  setReasoningLogger,
  type ClaudeAgentSDKModule,
} from './claude-agent-sdk';
import {
  configure as setConfig,
  resolveConfig,
  setSharedConfig,
  type KeletConfig,
  type KeletConfigOptions,
} from './config';
import { KeletSpanProcessor } from './processor';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  SimpleSpanProcessor,
  BasicTracerProvider,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
// ``LoggerProvider`` is still referenced for the ``_loggerProvider`` handle
// + shutdown; the actual provider + exporter construction lives inside
// ``src/claude-agent-sdk/index.ts`` so callers who don't use the Claude
// Agent SDK integration don't pay for the OTLP logs exporter setup.
import {
  LoggerProvider,
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
  /**
   * Auto-inject the seven Claude Code OTLP env vars (CLAUDE_CODE_ENABLE_TELEMETRY,
   * OTEL_LOGS_EXPORTER, OTEL_METRICS_EXPORTER, OTEL_TRACES_EXPORTER,
   * OTEL_EXPORTER_OTLP_PROTOCOL, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS)
   * so the spawned `claude` subprocess routes telemetry to Kelet.
   *
   * Set `false` to opt out — useful when the host process already routes CC
   * telemetry to a different OTLP backend (Sentry, Datadog, custom collector)
   * and Kelet should NOT redirect it. Existing process.env values are never
   * overridden either way; opting out only suppresses the deferred-warning log.
   *
   * @default true
   */
  injectCcTelemetry?: boolean;
  /**
   * Auto-register the `@ai-sdk/otel` integration (gen_ai semconv) when both
   * `ai` (>= 6.0.74) and `@ai-sdk/otel` are resolvable. Captures
   * `gen_ai.input.messages`, `gen_ai.output.messages` (with reasoning parts),
   * `gen_ai.system_instructions`, etc., on every `generateText` / `streamText`
   * call without per-call `experimental_telemetry` boilerplate.
   *
   * Set `false` to opt out — useful when the host already calls
   * `registerTelemetryIntegration()` manually with a custom `OpenTelemetry`
   * config (e.g., a non-default tracer or `enrichSpan` callback).
   *
   * @default true
   */
  injectAiSdkTelemetry?: boolean;
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

/**
 * Build the OTel ``Resource`` attached to the Kelet-owned trace and log
 * providers. Single source of truth for ``service.name`` and the
 * ``kelet.project`` attribute so the two providers can't drift.
 */
function _buildKeletResource(config: KeletConfig): Resource {
  return new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: config.project || 'kelet',
    'kelet.project': config.project,
  });
}

/**
 * Best-effort construction of an async-context-manager so the OTel
 * context API can propagate the active span across ``await`` boundaries
 * in Node.js. Returns ``undefined`` in environments where:
 *
 * - ``async_hooks`` is unavailable (some edge runtimes).
 * - ``AsyncLocalStorage`` itself can't be enabled.
 *
 * Falling back to ``undefined`` keeps the previous behavior (``NoopContextManager``)
 * so we never crash a host that runs in an unusual JS runtime.
 */
function _maybeBuildAsyncContextManager(): ContextManager | undefined {
  try {
    return new AsyncLocalStorageContextManager().enable();
  } catch (err) {
    if (process.env.KELET_DEBUG) {
      console.warn(
        '[kelet] AsyncLocalStorageContextManager could not be enabled; ' +
          'parent-child span propagation across await boundaries may break. Cause:',
        err,
      );
    }
    return undefined;
  }
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
  const {
    tracerProvider,
    spanProcessor,
    strict = false,
    injectCcTelemetry = true,
    injectAiSdkTelemetry = true,
    ...configOptions
  } = options;

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
    // Even when Kelet credentials are missing, run Layer A so the soft-warning
    // path can fire on `injectCcTelemetry: false` + missing env. Layer A
    // returns early when config is null — see configurePopulateProcessEnv.
    void _installClaudeAgentSDK(null, injectCcTelemetry);
    return;
  }

  setSharedConfig(config);

  void _installClaudeAgentSDK(config, injectCcTelemetry);

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

  // Shared Resource used by both the trace provider (when we own it) and
  // the logger provider below. Keeping a single source of truth prevents
  // ``service.name`` / ``kelet.project`` from drifting if they ever gain
  // additional attributes.
  const keletResource = _buildKeletResource(config);

  if (tracerProvider) {
    tracerProvider.addSpanProcessor(processor);
  } else {
    // Newer @opentelemetry/exporter-trace-otlp-http serializers dereference
    // ``span.resource`` during export; a provider built without an explicit
    // Resource crashes with ``Cannot read properties of undefined (reading
    // 'name')``. Stamp a minimal Resource with a sensible service.name
    // default derived from the Kelet project slug.
    _provider = new BasicTracerProvider({ resource: keletResource });
    _provider.addSpanProcessor(processor);
    // ``BasicTracerProvider.register()`` without an explicit
    // ``contextManager`` falls back to OTel's ``NoopContextManager``, which
    // breaks parent-child span propagation across ``await`` boundaries —
    // every nested span becomes the root of a fresh trace. ``NodeTracerProvider``
    // installs ``AsyncLocalStorageContextManager`` automatically, but we use
    // ``BasicTracerProvider`` (smaller dep surface). Install it manually on
    // Node so AI SDK / multi-step generations link into a single trace.
    const contextManager = _maybeBuildAsyncContextManager();
    _provider.register(contextManager ? { contextManager } : undefined);
  }

  _activeProcessors.push(processor);

  // NOTE: ``configure()`` used to unconditionally build a
  // ``LoggerProvider`` and register it on the OTel global here, which
  // (a) clobbered host-app logging pipelines (Datadog, Sentry, Grafana)
  // and (b) wasted allocations for callers that didn't use the Claude
  // Agent SDK integration. Both concerns are addressed by lazy-building
  // the provider only inside ``_autoInstallReasoningObserver`` when the
  // CC integration is actually installed. See
  // ``buildKeletLoggerProvider`` in ``src/claude-agent-sdk/index.ts``.

  _autoInstallReasoningObserver(config, keletResource);

  if (injectAiSdkTelemetry) {
    void _installAiSdkOtel();
  }

  _registerExitHooks();
  _configured = true;
}

/**
 * Best-effort auto-registration of the ``@ai-sdk/otel`` telemetry
 * integration when both ``ai`` and ``@ai-sdk/otel`` resolve. Calls
 * ``registerTelemetryIntegration(new OpenTelemetry())`` so every
 * ``generateText`` / ``streamText`` call emits gen_ai semconv attributes
 * (``gen_ai.input.messages``, ``gen_ai.output.messages`` with reasoning
 * parts, ``gen_ai.system_instructions``, ``gen_ai.provider.name``,
 * ``gen_ai.operation.name``) on the global tracer provider Kelet just
 * registered.
 *
 * Skips silently when ``ai`` isn't a dep (consumer not using AI SDK).
 * Logs a soft hint when ``ai`` resolves but ``@ai-sdk/otel`` doesn't,
 * suggesting ``npm i @ai-sdk/otel`` for richer capture.
 *
 * Failure is swallowed — host app doesn't depend on this succeeding.
 */
async function _installAiSdkOtel(): Promise<void> {
  let aiMod: Record<string, unknown> | undefined;
  try {
    aiMod = (await import('ai')) as unknown as Record<string, unknown>;
  } catch {
    // Consumer doesn't use the AI SDK — silent skip.
    return;
  }

  const register = aiMod.registerTelemetryIntegration as
    | ((i: unknown) => void)
    | undefined;
  if (typeof register !== 'function') {
    if (process.env.KELET_DEBUG) {
      console.warn(
        '[kelet] @ai-sdk/otel auto-registration skipped: `ai` is < 6.0.74 ' +
          '(missing registerTelemetryIntegration). Upgrade to ai@^6.0.74 ' +
          'for gen_ai semconv capture.',
      );
    }
    return;
  }

  let otelMod: Record<string, unknown> | undefined;
  try {
    otelMod = (await import('@ai-sdk/otel')) as unknown as Record<
      string,
      unknown
    >;
  } catch {
    console.warn(
      '[kelet] AI SDK detected but `@ai-sdk/otel` is not installed — ' +
        'gen_ai semconv telemetry disabled. Run `npm i @ai-sdk/otel` ' +
        'to enable richer capture, or pass `injectAiSdkTelemetry: false` ' +
        'to suppress this warning.',
    );
    return;
  }

  const OpenTelemetry = otelMod.OpenTelemetry as
    | (new () => unknown)
    | undefined;
  if (typeof OpenTelemetry !== 'function') {
    if (process.env.KELET_DEBUG) {
      console.warn(
        '[kelet] @ai-sdk/otel resolved but does not export OpenTelemetry — ' +
          'auto-registration skipped.',
      );
    }
    return;
  }

  try {
    register(new OpenTelemetry());
  } catch (err) {
    if (process.env.KELET_DEBUG) {
      console.warn('[kelet] @ai-sdk/otel auto-registration failed:', err);
    }
  }
}

/**
 * Best-effort auto-install of the ``kelet.reasoning`` observer on
 * ``@anthropic-ai/claude-agent-sdk`` when it's resolvable. Failure is
 * swallowed — the host app doesn't depend on the SDK being installed.
 *
 * This is ALSO the only code path that provisions Kelet's OTLP logger
 * export. If the host doesn't use Claude Agent SDK, no ``LoggerProvider``
 * is built and no ``BatchLogRecordProcessor`` holds open network/memory
 * resources. Host-app log pipelines are left alone unconditionally —
 * Kelet never touches ``logsApi.setGlobalLoggerProvider``.
 *
 * ESM safety
 * ----------
 * We can't call ``require('@anthropic-ai/claude-agent-sdk')`` under
 * strict Node ESM (throws ``ERR_REQUIRE_ESM``). Node's CJS-compat
 * ``createRequire`` fails the same way on ESM-only packages. Use a
 * dynamic ``import()`` instead, and kick it off fire-and-forget so
 * ``configure()`` stays synchronous for the rest of its body.
 *
 * If ``configure()`` runs before the host's ``claude-agent-sdk`` module
 * is loaded, users can still install the observer + logger explicitly
 * at any later point:
 *
 * ```ts
 *   import * as sdk from '@anthropic-ai/claude-agent-sdk';
 *   import {
 *     installReasoningObserver,
 *     buildKeletLoggerProvider,
 *     setReasoningLogger,
 *     REASONING_SCOPE_NAME,
 *   } from 'kelet/claude-agent-sdk';
 *   installReasoningObserver(sdk);
 * ```
 *
 * ``docs/claude-agent-sdk.md`` spells out this manual recipe alongside
 * the Next.js / ESM caveats.
 */
function _autoInstallReasoningObserver(
  config: KeletConfig,
  resource: Resource,
): void {
  // Our own sibling module is imported statically at the top of the
  // file — ESM resolves it regardless of host runtime semantics. We
  // only need the dynamic lookup for the optional third-party SDK.

  // Build + own the LoggerProvider *only* for the CC integration so
  // hosts that don't use Claude Agent SDK don't pay for an OTLP log
  // exporter they never use. This happens unconditionally because the
  // resolution of ``@anthropic-ai/claude-agent-sdk`` below is async —
  // we still want the provider ready by the time the user imports the
  // SDK and calls ``installReasoningObserver(sdk)`` manually if the
  // dynamic import races their first call.
  try {
    const { provider, processor } = buildKeletLoggerProvider({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      project: config.project,
      resource,
    });
    _loggerProvider = provider;
    _activeLogProcessors.push(processor);
    setReasoningLogger(provider.getLogger(REASONING_SCOPE_NAME));
  } catch (err) {
    if (process.env.KELET_DEBUG) {
      console.warn(
        '[kelet] failed to build Kelet LoggerProvider for claude-agent-sdk:',
        err,
      );
    }
  }

  // Fire-and-forget dynamic import. ESM-safe under Node strict mode and
  // under Bun; browser bundlers tree-shake it when the host doesn't
  // depend on ``@anthropic-ai/claude-agent-sdk``.
  //
  // ``@anthropic-ai/claude-agent-sdk`` is an OPTIONAL peer dep. Type
  // declarations resolve when the package is installed in dev/test;
  // production runtime guards via the Promise catch below.
  void import('@anthropic-ai/claude-agent-sdk')
    .then((sdk: unknown) => {
      installReasoningObserver(sdk as ClaudeAgentSDKModule);
    })
    .catch((err: unknown) => {
      if (process.env.KELET_DEBUG) {
        console.warn(
          '[kelet] auto-install of reasoning observer skipped. Call ' +
            'installReasoningObserver(sdk) explicitly if @anthropic-ai/claude-agent-sdk ' +
            'is installed. Cause:',
          err,
        );
      }
    });
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

/**
 * Two-layer Claude Agent SDK install.
 *
 * Layer A — populate `process.env` set-if-missing (always runs; cheap and
 * harmless even if `@anthropic-ai/claude-agent-sdk` isn't installed).
 *
 * Layer B — wrap public exports of `@anthropic-ai/claude-agent-sdk`. This
 * lazy-imports the package and silently skips when missing. Only catches
 * namespace-import patterns (`import * as cas from ...`) — destructured
 * users still need `kelet/claude-agent-sdk/register` (loader) or
 * `kelet/claude-agent-sdk/shim` (shim).
 *
 * Errors from either layer are caught and logged once; the SDK never blocks
 * `configure()` on an integration failure.
 */
async function _installClaudeAgentSDK(
  config: KeletConfig | null,
  injectCcTelemetry: boolean
): Promise<void> {
  // Layer A — process.env set-if-missing. Imported from envInjection directly
  // so a missing optional OTEL peer doesn't prevent process.env population.
  try {
    const { configurePopulateProcessEnv } = await import('./claude-agent-sdk/index');
    configurePopulateProcessEnv(config, { injectCcTelemetry });
  } catch (err) {
    console.warn('[kelet] CAS Layer A (process.env inject) failed:', err);
  }
  // Layer B — wrap public exports; needs OTEL peers for reasoning capture.
  if (config !== null) {
    try {
      const { installClaudeAgentSDK } = await import('./claude-agent-sdk/index');
      await installClaudeAgentSDK({ injectCcTelemetry });
    } catch (err) {
      console.warn('[kelet] CAS Layer B (wrapper install) failed:', err);
    }
  }
}
