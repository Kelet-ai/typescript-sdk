/**
 * Kelet span processor for automatic attribute stamping.
 * @module processor
 */

import type { Context } from '@opentelemetry/api';
import type { SpanProcessor, ReadableSpan, Span } from '@opentelemetry/sdk-trace-base';
import { _sessionStorage, SESSION_ID_ATTR, USER_ID_ATTR } from './context';

/** Options for KeletSpanProcessor. */
export interface KeletSpanProcessorOptions {
  /** Project identifier stamped on every span. */
  project: string;
}

/**
 * SpanProcessor that stamps Kelet attributes on every span.
 *
 * - Always sets `kelet.project`
 * - Inside an `agenticSession`, also sets session and user ID attributes
 *
 * Wraps another SpanProcessor (e.g., SimpleSpanProcessor with KeletExporter)
 * and delegates all lifecycle methods.
 *
 * @example
 * ```typescript
 * import { KeletSpanProcessor } from 'kelet';
 * import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
 * import { KeletExporter } from 'kelet';
 *
 * const exporter = new KeletExporter({ apiKey: 'key' });
 * const processor = new KeletSpanProcessor(
 *   new SimpleSpanProcessor(exporter),
 *   { project: 'my-project' }
 * );
 * ```
 */
export class KeletSpanProcessor implements SpanProcessor {
  constructor(
    private readonly _wrapped: SpanProcessor,
    private readonly _options: KeletSpanProcessorOptions
  ) {}

  onStart(span: Span, parentContext: Context): void {
    // Always stamp project
    span.setAttribute('kelet.project', this._options.project);

    // Stamp session context if inside agenticSession
    const store = _sessionStorage.getStore();
    if (store) {
      span.setAttribute(SESSION_ID_ATTR, store.sessionId);
      if (store.userId !== undefined) {
        span.setAttribute(USER_ID_ATTR, store.userId);
      }
      if (store.metadata) {
        for (const [key, value] of Object.entries(store.metadata)) {
          span.setAttribute(`metadata.${key}`, value);
        }
      }
    }

    this._wrapped.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    this._wrapped.onEnd(span);
  }

  shutdown(): Promise<void> {
    return this._wrapped.shutdown();
  }

  forceFlush(): Promise<void> {
    return this._wrapped.forceFlush();
  }
}
