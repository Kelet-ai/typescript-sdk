/**
 * Reasoning capture instrumentation for Vercel AI SDK.
 *
 * This module is designed to be loaded via the `--import` flag:
 *
 * ```bash
 * # Node.js
 * node --import kelet/reasoning/register app.js
 *
 * # Bun
 * bun --preload kelet/reasoning/register app.ts
 * ```
 *
 * It uses import-in-the-middle to hook into the AI SDK and capture
 * reasoning/thinking content from extended thinking responses.
 *
 * IMPORTANT: You must set up OTEL tracing in your app code BEFORE
 * any AI SDK calls. This module only captures reasoning - it does NOT
 * set up OTEL (to avoid package version conflicts).
 *
 * @module reasoning/register
 */

import { register } from 'module';
import { Hook } from 'import-in-the-middle';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { formatReasoning } from './hook.ts';

// Register the OTEL loader hook for ESM support
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

/** AI SDK module exports type */
type AiSdkExports = {
  generateText?: (...args: unknown[]) => Promise<unknown>;
  streamText?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
};

/** Options with experimental telemetry */
type TelemetryOptions = {
  experimental_telemetry?: { functionId?: string };
};

/**
 * Wrap an async function to capture reasoning in a parent span.
 * We need a parent span because AI SDK's internal span ends before we get the result.
 */
function wrapWithReasoningCapture<T extends (...args: unknown[]) => Promise<unknown>>(
  original: T,
  name: string
): T {
  return async function wrapped(this: unknown, ...args: unknown[]) {
    const tracer = trace.getTracer('kelet-reasoning');

    // Get functionId from options if available
    const options = args[0] as TelemetryOptions | undefined;
    const functionId = options?.experimental_telemetry?.functionId ?? name;

    return tracer.startActiveSpan(`ai.reasoning.${functionId}`, async (span) => {
      try {
        const result = await original.apply(this, args);

        // Check if result has reasoning
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
  } as T;
}

// Hook into the AI SDK module
new Hook(['ai'], (exports: AiSdkExports) => {
  // Wrap generateText
  if (typeof exports.generateText === 'function') {
    exports.generateText = wrapWithReasoningCapture(exports.generateText, 'generateText');
  }

  // Wrap streamText - streaming is more complex, reasoning comes later
  if (typeof exports.streamText === 'function') {
    const originalStreamText = exports.streamText;

    exports.streamText = function wrappedStreamText(this: unknown, ...args: unknown[]) {
      const tracer = trace.getTracer('kelet-reasoning');
      const options = args[0] as TelemetryOptions | undefined;
      const functionId = options?.experimental_telemetry?.functionId ?? 'streamText';

      // For streaming, we can't easily wrap with a span since it returns immediately
      // But we can capture reasoning when it becomes available
      const streamResult = originalStreamText.apply(this, args);

      if (streamResult && typeof streamResult === 'object') {
        const result = streamResult as Record<string, unknown>;

        // Wrap the reasoning promise if it exists
        if ('reasoning' in result && result.reasoning instanceof Promise) {
          const originalReasoning = result.reasoning;
          result.reasoning = originalReasoning.then((reasoning) => {
            const formatted = formatReasoning(reasoning);
            if (formatted) {
              // Create a span just for the reasoning
              const span = tracer.startSpan(`ai.reasoning.${functionId}`);
              span.setAttribute('ai.response.reasoning', formatted);
              span.setAttribute('ai.reasoning.length', formatted.length);
              span.end();
            }
            return reasoning;
          });
        }
      }

      return streamResult;
    };
  }
});

// Debug log (only in development)
if (process.env.DEBUG?.includes('kelet')) {
  console.log('[kelet] Reasoning capture hook registered');
}
