/**
 * Shared types for the Kelet Temporal interceptors.
 * @internal
 */

import type { Info as ActivityInfo } from '@temporalio/activity';

/** Auto-derive a session when no inbound ``x-kelet-session-id`` header is
 * present (i.e., a chain started outside Kelet — CLI, schedule, non-TS client).
 *
 * - ``false`` (default): no auto-derivation.
 * - ``true``: derive from the Temporal run ID — one run = one session. The
 *   top-level workflow's inbound interceptor stamps ``workflowInfo().runId``
 *   so child workflows and activities inherit it via propagated headers
 *   (one session per chain). Activities invoked outside a workflow fall back
 *   to ``info.workflowExecution.runId``.
 * - ``(info) => string | undefined``: custom activity-side resolver. **Must be
 *   deterministic.** Only the boolean ``true`` enables the workflow-inbound
 *   fallback; a callable derives per-activity only.
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
 * For run-ID-based sessions, set ``activityAutoSession: true`` — the
 * worker-side workflow-inbound interceptor resolves the run ID once and all
 * downstream hops carry it via headers.
 *
 * Use the callable form as an escape hatch when you genuinely want the client
 * to mint a session from ``workflowType + workflowId`` (e.g., the workflow ID
 * already embeds a session ID by convention). **Must be deterministic.**
 *
 * Note: only fires for workflows started via the same TS client. Workflows
 * started from other clients / CLI / schedules won't get a header — use
 * ``activityAutoSession: true`` to backstop run-ID-based sessions worker-side,
 * or always wrap your starts in ``agenticSession``.
 */
export type ClientAutoSession = (input: {
  workflowType: string;
  workflowId: string;
}) => string | undefined;
