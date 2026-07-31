import type { ContextMessageRecord } from "@portable-devshell/shared/browser";

const statusRank: Record<ContextMessageRecord["status"], number> = {
    pending: 0,
    failed: 1,
    delivered: 2,
};

export function mergeContextMessage(
    current: readonly ContextMessageRecord[],
    incoming: ContextMessageRecord,
): ContextMessageRecord[] {
    const existing = current.find((message) => message.id === incoming.id);
    const selected =
        existing !== undefined && statusRank[existing.status] > statusRank[incoming.status]
            ? existing
            : incoming;
    return [
        ...current.filter((message) => message.id !== incoming.id),
        selected,
    ];
}

export function mergeContextMessageList(
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
    return [
        ...merged,
        ...current.filter(
            (message) =>
                message.status === "pending" && !incomingIds.has(message.id),
        ),
    ];
}
