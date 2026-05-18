/**
 * Workflow-side interceptors. Loaded into the workflow VM by
 * ``KeletPlugin`` via the worker's ``workflowModules`` setting (same
 * mechanism Temporal's own ``OpenTelemetryPlugin`` uses).
 *
 * Imports only workflow-VM-safe modules. The kelet ``agenticSession``
 * called here runs in lite mode (the TS implementation is already lite —
 * just AsyncLocalStorage, which Temporal injects into the VM).
 */

/** Not a workflow, just interceptors */

import type {
  WorkflowInterceptors,
  WorkflowInboundCallsInterceptor,
  WorkflowOutboundCallsInterceptor,
  WorkflowExecuteInput,
  ActivityInput,
  LocalActivityInput,
  StartChildWorkflowExecutionInput,
  ContinueAsNewInput,
  SignalWorkflowInput,
  SignalInput,
  QueryInput,
  UpdateInput,
  Headers,
  Next,
} from '@temporalio/workflow';
import { agenticSession, getMetadata, getSessionId, getUserId } from '../context';
import { extract, inject, type SessionPayload } from './headers';

function _currentSessionPayload(): SessionPayload | undefined {
  const sessionId = getSessionId();
  if (!sessionId) return undefined;
  return {
    sessionId,
    userId: getUserId(),
    metadata: getMetadata(),
  };
}

/** If the inbound headers carry a Kelet session, run ``next()`` inside an
 * ``agenticSession`` for that payload; otherwise pass through. Centralises the
 * extract → guard → wrap pattern so all five inbound handlers stay in sync.
 */
function _withInboundSession<T>(
  headers: Headers,
  next: () => T | Promise<T>,
): T | Promise<T> {
  const payload = extract(headers);
  if (!payload) return next();
  return agenticSession(
    {
      sessionId: payload.sessionId,
      userId: payload.userId,
      metadata: payload.metadata,
    },
    next,
  );
}

/** Stamp the current session into outbound headers and call ``next``. */
function _withOutboundHeaders<I extends { headers: Headers }, R>(
  input: I,
  next: (input: I) => R,
): R {
  const payload = _currentSessionPayload();
  return next({ ...input, headers: inject(input.headers, payload) });
}

class KeletWorkflowInbound implements WorkflowInboundCallsInterceptor {
  async execute(
    input: WorkflowExecuteInput,
    next: Next<WorkflowInboundCallsInterceptor, 'execute'>,
  ): Promise<unknown> {
    return _withInboundSession(input.headers, () => next(input));
  }

  async handleSignal(
    input: SignalInput,
    next: Next<WorkflowInboundCallsInterceptor, 'handleSignal'>,
  ): Promise<void> {
    await _withInboundSession(input.headers, () => next(input));
  }

  async handleQuery(
    input: QueryInput,
    next: Next<WorkflowInboundCallsInterceptor, 'handleQuery'>,
  ): Promise<unknown> {
    return _withInboundSession(input.headers, () => next(input));
  }

  validateUpdate(
    input: UpdateInput,
    next: Next<WorkflowInboundCallsInterceptor, 'validateUpdate'>,
  ): void {
    // ``validateUpdate`` is sync; ``_withInboundSession`` returns its callback
    // result directly when the callback is sync, so this stays sync-correct.
    _withInboundSession(input.headers, () => next(input));
  }

  async handleUpdate(
    input: UpdateInput,
    next: Next<WorkflowInboundCallsInterceptor, 'handleUpdate'>,
  ): Promise<unknown> {
    return _withInboundSession(input.headers, () => next(input));
  }
}

class KeletWorkflowOutbound implements WorkflowOutboundCallsInterceptor {
  async scheduleActivity(
    input: ActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleActivity'>,
  ): Promise<unknown> {
    return _withOutboundHeaders(input, next);
  }

  async scheduleLocalActivity(
    input: LocalActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleLocalActivity'>,
  ): Promise<unknown> {
    return _withOutboundHeaders(input, next);
  }

  async startChildWorkflowExecution(
    input: StartChildWorkflowExecutionInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'startChildWorkflowExecution'>,
  ): Promise<[Promise<string>, Promise<unknown>]> {
    return _withOutboundHeaders(input, next);
  }

  async signalWorkflow(
    input: SignalWorkflowInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'signalWorkflow'>,
  ): Promise<void> {
    await _withOutboundHeaders(input, next);
  }

  async continueAsNew(
    input: ContinueAsNewInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'continueAsNew'>,
  ): Promise<never> {
    return _withOutboundHeaders(input, next);
  }
}

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [new KeletWorkflowInbound()],
  outbound: [new KeletWorkflowOutbound()],
});
