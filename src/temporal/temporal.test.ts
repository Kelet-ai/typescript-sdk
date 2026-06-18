/**
 * Tests for ``kelet/temporal`` — KeletPlugin + interceptors.
 *
 * Mirrors the Python test structure (classes A–I per the design diagram) but
 * uses ``bun:test`` ``describe`` blocks since TS doesn't have pytest classes.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { defaultPayloadConverter, type Headers } from '@temporalio/common';
import { Resource } from '@opentelemetry/resources';
import { NoopSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  OpenTelemetryPlugin,
  OpenTelemetryWorkflowClientInterceptor,
} from '@temporalio/interceptors-opentelemetry';

import { agenticSession } from '../context';
import {
  SESSION_HEADER,
  USER_HEADER,
  METADATA_HEADER,
  inject,
  extract,
} from './headers';
import { buildClientInterceptor } from './client-interceptors';
import { buildActivityInterceptorsFactory } from './activity-interceptors';
import { KeletPlugin } from './index';

// ───────────────── helpers ─────────────────

function _decodePayloadString(headers: Headers, key: string): string {
  const p = headers[key];
  if (p === undefined) throw new Error(`header ${key} missing`);
  return defaultPayloadConverter.fromPayload<string>(p);
}

function _decodePayloadObject(headers: Headers, key: string): unknown {
  const p = headers[key];
  if (p === undefined) throw new Error(`header ${key} missing`);
  return defaultPayloadConverter.fromPayload<unknown>(p);
}

function _otelOpts() {
  return {
    resource: new Resource({}),
    spanProcessor: new NoopSpanProcessor(),
  };
}

const _capturedConsole: { warns: unknown[][]; infos: unknown[][] } = {
  warns: [],
  infos: [],
};
let _originalWarn: typeof console.warn;
let _originalInfo: typeof console.info;

beforeEach(() => {
  _capturedConsole.warns = [];
  _capturedConsole.infos = [];
  _originalWarn = console.warn;
  _originalInfo = console.info;
  console.warn = (...args: unknown[]) => _capturedConsole.warns.push(args);
  console.info = (...args: unknown[]) => _capturedConsole.infos.push(args);
});
afterEach(() => {
  console.warn = _originalWarn;
  console.info = _originalInfo;
});

// ───────────────── headers (low-level) ─────────────────

describe('headers: inject/extract roundtrip', () => {
  test('inject returns headers unchanged when payload is undefined', () => {
    const orig: Headers = {};
    expect(inject(orig, undefined)).toBe(orig);
  });

  test('roundtrip session only', () => {
    const out = inject({}, { sessionId: 'sess-1' });
    expect(SESSION_HEADER in out).toBe(true);
    expect(USER_HEADER in out).toBe(false);
    expect(METADATA_HEADER in out).toBe(false);
    expect(extract(out)).toEqual({
      sessionId: 'sess-1',
      userId: undefined,
      metadata: undefined,
    });
  });

  test('roundtrip with user and metadata', () => {
    const meta = { tier: 'pro', count: 42 };
    const out = inject({}, { sessionId: 'sess-1', userId: 'u-1', metadata: meta });
    expect(extract(out)).toEqual({
      sessionId: 'sess-1',
      userId: 'u-1',
      metadata: meta,
    });
  });

  test('extract returns undefined when no session header', () => {
    expect(extract({})).toBeUndefined();
  });
});

// ───────────────── A. Client outbound ─────────────────

describe('A. Client outbound', () => {
  test('A1: agenticSession set → start stamps header', async () => {
    const client = buildClientInterceptor();
    const next = mock(async (_input: unknown) => 'wf-run-id');
    await agenticSession({ sessionId: 'sess-A1' }, async () => {
      await client.start!({ workflowType: 'W', headers: {}, options: {} } as never, next);
    });
    const forwarded = next.mock.calls[0]![0] as { headers: Headers };
    expect(_decodePayloadString(forwarded.headers, SESSION_HEADER)).toBe('sess-A1');
  });

  test('A2: no agenticSession → no header', async () => {
    const client = buildClientInterceptor();
    const next = mock(async (_input: unknown) => 'wf-run-id');
    await client.start!(
      { workflowType: 'W', headers: {}, options: { workflowId: 'wf-1' } } as never,
      next,
    );
    const forwarded = next.mock.calls[0]![0] as { headers: Headers };
    expect(SESSION_HEADER in forwarded.headers).toBe(false);
  });

  test('A3: session + user + metadata all stamped', async () => {
    const client = buildClientInterceptor();
    const next = mock(async (_input: unknown) => 'wf-run-id');
    await agenticSession(
      { sessionId: 'sess-A3', userId: 'user-7', metadata: { tier: 'pro', count: 42 } },
      async () => {
        await client.start!(
          { workflowType: 'W', headers: {}, options: { workflowId: 'wf-1' } } as never,
          next,
        );
      },
    );
    const forwarded = next.mock.calls[0]![0] as { headers: Headers };
    expect(_decodePayloadString(forwarded.headers, SESSION_HEADER)).toBe('sess-A3');
    expect(_decodePayloadString(forwarded.headers, USER_HEADER)).toBe('user-7');
    expect(_decodePayloadObject(forwarded.headers, METADATA_HEADER)).toEqual({
      tier: 'pro',
      count: 42,
    });
  });

  test('A4: no agenticSession + no callable → no header', async () => {
    // Client autoSession is callable-only now: a bare client (no
    // ``agenticSession`` wrapping, no callable resolver) emits no
    // SESSION_HEADER even with a workflowId set. Run-ID-based derivation
    // happens worker-side via ``activityAutoSession: true``.
    const client = buildClientInterceptor();
    const next = mock(async (_input: unknown) => 'wf-run-id');
    await client.start!(
      {
        workflowType: 'W',
        headers: {},
        options: { workflowId: 'acme/prod/session/sess-A4' },
      } as never,
      next,
    );
    const forwarded = next.mock.calls[0]![0] as { headers: Headers };
    expect(SESSION_HEADER in forwarded.headers).toBe(false);
  });

  test('A5: autoSession=callable invoked with workflowType + workflowId', async () => {
    const captured: { workflowType: string; workflowId: string }[] = [];
    const client = buildClientInterceptor((info) => {
      captured.push(info);
      return `derived-${info.workflowId}`;
    });
    const next = mock(async (_input: unknown) => 'wf-run-id');
    await client.start!(
      { workflowType: 'MyWf', headers: {}, options: { workflowId: 'wf-id-99' } } as never,
      next,
    );
    expect(captured).toEqual([{ workflowType: 'MyWf', workflowId: 'wf-id-99' }]);
    const forwarded = next.mock.calls[0]![0] as { headers: Headers };
    expect(_decodePayloadString(forwarded.headers, SESSION_HEADER)).toBe('derived-wf-id-99');
  });

  test('A5b: autoSession=callable with missing workflowId does not throw — server-generated IDs are common', async () => {
    // Temporal's WorkflowStartInput.options.workflowId is optional. When the
    // user calls client.start({ workflowType: 'X' }) without an explicit ID,
    // Temporal server generates one. We can't derive client-side, so skip.
    const client = buildClientInterceptor((info) => `derived-${info.workflowId}`);
    const next = mock(async (_input: unknown) => 'wf-run-id');
    await expect(
      client.start!(
        // workflowId is intentionally undefined here.
        { workflowType: 'MyWf', headers: {}, options: {} } as never,
        next,
      ),
    ).resolves.toBe('wf-run-id');
    const forwarded = next.mock.calls[0]![0] as { headers: Headers };
    expect(SESSION_HEADER in forwarded.headers).toBe(false);
  });

  test('A6: signal stamps header from agenticSession', async () => {
    const client = buildClientInterceptor();
    const next = mock(async (_input: unknown) => undefined);
    await agenticSession({ sessionId: 'sess-A6' }, async () => {
      await client.signal!(
        { signalName: 's', args: [], workflowExecution: { workflowId: 'w' }, headers: {} } as never,
        next,
      );
    });
    const forwarded = next.mock.calls[0]![0] as { headers: Headers };
    expect(_decodePayloadString(forwarded.headers, SESSION_HEADER)).toBe('sess-A6');
  });
});

// ───────────────── E. Activity inbound ─────────────────
// (Workflow-side B/C/D/F are exercised at runtime inside the workflow VM only.
//  Without spinning up a TestWorkflowEnvironment, we cover them via headers.ts
//  unit tests above and the workflow-interceptors module compilation check.)

describe('E. Activity inbound', () => {
  function _stubCtx(workflowId = 'acme/prod/session/sess-E') {
    return {
      info: {
        workflowExecution: { workflowId, runId: 'run-1' },
        workflowType: 'W',
        activityId: 'act-1',
      },
    } as never;
  }

  test('E1: header → opens agenticSession', async () => {
    const factory = buildActivityInterceptorsFactory(false);
    const interceptors = factory(_stubCtx());
    const inbound = interceptors.inbound!;
    const next = mock(async (_input: unknown) => {
      return { sessionId: undefined as string | undefined };
    });
    // Capture session inside next:
    const seen: string[] = [];
    const capturingNext = async () => {
      const { getSessionId } = await import('../context');
      seen.push(getSessionId() ?? '<none>');
    };
    await inbound.execute!(
      {
        args: [],
        headers: inject({}, { sessionId: 'sess-E1', userId: 'u-1' }),
      },
      capturingNext as never,
    );
    expect(seen).toEqual(['sess-E1']);
    expect(next.mock.calls.length).toBe(0); // unused
  });

  test('E2: no header + autoSession=true → derives from runId', async () => {
    const factory = buildActivityInterceptorsFactory(true);
    const interceptors = factory(_stubCtx());
    const inbound = interceptors.inbound!;
    const seen: string[] = [];
    const capturingNext = async () => {
      const { getSessionId } = await import('../context');
      seen.push(getSessionId() ?? '<none>');
    };
    await inbound.execute!({ args: [], headers: {} }, capturingNext as never);
    // ``_stubCtx`` stubs ``runId: 'run-1'``; with the new run-ID-based
    // semantics, that's what we should see.
    expect(seen).toEqual(['run-1']);
  });

  test('E3: no header + autoSession=false → passes through', async () => {
    const factory = buildActivityInterceptorsFactory(false);
    const interceptors = factory(_stubCtx());
    const inbound = interceptors.inbound!;
    const seen: string[] = [];
    const capturingNext = async () => {
      const { getSessionId } = await import('../context');
      seen.push(getSessionId() ?? '<none>');
    };
    await inbound.execute!({ args: [], headers: {} }, capturingNext as never);
    expect(seen).toEqual(['<none>']);
  });

  test('E4: header wins over autoSession=true (one-session-per-chain)', async () => {
    // When an inbound header IS present AND ``activityAutoSession: true``
    // is configured, the header session takes precedence over the run-ID
    // fallback. This pins the one-session-per-chain guarantee — downstream
    // hops inherit the first run's session rather than minting their own
    // run-ID-derived session.
    const factory = buildActivityInterceptorsFactory(true);
    const interceptors = factory(_stubCtx());
    const inbound = interceptors.inbound!;
    const seen: string[] = [];
    const capturingNext = async () => {
      const { getSessionId } = await import('../context');
      seen.push(getSessionId() ?? '<none>');
    };
    await inbound.execute!(
      {
        args: [],
        headers: inject({}, { sessionId: 'sess-from-header' }),
      },
      capturingNext as never,
    );
    // Header wins over the stubbed ``runId: 'run-1'``.
    expect(seen).toEqual(['sess-from-header']);
  });
});

// ───────────────── G. Plugin composition ─────────────────

describe('G. Plugin composition', () => {
  test('G1: includeOtelPlugin=true (default) configures OTel into client', () => {
    const plugin = new KeletPlugin({ otelPluginOptions: _otelOpts() });
    const out = plugin.configureClient({ connection: {} as never });
    const interceptors = out.interceptors;
    const wf = Array.isArray(interceptors?.workflow) ? interceptors!.workflow! : [];
    expect(
      wf.some((i) => i instanceof OpenTelemetryWorkflowClientInterceptor),
    ).toBe(true);
  });

  test('G1b: includeOtelPlugin=true requires otelPluginOptions', () => {
    expect(() => new KeletPlugin()).toThrow(
      /requires.*otelPluginOptions/i,
    );
  });

  test('G2: includeOtelPlugin=false + no other OTel → warn', () => {
    const plugin = new KeletPlugin({ includeOtelPlugin: false });
    plugin.configureClient({ connection: {} as never });
    const warns = _capturedConsole.warns.flat().map(String);
    expect(
      warns.some((m) =>
        m.includes('includeOtelPlugin=false') && m.includes('not be linked'),
      ),
    ).toBe(true);
  });

  test('G3: includeOtelPlugin=false but OTel already present → no warning', () => {
    const plugin = new KeletPlugin({ includeOtelPlugin: false });
    const otelPlugin = new OpenTelemetryPlugin(_otelOpts());
    let cfg = otelPlugin.configureClient({ connection: {} as never });
    cfg = plugin.configureClient(cfg);
    const warns = _capturedConsole.warns.flat().map(String);
    expect(warns.some((m) => m.includes('includeOtelPlugin=false'))).toBe(false);
  });

  test('G4: two plugin instances retain independent autoSession', async () => {
    // Plugin-A: activity-side run-ID auto-derivation (the new ``true`` semantics
    // live worker-side now). Plugin-B: client-side callable resolver.
    const a = new KeletPlugin({
      activityAutoSession: true,
      otelPluginOptions: _otelOpts(),
    });
    const b = new KeletPlugin({
      autoSession: (info) => `custom-${info.workflowId}`,
      otelPluginOptions: _otelOpts(),
    });

    // --- Plugin-A: verify worker-side run-ID resolution ---
    // Pull plugin-A's activity inbound factory off configureWorker output and
    // exercise it with no header → expect runId-based session.
    const workerCfgA = a.configureWorker({
      taskQueue: 'tq',
      workflowsPath: '/dev/null',
    } as never);
    const activityFactoriesA = workerCfgA.interceptors?.activity ?? [];
    // KeletPlugin appends its activity factory last, after any existing ones.
    const factoryA = activityFactoriesA[activityFactoriesA.length - 1]!;
    const inboundA = factoryA({
      info: {
        workflowExecution: { workflowId: 'wfA-id', runId: 'run-A' },
        workflowType: 'W',
        activityId: 'act-1',
      },
    } as never).inbound!;
    const seenA: string[] = [];
    await inboundA.execute!(
      { args: [], headers: {} },
      (async () => {
        const { getSessionId } = await import('../context');
        seenA.push(getSessionId() ?? '<none>');
      }) as never,
    );
    expect(seenA).toEqual(['run-A']);

    // --- Plugin-B: verify client-side callable resolution (unchanged behavior) ---
    const cfgB = b.configureClient({ connection: {} as never });
    const wfB = Array.isArray(cfgB.interceptors?.workflow)
      ? cfgB.interceptors!.workflow!
      : [];
    const nextB = mock(async (_i: unknown) => 'wfB');
    // KeletPlugin appends its client interceptor last, after any existing ones.
    const keletB = wfB[wfB.length - 1]!;
    await keletB.start!(
      { workflowType: 'W', headers: {}, options: { workflowId: 'acme/session/X' } } as never,
      nextB,
    );
    const headersB = (nextB.mock.calls[0]![0] as { headers: Headers }).headers;
    expect(_decodePayloadString(headersB, SESSION_HEADER)).toBe('custom-acme/session/X');
  });

  test('G6: existing OpenTelemetryWorkflowClientInterceptor → bundled OTel skipped', () => {
    const plugin = new KeletPlugin({ otelPluginOptions: _otelOpts() });
    const otelPlugin = new OpenTelemetryPlugin(_otelOpts());

    // First the user runs OTel plugin (registering its interceptor)
    let cfg = otelPlugin.configureClient({ connection: {} as never });
    // Then KeletPlugin
    cfg = plugin.configureClient(cfg);

    const interceptors = cfg.interceptors;
    const wf = Array.isArray(interceptors?.workflow) ? interceptors!.workflow! : [];
    const otelCount = wf.filter(
      (i) => i instanceof OpenTelemetryWorkflowClientInterceptor,
    ).length;
    expect(otelCount).toBe(1); // bundled OTel was skipped, only user's remains
    const infos = _capturedConsole.infos.flat().map(String);
    expect(
      infos.some((m) => m.includes('skipping bundled OpenTelemetryPlugin')),
    ).toBe(true);
  });
});

// ───────────────── workflow-interceptors module ─────────────────

describe('workflow-interceptors module', () => {
  // Loaded via require to mirror how the worker loads it via workflowsPath.
  // We cannot exercise it fully without a TestWorkflowEnvironment, but a
  // smoke import + factory call ensures the file compiles and conforms to
  // the WorkflowInterceptorsFactory shape.
  test('exports an interceptors factory returning {inbound, outbound}', async () => {
    const mod = (await import('./workflow-interceptors')) as {
      interceptors: () => {
        inbound?: unknown[];
        outbound?: unknown[];
      };
    };
    const { inbound, outbound } = mod.interceptors();
    expect(Array.isArray(inbound)).toBe(true);
    expect(Array.isArray(outbound)).toBe(true);
    expect(inbound!.length).toBe(1);
    expect(outbound!.length).toBe(1);
  });
});

// ───────────────── workflow run-ID auto-session enabler ─────────────────

describe('workflow-autosession enabler', () => {
  // The workflow VM is isolated, so KeletPlugin can't pass the flag in — it
  // signals "enabled" by adding this module to workflowModules. Importing it
  // here mimics the VM loading it: the top-level side effect flips the flag.
  test('importing the enabler sets the VM-global flag', async () => {
    const mod = (await import('./workflow-autosession')) as {
      isRunIdAutoSessionEnabled: () => boolean;
    };
    expect(mod.isRunIdAutoSessionEnabled()).toBe(true);
  });
});

// ───────────────── G2. activityAutoSession gates the enabler module ─────────

describe('G. Plugin composition — run-ID enabler wiring', () => {
  function _workflowModules(plugin: KeletPlugin): string[] {
    const out = plugin.configureWorker({ workflowsPath: 'x', taskQueue: 't' } as never);
    return (out.interceptors?.workflowModules ?? []) as string[];
  }

  test('G5: activityAutoSession=true appends the autosession enabler module', () => {
    const mods = _workflowModules(new KeletPlugin({ activityAutoSession: true, includeOtelPlugin: false }));
    expect(mods.some((m) => m.includes('workflow-interceptors'))).toBe(true);
    expect(mods.some((m) => m.includes('workflow-autosession'))).toBe(true);
  });

  test('G6: activityAutoSession unset → no autosession enabler module', () => {
    const mods = _workflowModules(new KeletPlugin({ includeOtelPlugin: false }));
    expect(mods.some((m) => m.includes('workflow-interceptors'))).toBe(true);
    expect(mods.some((m) => m.includes('workflow-autosession'))).toBe(false);
  });

  test('G7: activityAutoSession=callable → no enabler (run-ID fallback is the boolean-only path)', () => {
    const mods = _workflowModules(new KeletPlugin({ activityAutoSession: () => 's', includeOtelPlugin: false }));
    expect(mods.some((m) => m.includes('workflow-autosession'))).toBe(false);
  });
});
