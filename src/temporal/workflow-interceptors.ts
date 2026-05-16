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

class KeletWorkflowInbound implements WorkflowInboundCallsInterceptor {
  async execute(
    input: WorkflowExecuteInput,
    next: Next<WorkflowInboundCallsInterceptor, 'execute'>,
  ): Promise<unknown> {
    const payload = extract(input.headers);
    if (!payload) return next(input);
    return agenticSession(
      {
        sessionId: payload.sessionId,
        userId: payload.userId,
        metadata: payload.metadata,
      },
      () => next(input),
    );
  }

  async handleSignal(
    input: SignalInput,
    next: Next<WorkflowInboundCallsInterceptor, 'handleSignal'>,
  ): Promise<void> {
    const payload = extract(input.headers);
    if (!payload) {
      await next(input);
      return;
    }
    await agenticSession(
      {
        sessionId: payload.sessionId,
        userId: payload.userId,
        metadata: payload.metadata,
      },
      () => next(input),
    );
  }

  async handleQuery(
    input: QueryInput,
    next: Next<WorkflowInboundCallsInterceptor, 'handleQuery'>,
  ): Promise<unknown> {
    const payload = extract(input.headers);
    if (!payload) return next(input);
    return agenticSession(
      {
        sessionId: payload.sessionId,
        userId: payload.userId,
        metadata: payload.metadata,
      },
      () => next(input),
    );
  }

  validateUpdate(
    input: UpdateInput,
    next: Next<WorkflowInboundCallsInterceptor, 'validateUpdate'>,
  ): void {
    const payload = extract(input.headers);
    if (!payload) return next(input);
    return agenticSession(
      {
        sessionId: payload.sessionId,
        userId: payload.userId,
        metadata: payload.metadata,
      },
      () => next(input),
    );
  }

  async handleUpdate(
    input: UpdateInput,
    next: Next<WorkflowInboundCallsInterceptor, 'handleUpdate'>,
  ): Promise<unknown> {
    const payload = extract(input.headers);
    if (!payload) return next(input);
    return agenticSession(
      {
        sessionId: payload.sessionId,
        userId: payload.userId,
        metadata: payload.metadata,
      },
      () => next(input),
    );
  }
}

class KeletWorkflowOutbound implements WorkflowOutboundCallsInterceptor {
  async scheduleActivity(
    input: ActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleActivity'>,
  ): Promise<unknown> {
    const payload = _currentSessionPayload();
    return next({ ...input, headers: inject(input.headers, payload) });
  }

  async scheduleLocalActivity(
    input: LocalActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleLocalActivity'>,
  ): Promise<unknown> {
    const payload = _currentSessionPayload();
    return next({ ...input, headers: inject(input.headers, payload) });
  }

  async startChildWorkflowExecution(
    input: StartChildWorkflowExecutionInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'startChildWorkflowExecution'>,
  ): Promise<[Promise<string>, Promise<unknown>]> {
    const payload = _currentSessionPayload();
    return next({ ...input, headers: inject(input.headers, payload) });
  }

  async signalWorkflow(
    input: SignalWorkflowInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'signalWorkflow'>,
  ): Promise<void> {
    const payload = _currentSessionPayload();
    return next({ ...input, headers: inject(input.headers, payload) });
  }

  async continueAsNew(
    input: ContinueAsNewInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'continueAsNew'>,
  ): Promise<never> {
    const payload = _currentSessionPayload();
    return next({ ...input, headers: inject(input.headers, payload) });
  }
}

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [new KeletWorkflowInbound()],
  outbound: [new KeletWorkflowOutbound()],
});
