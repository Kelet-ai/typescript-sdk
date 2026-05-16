/**
 * Header inject/extract helpers for the Kelet Temporal interceptors.
 *
 * Mirrors Python's ``kelet.temporal._inject`` / ``_extract``: a single
 * payload-converted header per concern, encoded via the SDK's default
 * payload converter so users with custom converters / encryption Just Work.
 *
 * @internal
 */

import { defaultPayloadConverter, type Headers } from '@temporalio/common';

export const SESSION_HEADER = 'x-kelet-session-id';
export const USER_HEADER = 'x-kelet-user-id';
export const METADATA_HEADER = 'x-kelet-metadata';

/** Pre-resolved session payload to stamp into outbound headers. */
export interface SessionPayload {
  sessionId: string;
  userId?: string;
  metadata?: Record<string, string | number | boolean>;
}

/** Stamp a session payload into outbound headers. Returns the original
 * mapping unchanged when ``payload`` is undefined.
 */
export function inject(headers: Headers, payload: SessionPayload | undefined): Headers {
  if (!payload) return headers;
  const out: Headers = { ...headers };
  out[SESSION_HEADER] = defaultPayloadConverter.toPayload(payload.sessionId)!;
  if (payload.userId !== undefined) {
    out[USER_HEADER] = defaultPayloadConverter.toPayload(payload.userId)!;
  }
  if (payload.metadata !== undefined && Object.keys(payload.metadata).length > 0) {
    out[METADATA_HEADER] = defaultPayloadConverter.toPayload(payload.metadata)!;
  }
  return out;
}

/** Reconstruct ``SessionPayload`` from inbound headers, or undefined when no
 * session header is present.
 */
export function extract(headers: Headers): SessionPayload | undefined {
  const sp = headers[SESSION_HEADER];
  if (sp === undefined) return undefined;
  const sessionId = defaultPayloadConverter.fromPayload<string>(sp);
  const up = headers[USER_HEADER];
  const userId = up !== undefined ? defaultPayloadConverter.fromPayload<string>(up) : undefined;
  const mp = headers[METADATA_HEADER];
  const metadata =
    mp !== undefined
      ? defaultPayloadConverter.fromPayload<Record<string, string | number | boolean>>(mp)
      : undefined;
  return { sessionId, userId, metadata };
}

/** Default fallback when ``autoSession=true``: extract the segment after
 * ``/session/`` if the workflow ID follows the Kelet ``{prefix}/session/{id}``
 * convention; otherwise return the whole workflow ID.
 *
 * Mirrors Python's ``_derive_session_id``.
 */
export function deriveSessionId(workflowId: string): string {
  const parts = workflowId.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'session') {
      const next = parts[i + 1];
      if (next) return next;
    }
  }
  return workflowId;
}
