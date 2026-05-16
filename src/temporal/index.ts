/**
 * KeletPlugin for Temporal — propagates the agentic-session through
 * Temporal headers across ``start`` → workflow → child workflow → activity.
 *
 * Mirrors the Python ``kelet.temporal.KeletPlugin``. Composes Temporal's own
 * ``OpenTelemetryPlugin`` (from ``@temporalio/interceptors-opentelemetry``)
 * by default so users get linked OTel traces for free; detect-and-skip if
 * a prior plugin already registered an OTel client interceptor; opt out via
 * ``new KeletPlugin({ includeOtelPlugin: false })``.
 *
 * ## Plugin ordering
 *
 * If you already use ``OpenTelemetryPlugin`` from
 * ``@temporalio/interceptors-opentelemetry``, register it **before**
 * ``KeletPlugin``:
 *
 * ```ts
 * plugins: [new OpenTelemetryPlugin({ resource, spanProcessor }), new KeletPlugin()]
 * ```
 *
 * Kelet detects the existing OTel client interceptor and skips its bundled
 * OTel plugin to avoid duplicate spans. If you register them in the opposite
 * order, set ``includeOtelPlugin: false`` explicitly:
 *
 * ```ts
 * plugins: [new KeletPlugin({ includeOtelPlugin: false }), new OpenTelemetryPlugin({...})]
 * ```
 */

import { fileURLToPath } from 'node:url';
import { SimplePlugin } from '@temporalio/plugin';
import type {
  ClientInterceptors,
  ClientOptions,
  WorkflowClientInterceptor,
} from '@temporalio/client';
import type {
  ReplayWorkerOptions,
  WorkerInterceptors,
  WorkerOptions,
} from '@temporalio/worker';
import {
  OpenTelemetryPlugin,
  OpenTelemetryWorkflowClientInterceptor,
  type OpenTelemetryPluginOptions,
} from '@temporalio/interceptors-opentelemetry';

import { shutdown as keletShutdown } from '../setup';
import { buildClientInterceptor } from './client-interceptors';
import { buildActivityInterceptorsFactory } from './activity-interceptors';
import type { ActivityAutoSession, ClientAutoSession } from './types';

export type { ActivityAutoSession, ClientAutoSession } from './types';
export { SESSION_HEADER, USER_HEADER, METADATA_HEADER } from './headers';

export interface KeletPluginOptions {
  /** Auto-derive a client-side session for outbound ``start_workflow`` calls
   * when the caller didn't wrap the start in ``agenticSession()``. Defaults
   * to ``false``. See {@link ClientAutoSession} for semantics. */
  readonly autoSession?: ClientAutoSession;
  /** Auto-derive an activity-side session when no inbound header is present.
   * Defaults to ``false``. Use this when you have workflows started via
   * non-TS clients / CLI / schedules — see {@link ActivityAutoSession}. */
  readonly activityAutoSession?: ActivityAutoSession;
  /** Bundle Temporal's ``OpenTelemetryPlugin`` so users get linked OTel
   * traces with no extra setup. Defaults to ``true``. Set to ``false`` if
   * you've configured OTel yourself. See module docstring for ordering
   * recommendations. */
  readonly includeOtelPlugin?: boolean;
  /** Options forwarded to the bundled ``OpenTelemetryPlugin``. Required
   * when ``includeOtelPlugin`` is ``true`` (it needs a resource +
   * spanProcessor). */
  readonly otelPluginOptions?: OpenTelemetryPluginOptions;
}

const _OTEL_CLIENT_INTERCEPTOR_NAMES = new Set([
  'OpenTelemetryWorkflowClientInterceptor',
  // Legacy alias kept for completeness; the package re-exports it under
  // both names in older releases.
  'OpenTelemetryWorkflowClientCallsInterceptor',
]);

function _hasExistingOtel(options: ClientOptions): boolean {
  const interceptors = options.interceptors as ClientInterceptors | undefined;
  if (!interceptors) return false;
  const wf = interceptors.workflow;
  const list: WorkflowClientInterceptor[] = Array.isArray(wf)
    ? wf
    : // legacy { calls: [...] } shape — not used for new-style detection
      [];
  return list.some(
    (i) =>
      i instanceof OpenTelemetryWorkflowClientInterceptor ||
      _OTEL_CLIENT_INTERCEPTOR_NAMES.has(i?.constructor?.name ?? ''),
  );
}

export class KeletPlugin extends SimplePlugin {
  private readonly _otelPlugin: OpenTelemetryPlugin | null;
  private readonly _includeOtelExplicit: boolean;
  private _otelWasSkipped = false;

  constructor(opts: KeletPluginOptions = {}) {
    const includeOtel = opts.includeOtelPlugin !== false; // default true

    if (includeOtel && !opts.otelPluginOptions) {
      throw new Error(
        'KeletPlugin: include_otel_plugin defaults to true, which requires ' +
          'otelPluginOptions ({ resource, spanProcessor }). Pass them, or ' +
          'set includeOtelPlugin: false to skip the bundled OTel plugin.',
      );
    }

    // ESM-safe sibling resolution. ``kelet`` ships as `"type": "module"`,
    // so ``require.resolve`` is unavailable at runtime. The bundled output
    // emits ``./workflow-interceptors.js`` next to ``./index.js``; ``new URL``
    // joins them relative to this module's location regardless of where the
    // package gets installed.
    const workflowInterceptorsPath = fileURLToPath(
      new URL('./workflow-interceptors.js', import.meta.url),
    );

    super({
      name: 'kelet.KeletPlugin',
      clientInterceptors: (existing): ClientInterceptors => {
        const merged: ClientInterceptors = { ...existing };
        const existingWf = Array.isArray(merged.workflow) ? merged.workflow : [];
        merged.workflow = [...existingWf, buildClientInterceptor(opts.autoSession ?? false)];
        return merged;
      },
      workerInterceptors: (existing): WorkerInterceptors => {
        const merged: WorkerInterceptors = { ...existing };
        const existingActivity = merged.activity ?? [];
        merged.activity = [
          ...existingActivity,
          buildActivityInterceptorsFactory(opts.activityAutoSession ?? false),
        ];
        const existingWfModules = merged.workflowModules ?? [];
        merged.workflowModules = [...existingWfModules, workflowInterceptorsPath];
        return merged;
      },
      runContext: async (next) => {
        try {
          await next();
        } finally {
          // Bound the flush — Issue 15 (15A). 10s mirrors the Python plugin.
          try {
            await Promise.race([
              keletShutdown(),
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error('kelet.shutdown timeout')), 10_000),
              ),
            ]);
          } catch (e) {
            // Best-effort flush; swallow timeout / errors so worker shutdown
            // is never blocked by Kelet telemetry.
            // eslint-disable-next-line no-console
            console.warn('[kelet] shutdown flush failed:', e);
          }
        }
      },
    });

    this._otelPlugin = includeOtel
      ? new OpenTelemetryPlugin(opts.otelPluginOptions!)
      : null;
    this._includeOtelExplicit = !includeOtel;
  }

  override configureClient(options: ClientOptions): ClientOptions {
    if (this._otelPlugin) {
      if (_hasExistingOtel(options)) {
        this._otelWasSkipped = true;
        // eslint-disable-next-line no-console
        console.info(
          '[kelet] KeletPlugin: detected existing OTel interceptor; skipping ' +
            'bundled OpenTelemetryPlugin. Set includeOtelPlugin: false to silence this.',
        );
      } else {
        options = this._otelPlugin.configureClient(options);
      }
    }
    options = super.configureClient(options);

    // Issue 4 (4A): warn when user opted out of bundled OTel and no OTel is
    // present elsewhere — workflow/activity spans won't be linked into one trace.
    if (this._includeOtelExplicit && !_hasExistingOtel(options)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[kelet] KeletPlugin: includeOtelPlugin=false but no OTel interceptor ' +
          'found on client. Workflow and activity spans will not be linked into ' +
          'one trace. Either set includeOtelPlugin: true or register your own OTel ' +
          'interceptor (e.g. OpenTelemetryPlugin) before KeletPlugin.',
      );
    }
    return options;
  }

  override configureWorker(options: WorkerOptions): WorkerOptions {
    if (this._otelPlugin && !this._otelWasSkipped) {
      options = this._otelPlugin.configureWorker(options);
    }
    return super.configureWorker(options);
  }

  override configureReplayWorker(options: ReplayWorkerOptions): ReplayWorkerOptions {
    if (this._otelPlugin && !this._otelWasSkipped) {
      options = this._otelPlugin.configureReplayWorker(options);
    }
    return super.configureReplayWorker(options);
  }
}
