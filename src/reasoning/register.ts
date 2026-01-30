/**
 * Reasoning capture instrumentation for Vercel AI SDK.
 *
 * Load via `--import` flag:
 * ```bash
 * node --import kelet/reasoning/register app.js
 * npx tsx --import kelet/reasoning/register app.ts
 * ```
 *
 * ## How It Works
 * 1. Hooks OTEL to capture span reference when AI SDK creates it
 * 2. Wraps generateText/streamText to capture reasoning after completion
 * 3. Directly mutates the span's attributes with reasoning content
 * 4. Defers span export to allow time for attribute mutation
 *
 * ## Runtime Compatibility
 * - **Node.js/tsx**: Full support
 * - **Bun**: NOT SUPPORTED - use `kelet/aisdk` instead
 *
 * @module reasoning/register
 */

import { Hook } from 'import-in-the-middle';
import {
  type SpanLike,
  type SpanProcessor,
  type SpanExporter,
  type TracerProvider,
  spanContext,
  AI_SDK_SPANS,
  captureGenerateTextReasoning,
  captureStreamTextReasoning,
  wrapSimpleSpanProcessor,
  wrapProvider,
} from './core';

// Debug helper
const debug = (msg: string) =>
  process.env.DEBUG?.includes('kelet') && console.log(`[kelet] ${msg}`);

// Register OTEL loader hook for ESM (Node.js only)
declare const Bun: unknown;
if (typeof Bun === 'undefined') {
  const { register } = await import('module');
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
}

/** Captures span reference into AsyncLocalStorage */
class SpanCaptureProcessor implements SpanProcessor {
  onStart(span: SpanLike): void {
    if (AI_SDK_SPANS.has(span.name)) {
      const ctx = spanContext.getStore();
      if (ctx) ctx.span = span;
    }
  }
  onEnd(): void {}
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

// Hook OTEL SDK
new Hook(['@opentelemetry/sdk-trace-base'], (exports) => {
  if (exports.BasicTracerProvider)
    exports.BasicTracerProvider = wrapProvider(
      exports.BasicTracerProvider as new (...a: unknown[]) => TracerProvider,
      SpanCaptureProcessor
    );
  if (exports.SimpleSpanProcessor)
    exports.SimpleSpanProcessor = wrapSimpleSpanProcessor(
      exports.SimpleSpanProcessor as unknown as new (e: SpanExporter) => SpanProcessor
    );
  debug('Hooked @opentelemetry/sdk-trace-base');
});

new Hook(['@opentelemetry/sdk-trace-node'], (exports) => {
  if (exports.NodeTracerProvider)
    exports.NodeTracerProvider = wrapProvider(
      exports.NodeTracerProvider as new (...a: unknown[]) => TracerProvider,
      SpanCaptureProcessor
    );
  debug('Hooked @opentelemetry/sdk-trace-node');
});

// Hook AI SDK
new Hook(['ai'], (exports: { generateText?: Function; streamText?: Function; [k: string]: unknown }) => {
  if (exports.generateText) {
    const original = exports.generateText;
    exports.generateText = async function (this: unknown, ...args: unknown[]) {
      const ctx = { span: null as SpanLike | null };
      const result = await spanContext.run(ctx, () => original.apply(this, args));
      captureGenerateTextReasoning(ctx, result);
      if (ctx.span) debug(`added reasoning to span`);
      return result;
    };
  }

  if (exports.streamText) {
    const original = exports.streamText;
    exports.streamText = function (this: unknown, ...args: unknown[]) {
      const ctx = { span: null as SpanLike | null };
      return spanContext.run(ctx, () => {
        const result = original.apply(this, args) as Record<string, unknown>;
        captureStreamTextReasoning(ctx, result);
        return result;
      });
    };
  }

  debug('Hooked AI SDK (generateText, streamText)');
});

debug('Reasoning capture hook registered');
