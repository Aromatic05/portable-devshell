import type {
    GoalSnapshot,
    JsonValue,
} from "@portable-devshell/shared";
import type {
    McpAppReentryDirective,
    McpAppReentryView,
} from "./model/Contract.js";

export type {
    McpAppSnapshot,
    McpAppReentryDirective,
    McpAppResolvedAction,
} from "./model/Contract.js";

export function projectMcpAppReentry(
    value: JsonValue | undefined,
    goal: GoalSnapshot | undefined,
    agentBusy: boolean,
    directives?: McpAppReentryDirective[],
): McpAppReentryView {
    const state = record(value) ?? {};
    const uncertain =
        state.uncertain === true ||
        state.attempted === true ||
        goal?.continuationUncertain === true;
    const paused =
        state.paused === true ||
        state.mode === "paused" ||
        state.mode === "user_owned";
    const executionLeaseAt =
        typeof state.executionLeaseUntil === "string"
            ? state.executionLeaseUntil
            : undefined;
    const executionLeaseUntil =
        executionLeaseAt === undefined
            ? Number.NaN
            : Date.parse(executionLeaseAt);
    const leaseIsFuture =
        Number.isFinite(executionLeaseUntil) &&
        executionLeaseUntil > Date.now();
    // A future dueAt is not permission to resume. The Instance computes due.
    const hasDueTrigger = goal?.continuationDue === true;
    const goalEligible =
        goal !== undefined &&
        goal.status === "active" &&
        goal.steps.some(
            (step) => step.status === "active" || step.status === "pending",
        ) &&
        hasDueTrigger &&
        !goal.continuationUncertain &&
        !goal.continuationPending &&
        !goal.autoContinueExhausted;
    const goalReadyAt = goalEligible
        ? latestTimestamp(
              goal.continuationDueAt,
              goal.continuationRetryAfter,
              executionLeaseAt,
          )
        : undefined;
    const source =
        goalReadyAt === undefined
            ? undefined
            : {
                  readyAt: goalReadyAt,
                  intent: "automatic" as const,
                  sourceId: goal!.goalId,
              };
    const canSchedule =
        state.mode === "automatic" &&
        !paused &&
        state.attempted !== true &&
        state.uncertain !== true &&
        !(state.executionActive === true && !leaseIsFuture) &&
        !(agentBusy && !leaseIsFuture);
    const schedule = canSchedule ? source : undefined;
    return {
        pending: state.pending === true || (directives?.length ?? 0) > 0,
        ...(typeof state.executionActive === "boolean"
            ? { executionActive: state.executionActive }
            : {}),
        ...(schedule ? { schedule } : {}),
        delivery: {
            status: uncertain ? "uncertain" : paused ? "paused" : "idle",
        },
        ...(directives?.length ? { directives } : {}),
    };
}

function latestTimestamp(
    ...values: Array<string | undefined>
): string | undefined {
    const valid = values.flatMap((value) =>
        value !== undefined && Number.isFinite(Date.parse(value))
            ? [{ value, time: Date.parse(value) }]
            : [],
    );
    return valid.sort((left, right) => right.time - left.time)[0]?.value;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
