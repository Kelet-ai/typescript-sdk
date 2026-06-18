/**
 * Shared types for the Kelet Temporal interceptors.
 * @internal
 */

import type { Info as ActivityInfo } from '@temporalio/activity';

/** Auto-derive an activity-side session when no header is present.
 *
 * - ``false`` (default): no auto-derivation.
 * - ``true``: derive from ``info.workflowExecution.runId`` (the Temporal run
 *   ID — one run = one session). Only used as a fallback when no inbound
 *   ``x-kelet-session-id`` header is present (i.e., a chain started by a
 *   non-Kelet client).
 * - ``(info) => string | undefined``: custom resolver. **Must be deterministic.**
 */
export type ActivityAutoSession =
  | boolean
  | ((info: ActivityInfo) => string | undefined);

/** Auto-derive a client-stamped session for outbound ``start_workflow`` calls
 * when the caller didn't wrap the start in ``agenticSession()``.
 *
 * **Callable-only.** ``true`` is intentionally not accepted: at the start
 * call, Temporal hasn't yet assigned a run ID (it's generated server-side as
 * part of the call), so the client has nothing universal to derive from.
 * Run-ID-based auto-derivation lives worker-side via
 * ``activityAutoSession: true`` — the workflow-inbound interceptor resolves
 * the run ID once and all downstream hops carry it via headers.
 *
 * Use the callable form as an escape hatch when you genuinely want the client
 * to mint a session from ``workflowType + workflowId`` (e.g., a stable
 * business-key convention). **Must be deterministic.**
 *
 * Note: only fires for workflows started via the same TS client. Workflows
 * started from other clients / CLI / schedules won't get a header, and the
 * worker will see no session — use ``activityAutoSession`` to backstop on
 * the activity side, or always wrap your starts in ``agenticSession``.
 */
export type ClientAutoSession = (input: {
  workflowType: string;
  workflowId: string;
}) => string | undefined;
