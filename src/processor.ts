/**
 * Kelet span processor for automatic attribute stamping.
 * @module processor
 */

import type { Context } from '@opentelemetry/api';
import { propagation } from '@opentelemetry/api';
import type { SpanProcessor, ReadableSpan, Span } from '@opentelemetry/sdk-trace-base';
import { _sessionStorage, _agentStorage, SESSION_ID_ATTR, USER_ID_ATTR, AGENT_NAME_ATTR, getSessionId, getUserId, getProjectOverride } from './context';

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
    const bag = propagation.getBaggage(parentContext);

    // Use `|| undefined` to treat empty-string baggage values as absent
    const baggageProject = bag?.getEntry('kelet.project')?.value || undefined;
    const baggageSessionId = bag?.getEntry('kelet.session_id')?.value || undefined;
    const baggageUserId = bag?.getEntry('kelet.user_id')?.value || undefined;

    // When inside a local agenticSession (ALS has a store), ContextVars are authoritative.
    // Baggage fallback is reserved for spans outside any local session (cross-process use case).
    // This prevents an inner session without userId/project from inheriting outer values via baggage.
    const inLocalSession = getSessionId() !== undefined;

    // Project: session override > baggage (cross-process only) > global config
    const project = getProjectOverride() ?? (!inLocalSession ? baggageProject : undefined) ?? this._options.project;
    span.setAttribute('kelet.project', project);

    // Session ID: ALS > baggage (cross-process only)
    const sessionId = getSessionId() ?? baggageSessionId;
    // User ID: ALS > baggage (cross-process only)
    const userId = getUserId() ?? (!inLocalSession ? baggageUserId : undefined);

    if (sessionId !== undefined) {
      span.setAttribute(SESSION_ID_ATTR, sessionId);
    }
    if (userId !== undefined) {
      span.setAttribute(USER_ID_ATTR, userId);
    }

    // Stamp agent name from agent storage
    const agentStore = _agentStorage.getStore();
    if (agentStore) {
      span.setAttribute(AGENT_NAME_ATTR, agentStore.agentName);
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
