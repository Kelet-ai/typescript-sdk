/**
 * Activity-side inbound interceptor — opens an ``agenticSession()`` around
 * the activity body so spans + signals inside it auto-resolve the session.
 *
 * Activity context is non-deterministic by nature; full ``agenticSession``
 * mode is safe here (no sandbox).
 *
 * @internal
 */

import type {
  ActivityInboundCallsInterceptor,
  ActivityInterceptors,
  ActivityInterceptorsFactory,
  ActivityExecuteInput,
  Next,
} from '@temporalio/worker';
import type { Context as ActivityContext } from '@temporalio/activity';

import { agenticSession } from '../context';
import { deriveSessionId, extract } from './headers';
import type { ActivityAutoSession } from './types';

class KeletActivityInboundInterceptor implements ActivityInboundCallsInterceptor {
  constructor(
    private readonly ctx: ActivityContext,
    private readonly autoSession: ActivityAutoSession,
  ) {}

  async execute(
    input: ActivityExecuteInput,
    next: Next<ActivityInboundCallsInterceptor, 'execute'>,
  ): Promise<unknown> {
    const headerPayload = extract(input.headers);
    let sessionId: string | undefined = headerPayload?.sessionId;
    if (!sessionId) {
      sessionId = this._deriveFromInfo();
    }
    if (!sessionId) {
      return next(input);
    }
    return agenticSession(
      {
        sessionId,
        userId: headerPayload?.userId,
        metadata: headerPayload?.metadata,
      },
      () => next(input),
    );
  }

  private _deriveFromInfo(): string | undefined {
    if (this.autoSession === false) return undefined;
    const info = this.ctx.info;
    if (this.autoSession === true) {
      // ``workflowExecution`` is optional on Info (e.g., when an activity is
      // invoked outside a workflow context for testing), so guard before
      // deriving.
      const wfId = info.workflowExecution?.workflowId;
      return wfId ? deriveSessionId(wfId) : undefined;
    }
    return this.autoSession(info);
  }
}

/** Build the activity interceptors factory for {@link KeletPlugin}. */
export function buildActivityInterceptorsFactory(
  autoSession: ActivityAutoSession,
): ActivityInterceptorsFactory {
  return (ctx: ActivityContext): ActivityInterceptors => ({
    inbound: new KeletActivityInboundInterceptor(ctx, autoSession),
  });
}
