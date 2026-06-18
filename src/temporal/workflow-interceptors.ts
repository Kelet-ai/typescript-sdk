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
import { workflowInfo } from '@temporalio/workflow';
import { agenticSession } from '../context';
import { extract, getCurrentSessionPayload, inject } from './headers';
import { isRunIdAutoSessionEnabled } from './workflow-autosession';

/** If the inbound headers carry a Kelet session, run ``next()`` inside an
 * ``agenticSession`` for that payload; otherwise pass through. Centralises the
 * extract → guard → wrap pattern so all five inbound handlers stay in sync.
 *
 * ``fallbackSessionId`` is used only when no header is present — it lets the
 * top-level workflow seed a run-ID session so child workflows / activities
 * inherit it via outbound headers (one session per chain). Signal / query /
 * update handlers pass no fallback: a mid-flight signal must not mint a new
 * root session.
 */
function _withInboundSession<T>(
  headers: Headers,
  next: () => T | Promise<T>,
  fallbackSessionId?: string,
): T | Promise<T> {
  const payload = extract(headers);
  const sessionId = payload?.sessionId ?? fallbackSessionId;
  if (!sessionId) return next();
  return agenticSession(
    {
      sessionId,
      userId: payload?.userId,
      metadata: payload?.metadata,
    },
    next,
  );
}

/** Run-ID fallback for the top-level workflow, when enabled and no header is
 * present. ``workflowInfo().runId`` is deterministic and replay-safe. */
function _runIdFallback(): string | undefined {
  if (!isRunIdAutoSessionEnabled()) return undefined;
  return workflowInfo().runId || undefined;
}

/** Stamp the current session into outbound headers and call ``next``. */
function _withOutboundHeaders<I extends { headers: Headers }, R>(
  input: I,
  next: (input: I) => R,
): R {
  const payload = getCurrentSessionPayload();
  return next({ ...input, headers: inject(input.headers, payload) });
}

class KeletWorkflowInbound implements WorkflowInboundCallsInterceptor {
  async execute(
    input: WorkflowExecuteInput,
    next: Next<WorkflowInboundCallsInterceptor, 'execute'>,
  ): Promise<unknown> {
    return _withInboundSession(input.headers, () => next(input), _runIdFallback());
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
