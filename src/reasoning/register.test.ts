import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { formatReasoning } from './hook.ts';

/**
 * Integration tests for reasoning capture wrapper.
 *
 * These tests verify that the wrapper correctly captures reasoning
 * content and adds it to spans.
 */

// Shared test infrastructure
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

/**
 * Wrapper function that mimics the behavior in register.ts.
 * We test this directly rather than loading the hook via --import.
 */
function wrapWithReasoningCapture<TArgs extends unknown[], TResult>(
  original: (...args: TArgs) => Promise<TResult>,
  name: string
): (...args: TArgs) => Promise<TResult> {
  return async function wrapped(...args: TArgs): Promise<TResult> {
    const tracer = trace.getTracer('kelet-reasoning');
    const options = args[0] as { experimental_telemetry?: { functionId?: string } } | undefined;
    const functionId = options?.experimental_telemetry?.functionId ?? name;

    return tracer.startActiveSpan(`ai.reasoning.${functionId}`, async (span) => {
      try {
        const result = await original(...args);

        if (result && typeof result === 'object' && 'reasoning' in result) {
          const reasoning = formatReasoning((result as { reasoning: unknown }).reasoning);
          if (reasoning) {
            span.setAttribute('ai.response.reasoning', reasoning);
            span.setAttribute('ai.reasoning.length', reasoning.length);
          }
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        throw error;
      } finally {
        span.end();
      }
    });
  };
}

describe('wrapWithReasoningCapture', () => {
  test('captures reasoning from result and adds to span', async () => {
    exporter.reset();

    const mockGenerateText = async () => ({
      text: 'The answer is 4',
      reasoning: [
        { type: 'text', text: 'Step 1: Add 2 + 2' },
        { type: 'text', text: 'Step 2: Result is 4' },
      ],
    });

    const wrapped = wrapWithReasoningCapture(mockGenerateText, 'generateText');
    const result = await wrapped();

    expect(result.text).toBe('The answer is 4');

    // Check span was created with reasoning
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const span = spans[0]!;
    expect(span.name).toBe('ai.reasoning.generateText');
    expect(span.attributes['ai.response.reasoning']).toBe(
      'Step 1: Add 2 + 2\nStep 2: Result is 4'
    );
    expect(span.attributes['ai.reasoning.length']).toBe(37);
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  test('uses functionId from experimental_telemetry options', async () => {
    exporter.reset();

    const mockGenerateText = async (_opts?: { experimental_telemetry?: { functionId?: string } }) => ({
      text: 'Hello',
      reasoning: [{ type: 'text', text: 'Thinking...' }],
    });

    const wrapped = wrapWithReasoningCapture(mockGenerateText, 'generateText');
    await wrapped({ experimental_telemetry: { functionId: 'my_agent' } });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('ai.reasoning.my_agent');
  });

  test('handles result without reasoning', async () => {
    exporter.reset();

    const mockGenerateText = async () => ({
      text: 'Simple response',
    });

    const wrapped = wrapWithReasoningCapture(mockGenerateText, 'generateText');
    const result = await wrapped();

    expect(result.text).toBe('Simple response');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['ai.response.reasoning']).toBeUndefined();
  });

  test('handles empty reasoning array', async () => {
    exporter.reset();

    const mockGenerateText = async () => ({
      text: 'Response',
      reasoning: [] as Array<{ type: string; text: string }>,
    });

    const wrapped = wrapWithReasoningCapture(mockGenerateText, 'generateText');
    await wrapped();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['ai.response.reasoning']).toBeUndefined();
  });

  test('handles string reasoning', async () => {
    exporter.reset();

    const mockGenerateText = async () => ({
      text: 'Response',
      reasoning: 'Direct reasoning string',
    });

    const wrapped = wrapWithReasoningCapture(mockGenerateText, 'generateText');
    await wrapped();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['ai.response.reasoning']).toBe('Direct reasoning string');
    expect(spans[0]!.attributes['ai.reasoning.length']).toBe(23);
  });

  test('sets error status on exception', async () => {
    exporter.reset();

    const mockGenerateText = async (): Promise<{ text: string; reasoning?: string }> => {
      throw new Error('API Error');
    };

    const wrapped = wrapWithReasoningCapture(mockGenerateText, 'generateText');

    await expect(wrapped()).rejects.toThrow('API Error');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]!.status.message).toBe('Error: API Error');
  });

  test('preserves this context', async () => {
    exporter.reset();

    const obj = { value: 42 };
    async function mockFn(this: typeof obj) {
      return { text: String(this.value), reasoning: 'test' };
    }

    const wrapped = wrapWithReasoningCapture(mockFn.bind(obj), 'test');
    const result = await wrapped();

    expect(result.text).toBe('42');
  });

  test('passes arguments through correctly', async () => {
    exporter.reset();

    const mockGenerateText = async (options: { prompt: string }) => ({
      text: `Echo: ${options.prompt}`,
      reasoning: 'Processed',
    });

    const wrapped = wrapWithReasoningCapture(mockGenerateText, 'generateText');
    const result = await wrapped({ prompt: 'Hello' });

    expect(result.text).toBe('Echo: Hello');
  });
});
