/**
 * Client-side interceptors: stamp Kelet session headers onto outbound
 * ``start`` / ``signal`` / ``query`` calls based on the current
 * ``agenticSession()`` context.
 *
 * @internal
 */

import type {
  WorkflowClientInterceptor,
  WorkflowStartInput,
  WorkflowSignalInput,
  WorkflowQueryInput,
  Next,
} from '@temporalio/client';

import { getMetadata, getSessionId, getUserId } from '../context';
import { deriveSessionId, inject, type SessionPayload } from './headers';
import type { ClientAutoSession } from './types';

function _currentSessionPayload(): SessionPayload | undefined {
  const sessionId = getSessionId();
  if (!sessionId) return undefined;
  return {
    sessionId,
    userId: getUserId(),
    metadata: getMetadata(),
  };
}

function _resolveStartPayload(
  input: WorkflowStartInput,
  autoSession: ClientAutoSession,
): SessionPayload | undefined {
  const fromContext = _currentSessionPayload();
  if (fromContext) return fromContext;
  if (autoSession === false) return undefined;

  // ``WorkflowStartInput.options.workflowId`` is optional — when callers omit
  // it, Temporal generates one server-side. We can't derive on the client in
  // that case, so skip and let the worker-side ``activityAutoSession`` (if
  // configured) backstop.
  const wfId = input.options.workflowId;
  if (!wfId) return undefined;

  const derived =
    autoSession === true
      ? deriveSessionId(wfId)
      : autoSession({ workflowType: input.workflowType, workflowId: wfId });
  return derived ? { sessionId: derived } : undefined;
}

/** Build the WorkflowClientInterceptor for {@link KeletPlugin}. Stateless
 * apart from the autoSession config captured in the closure.
 */
export function buildClientInterceptor(
  autoSession: ClientAutoSession,
): WorkflowClientInterceptor {
  return {
    async start(input, next: Next<WorkflowClientInterceptor, 'start'>) {
      const payload = _resolveStartPayload(input, autoSession);
      return next({ ...input, headers: inject(input.headers, payload) });
    },
    async signal(input: WorkflowSignalInput, next: Next<WorkflowClientInterceptor, 'signal'>) {
      const payload = _currentSessionPayload();
      return next({ ...input, headers: inject(input.headers, payload) });
    },
    async query(input: WorkflowQueryInput, next: Next<WorkflowClientInterceptor, 'query'>) {
      const payload = _currentSessionPayload();
      return next({ ...input, headers: inject(input.headers, payload) });
    },
  };
}
