import type { ContextMessageRecord } from "@portable-devshell/shared";

const statusRank: Record<ContextMessageRecord["status"], number> = {
    pending: 0,
    failed: 1,
    delivered: 2,
};

export function mergeTuiContextMessage(
    current: readonly ContextMessageRecord[],
    incoming: ContextMessageRecord,
): ContextMessageRecord[] {
    const existing = current.find((message) => message.id === incoming.id);
    const selected =
        existing !== undefined && statusRank[existing.status] > statusRank[incoming.status]
            ? existing
            : incoming;
    return sortMessages([
        ...current.filter((message) => message.id !== incoming.id),
        selected,
    ]);
}

export function mergeTuiContextMessageList(
    current: readonly ContextMessageRecord[],
    incoming: readonly ContextMessageRecord[],
): ContextMessageRecord[] {
    const incomingIds = new Set(incoming.map((message) => message.id));
    const merged = incoming.map((message) => {
        const existing = current.find((candidate) => candidate.id === message.id);
        return existing !== undefined && statusRank[existing.status] > statusRank[message.status]
            ? existing
            : message;
    });
    return sortMessages([
        ...merged,
        ...current.filter(
            (message) => message.status === "pending" && !incomingIds.has(message.id),
        ),
    ]);
}

function sortMessages(messages: ContextMessageRecord[]): ContextMessageRecord[] {
    return messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
