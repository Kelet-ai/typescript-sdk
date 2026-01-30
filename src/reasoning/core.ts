/**
 * Core reasoning capture utilities shared between automatic (register) and manual (aisdk) modes.
 *
 * @internal
 * @module reasoning/core
 */

import { AsyncLocalStorage } from 'async_hooks';
import { formatReasoning } from './hook';

// Types
export type SpanLike = {
  name: string;
  attributes?: Record<string, unknown>;
  setAttribute?(key: string, value: unknown): void;
};

export type SpanExporter = {
  export(spans: unknown[], callback: (result: unknown) => void): void;
  shutdown(): Promise<void>;
};

export type SpanProcessor = {
  onStart(span: SpanLike): void;
  onEnd(span: unknown): void;
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
};

export type TracerProviderConfig = { spanProcessors?: SpanProcessor[]; [key: string]: unknown };
export type TracerProvider = { [key: string]: unknown };

// Context for capturing span reference
export const spanContext = new AsyncLocalStorage<{ span: SpanLike | null }>();
export const AI_SDK_SPANS = new Set(['ai.generateText', 'ai.streamText']);

/** Add reasoning attributes to span */
export function addReasoningToSpan(span: SpanLike, reasoning: string): void {
  if (span.attributes) {
    span.attributes['ai.response.reasoning'] = reasoning;
    span.attributes['ai.reasoning.length'] = reasoning.length;
  } else if (span.setAttribute) {
    span.setAttribute('ai.response.reasoning', reasoning);
    span.setAttribute('ai.reasoning.length', reasoning.length);
  }
}

/** Wrap generateText result to capture reasoning */
export function captureGenerateTextReasoning(
  ctx: { span: SpanLike | null },
  result: unknown
): void {
  if (ctx.span && result && typeof result === 'object' && 'reasoning' in result) {
    const reasoning = formatReasoning((result as { reasoning: unknown }).reasoning);
    if (reasoning) {
      addReasoningToSpan(ctx.span, reasoning);
    }
  }
}

/** Wrap streamText result to capture reasoning */
export function captureStreamTextReasoning(
  ctx: { span: SpanLike | null },
  result: Record<string, unknown>
): void {
  if (result?.reasoning instanceof Promise) {
    result.reasoning = result.reasoning.then((r) => {
      const formatted = formatReasoning(r);
      if (formatted && ctx.span) {
        addReasoningToSpan(ctx.span, formatted);
      }
      return r;
    });
  }
}

/**
 * Wraps a SpanExporter to defer export, allowing reasoning to be added before export.
 */
export function wrapExporter<T extends SpanExporter>(exporter: T): T {
  return {
    ...exporter,
    export(spans: unknown[], cb: (r: unknown) => void): void {
      setImmediate(() => exporter.export(spans, cb));
    },
    shutdown(): Promise<void> {
      return exporter.shutdown();
    },
  } as T;
}

/** Wrap SimpleSpanProcessor with deferred export */
export function wrapSimpleSpanProcessor<T extends new (e: SpanExporter) => SpanProcessor>(
  Original: T
): T {
  return class extends (Original as unknown as new (e: SpanExporter) => SpanProcessor) {
    constructor(exporter: SpanExporter) {
      super(wrapExporter(exporter) as SpanExporter);
    }
  } as unknown as T;
}

/** Wrap TracerProvider to inject SpanCaptureProcessor */
export function wrapProvider<T extends new (...args: unknown[]) => TracerProvider>(
  Original: T,
  SpanCaptureProcessorClass: new () => SpanProcessor
): T {
  return class extends (Original as unknown as new (...args: unknown[]) => TracerProvider) {
    constructor(...args: unknown[]) {
      const config = (args[0] as TracerProviderConfig) || {};
      args[0] = {
        ...config,
        spanProcessors: [new SpanCaptureProcessorClass(), ...(config.spanProcessors || [])],
      };
      super(...args);
    }
  } as unknown as T;
}

// Re-export
export { formatReasoning };
