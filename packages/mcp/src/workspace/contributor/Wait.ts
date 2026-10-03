import type { WaitRecord } from "@portable-devshell/shared";
import type {
    WorkspaceAction,
    WorkspaceBackgroundItem,
    WorkspaceQuestionItem,
    WorkspaceResolvedAction,
} from "../model/Contract.js";
import { workspaceIdentity } from "../model/Identity.js";

const questionAction: Omit<WorkspaceAction, "id"> = {
    label: "Answer",
    tone: "primary",
};
const interruptAction: Omit<WorkspaceAction, "id"> = {
    label: "Stop waiting",
    tone: "danger",
    confirmation: { message: "Stop waiting? The task will continue running." },
};
const dismissAction: Omit<WorkspaceAction, "id"> = {
    label: "Dismiss recovery",
    tone: "default",
};

export interface WaitProjectionCapabilities {
    answer: boolean;
    interrupt: boolean;
    dismissRecovery: boolean;
}

export function contributeWaits(
    waits: WaitRecord[],
    ctxId: string,
    instance: string,
    capabilities: WaitProjectionCapabilities,
) {
    const questions: WorkspaceQuestionItem[] = [];
    const background: WorkspaceBackgroundItem[] = [];
    const modelBackground: WaitRecord[] = [];
    const modelWaits: WaitRecord[] = [];
    const actions: WorkspaceResolvedAction[] = [];
    const primaryOrder: Array<{
        item: WorkspaceQuestionItem;
        rank: number;
        updatedAt: string;
    }> = [];
    for (const wait of waits) {
        if (wait.createdByCtxId !== ctxId) continue;
        modelWaits.push(wait);
        const question =
            wait.kind === "question" &&
            (wait.status === "waiting" || wait.status === "detached");
        if (question) {
            const payload = record(wait.payload) ?? {};
            const choices = Array.isArray(payload.choices)
                ? payload.choices.flatMap((choice, index) => {
                      if (typeof choice === "string")
                          return [{ id: choice, label: choice }];
                      const entry = record(choice);
                      if (
                          typeof entry?.id === "string" &&
                          typeof entry.label === "string"
                      )
                          return [{ id: entry.id, label: entry.label }];
                      return [{ id: String(index), label: String(choice) }];
                  })
                : [];
            const input = choices.length
                ? {
                      kind: "choice" as const,
                      choices,
                      allowText: payload.allowText !== false,
                  }
                : { kind: "text" as const };
            const actionId = workspaceIdentity(
                ctxId,
                instance,
                wait.waitId,
                "question-answer",
            );
            if (capabilities.answer)
                actions.push({
                    itemId: wait.waitId,
                    actionId,
                    instance,
                    operation: "question-answer",
                    targetId: wait.waitId,
                });
            const actionInput =
                input.kind === "choice"
                    ? { kind: "choice" as const, choices: input.choices }
                    : { kind: "text" as const };
            const item: WorkspaceQuestionItem = {
                kind: "question",
                id: wait.waitId,
                title: "Question",
                prompt: String(
                    payload.question ??
                        payload.prompt ??
                        "Please provide an answer.",
                ),
                input,
                actions: capabilities.answer
                    ? [{ id: actionId, ...questionAction, input: actionInput }]
                    : [],
            };
            questions.push(item);
            primaryOrder.push({
                item,
                rank: wait.status === "waiting" ? 0 : 1,
                updatedAt: wait.updatedAt,
            });
        }
        if (
            (wait.kind === "tmux" &&
                (wait.status === "waiting" || wait.status === "detached")) ||
            ((wait.kind === "tmux" || wait.kind === "question") &&
                wait.status === "resolved" &&
                wait.detachedAt !== undefined &&
                (wait.recoveryDisabledAt === undefined ||
                    wait.recoveryMessageAttemptedAt !== undefined))
        ) {
            const id = wait.waitId;
            const interruptible =
                wait.kind === "tmux" &&
                (wait.status === "waiting" || wait.status === "detached");
            const dismissible =
                wait.status === "resolved" &&
                wait.detachedAt !== undefined &&
                wait.recoveryMessageAttemptedAt !== undefined &&
                wait.recoveryMessageId !== undefined;
            const itemActions: WorkspaceBackgroundItem["actions"] = [];
            if (interruptible && capabilities.interrupt) {
                const actionId = workspaceIdentity(
                    ctxId,
                    instance,
                    id,
                    "wait-interrupt",
                );
                actions.push({
                    itemId: id,
                    actionId,
                    instance,
                    operation: "wait-interrupt",
                    targetId: id,
                });
                itemActions.push({ id: actionId, ...interruptAction });
            }
            if (dismissible && capabilities.dismissRecovery) {
                const actionId = workspaceIdentity(
                    ctxId,
                    instance,
                    id,
                    "wait-dismiss",
                    wait.updatedAt,
                );
                actions.push({
                    itemId: id,
                    actionId,
                    instance,
                    operation: "wait-dismiss",
                    targetId: id,
                    recoveryMessageId: wait.recoveryMessageId,
                });
                itemActions.push({ id: actionId, ...dismissAction });
            }
            background.push({
                kind: "background",
                id,
                title:
                    wait.kind === "question"
                        ? "Answered question"
                        : "Background task",
                badge: dismissible ? "Delivery uncertain" : wait.status,
                ...(dismissible ? { detail: "Automatic retry stopped to avoid duplicate agent execution. Continue manually in chat or dismiss this recovery." } : {}),
                actions: itemActions,
            });
            modelBackground.push(wait);
        }
    }
    return {
        questions,
        background,
        modelBackground,
        modelWaits,
        actions,
        primaryOrder,
    };
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
