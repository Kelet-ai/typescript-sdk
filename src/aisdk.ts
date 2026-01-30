/**
 * Drop-in replacement for 'ai' module with automatic reasoning capture.
 *
 * ## Quick Start
 *
 * ```typescript
 * // 1. Change your import
 * import { generateText, streamText } from 'kelet/aisdk';
 *
 * // 2. Wrap your exporter for deferred export (one-time setup)
 * import { wrapExporter } from 'kelet/aisdk';
 * import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
 *
 * const processor = new SimpleSpanProcessor(wrapExporter(yourExporter));
 * ```
 *
 * This module:
 * 1. Re-exports everything from 'ai'
 * 2. Wraps generateText/streamText to capture reasoning
 * 3. Auto-injects span capture into OTEL
 * 4. Provides wrapExporter() to defer export (required for reasoning capture)
 *
 * @module aisdk
 */

import { trace, type Tracer, type Span, type SpanOptions, type Context } from '@opentelemetry/api';
import {
  type SpanLike,
  spanContext,
  AI_SDK_SPANS,
  captureGenerateTextReasoning,
  captureStreamTextReasoning,
  wrapExporter,
} from './reasoning/core';

// Re-export everything from 'ai'
export * from 'ai';

// Re-export wrapExporter for user setup
export { wrapExporter };

// Auto-inject span capture by wrapping the global tracer provider
let isPatched = false;

function patchTracerProvider(): void {
  if (isPatched) return;
  isPatched = true;

  const originalGetTracerProvider = trace.getTracerProvider.bind(trace);

  // Override getTracerProvider to return wrapped tracers
  (trace as unknown as { getTracerProvider: typeof trace.getTracerProvider }).getTracerProvider =
    function () {
      const provider = originalGetTracerProvider();
      const originalGetTracer = provider.getTracer.bind(provider);

      // Wrap getTracer to return tracers with span capture
      (provider as unknown as { getTracer: typeof provider.getTracer }).getTracer = function (
        name: string,
        version?: string,
        options?: { schemaUrl?: string }
      ): Tracer {
        const tracer = originalGetTracer(name, version, options);
        const originalStartSpan = tracer.startSpan.bind(tracer);

        // Wrap startSpan to capture AI SDK spans
        (tracer as unknown as { startSpan: typeof tracer.startSpan }).startSpan = function (
          spanName: string,
          spanOptions?: SpanOptions,
          ctx?: Context
        ): Span {
          const span = originalStartSpan(spanName, spanOptions, ctx);

          // Capture span reference for AI SDK spans
          if (AI_SDK_SPANS.has(spanName)) {
            const store = spanContext.getStore();
            if (store) {
              store.span = span as unknown as SpanLike;
            }
          }

          return span;
        };

        return tracer;
      };

      return provider;
    };
}

// Patch on module load
patchTracerProvider();

// Import original functions
import { generateText as originalGenerateText, streamText as originalStreamText } from 'ai';

/**
 * Wrapped generateText that captures reasoning to OTEL spans.
 */
export async function generateText(
  ...args: Parameters<typeof originalGenerateText>
): Promise<Awaited<ReturnType<typeof originalGenerateText>>> {
  const ctx = { span: null as SpanLike | null };

  const result = await spanContext.run(ctx, () => originalGenerateText(...args));
  captureGenerateTextReasoning(ctx, result);

  return result;
}

/**
 * Wrapped streamText that captures reasoning to OTEL spans.
 */
export function streamText(
  ...args: Parameters<typeof originalStreamText>
): ReturnType<typeof originalStreamText> {
  const ctx = { span: null as SpanLike | null };

  return spanContext.run(ctx, () => {
    const result = originalStreamText(...args);
    captureStreamTextReasoning(ctx, result as unknown as Record<string, unknown>);
    return result;
  })!;
}
