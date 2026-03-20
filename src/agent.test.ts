import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  agenticSession,
  withAgent,
  getAgentName,
  SESSION_ID_ATTR,
  USER_ID_ATTR,
  AGENT_NAME_ATTR,
} from './context.ts';
import { KeletSpanProcessor } from './processor.ts';

describe('withAgent', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    const inner = new SimpleSpanProcessor(exporter);
    provider = new BasicTracerProvider();
    provider.addSpanProcessor(inner);
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  test('sets getAgentName inside callback and clears it after', () => {
    expect(getAgentName()).toBeUndefined();
    withAgent({ name: 'support-bot' }, () => {
      expect(getAgentName()).toBe('support-bot');
    });
    expect(getAgentName()).toBeUndefined();
  });

  test('getAgentName returns name inside withAgent, undefined outside', () => {
    expect(getAgentName()).toBeUndefined();

    withAgent({ name: 'my-agent' }, () => {
      expect(getAgentName()).toBe('my-agent');
    });

    expect(getAgentName()).toBeUndefined();
  });

  test('getAgentName returns name inside async withAgent', async () => {
    expect(getAgentName()).toBeUndefined();

    await withAgent({ name: 'async-agent' }, async () => {
      expect(getAgentName()).toBe('async-agent');
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(getAgentName()).toBe('async-agent');
    });

    expect(getAgentName()).toBeUndefined();
  });

  test('multi-agent: each withAgent block labeled correctly with no cross-contamination', () => {
    withAgent({ name: 'classifier' }, () => {
      expect(getAgentName()).toBe('classifier');
    });

    expect(getAgentName()).toBeUndefined();

    withAgent({ name: 'responder' }, () => {
      expect(getAgentName()).toBe('responder');
    });

    expect(getAgentName()).toBeUndefined();
  });

  test('nested withAgent: inner name overrides outer', () => {
    withAgent({ name: 'outer-agent' }, () => {
      expect(getAgentName()).toBe('outer-agent');

      withAgent({ name: 'inner-agent' }, () => {
        expect(getAgentName()).toBe('inner-agent');
      });

      expect(getAgentName()).toBe('outer-agent');
    });

    expect(getAgentName()).toBeUndefined();
  });

  test('sync throw inside withAgent cleans up agent context', () => {
    expect(getAgentName()).toBeUndefined();

    expect(() => {
      withAgent({ name: 'throwing-agent' }, () => {
        expect(getAgentName()).toBe('throwing-agent');
        throw new Error('sync error');
      });
    }).toThrow('sync error');

    expect(getAgentName()).toBeUndefined();
  });

  test('async rejection inside withAgent cleans up agent context', async () => {
    expect(getAgentName()).toBeUndefined();

    await expect(
      withAgent({ name: 'rejecting-agent' }, async () => {
        expect(getAgentName()).toBe('rejecting-agent');
        throw new Error('async error');
      })
    ).rejects.toThrow('async error');

    expect(getAgentName()).toBeUndefined();
  });
});

describe('withAgent with KeletSpanProcessor', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    const inner = new SimpleSpanProcessor(exporter);
    const keletProcessor = new KeletSpanProcessor(inner, { project: 'test-proj' });
    provider = new BasicTracerProvider();
    provider.addSpanProcessor(keletProcessor);
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  test('stamps agent_name on child spans via processor', () => {
    const tracer = provider.getTracer('test');

    withAgent({ name: 'support-bot' }, () => {
      const span = tracer.startSpan('llm-call');
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    const llmSpan = spans.find((s) => s.name === 'llm-call')!;
    expect(llmSpan).toBeDefined();
    expect(llmSpan.attributes[AGENT_NAME_ATTR]).toBe('support-bot');
  });

  test('inherits sessionId/userId from agenticSession context', () => {
    const tracer = provider.getTracer('test');

    agenticSession({ sessionId: 's1', userId: 'u1' }, () => {
      withAgent({ name: 'bot' }, () => {
        const span = tracer.startSpan('op');
        span.end();
      });
    });

    const spans = exporter.getFinishedSpans();
    const opSpan = spans.find((s) => s.name === 'op')!;
    expect(opSpan.attributes[SESSION_ID_ATTR]).toBe('s1');
    expect(opSpan.attributes[USER_ID_ATTR]).toBe('u1');
    expect(opSpan.attributes[AGENT_NAME_ATTR]).toBe('bot');
  });

  test('no gen_ai.agent.name on spans outside withAgent', () => {
    const tracer = provider.getTracer('test');

    const span = tracer.startSpan('outside');
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans[0]!.attributes[AGENT_NAME_ATTR]).toBeUndefined();
  });

  test('multi-agent: no cross-contamination between sequential agents', () => {
    const tracer = provider.getTracer('test');

    withAgent({ name: 'classifier' }, () => {
      const span = tracer.startSpan('classify-op');
      span.end();
    });

    withAgent({ name: 'responder' }, () => {
      const span = tracer.startSpan('respond-op');
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    const classifySpan = spans.find((s) => s.name === 'classify-op')!;
    const respondSpan = spans.find((s) => s.name === 'respond-op')!;

    expect(classifySpan.attributes[AGENT_NAME_ATTR]).toBe('classifier');
    expect(respondSpan.attributes[AGENT_NAME_ATTR]).toBe('responder');
  });

  test('span ends even when callback throws synchronously', () => {
    expect(() => {
      withAgent({ name: 'error-agent' }, () => {
        throw new Error('boom');
      });
    }).toThrow('boom');

    expect(getAgentName()).toBeUndefined();
  });
});
