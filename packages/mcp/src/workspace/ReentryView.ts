import type {
    GoalSnapshot,
    JsonValue,
    WaitRecord,
} from "@portable-devshell/shared";
import type {
    WorkspaceReentryDirective,
    WorkspaceReentryView,
} from "./model/Contract.js";

export type {
    WorkspaceSnapshot,
    WorkspaceReentryDirective,
    WorkspaceResolvedAction,
} from "./model/Contract.js";

export function projectWorkspaceReentry(
    value: JsonValue | undefined,
    waits: WaitRecord[],
    goal: GoalSnapshot | undefined,
    agentBusy: boolean,
    directives?: WorkspaceReentryDirective[],
): WorkspaceReentryView {
    const state = record(value) ?? {};
    const wait = waits
        .filter(
            (candidate) =>
                candidate.status === "resolved" &&
                candidate.detachedAt !== undefined &&
                candidate.recoveryDisabledAt === undefined &&
                candidate.recoveryMessageAttemptedAt === undefined &&
                candidate.recoveryMessageSentAt === undefined &&
                (candidate.automaticRecovery !== false ||
                    candidate.kind === "question" ||
                    record(candidate.result)?.interrupted === true),
        )
        .sort(
            (left, right) =>
                (left.resolvedAt ?? left.updatedAt).localeCompare(
                    right.resolvedAt ?? right.updatedAt,
                ) || left.waitId.localeCompare(right.waitId),
        )[0];
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
    const waitReadyAt =
        wait === undefined
            ? undefined
            : latestTimestamp(
                  wait.resolvedAt ?? wait.updatedAt,
                  executionLeaseAt,
              );
    const continuationDueAt = goal?.continuationDueAt;
    const hasDueTrigger =
        goal?.continuationDue === true ||
        (typeof continuationDueAt === "string" &&
            Number.isFinite(Date.parse(continuationDueAt)) &&
            Date.parse(continuationDueAt) > Date.now());
    const goalEligible =
        goal !== undefined &&
        goal.status === "active" &&
        goal.steps.some((step) => step.status === "active" || step.status === "pending") &&
        !waits.some((candidate) => candidate.status === "waiting" || candidate.status === "detached") &&
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
        waitReadyAt === undefined && goalReadyAt === undefined
            ? undefined
            : waitReadyAt !== undefined &&
                (goalReadyAt === undefined ||
                    Date.parse(waitReadyAt) <= Date.parse(goalReadyAt))
              ? {
                    readyAt: waitReadyAt,
                    intent: "automatic" as const,
                    sourceId: wait!.waitId,
                }
              : {
                    readyAt: goalReadyAt!,
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
        pending: state.pending === true,
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
