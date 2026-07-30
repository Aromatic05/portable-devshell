import type { InstanceSnapshot } from "@portable-devshell/shared";

export function renderInstanceSnapshot(snapshot: InstanceSnapshot): string {
    const lines = [
        `instance: ${snapshot.name}`,
        `status: ${snapshot.status}`,
        `ready: ${snapshot.ready}`,
        `daemonState: ${snapshot.daemonState}`,
        `connectionState: ${snapshot.connectionState}`,
        `lastSeq: ${snapshot.lastSeq}`
    ];

    if (snapshot.lastErrorCode !== undefined || snapshot.lastErrorMessage !== undefined) {
        lines.push(`lastErrorCode: ${snapshot.lastErrorCode ?? "-"}`);
        lines.push(`lastErrorMessage: ${snapshot.lastErrorMessage ?? "-"}`);
    }

    if (snapshot.reverse !== undefined) {
        lines.push(`management: ${snapshot.reverse.managementMode}`);
        lines.push(`reverseEnrollment: ${snapshot.reverse.enrollmentState}`);
        lines.push(`reverseAvailability: ${snapshot.reverse.availability}`);
        lines.push(`reverseTransport: ${snapshot.reverse.transport ?? "-"}`);
        lines.push(`reverseGeneration: ${snapshot.reverse.generation ?? "-"}`);
        lines.push(`reverseLastSeen: ${snapshot.reverse.lastSeenAt ?? "-"}`);
        if (snapshot.reverse.lastErrorCode !== undefined) {
            lines.push(`reverseLastErrorCode: ${snapshot.reverse.lastErrorCode}`);
            lines.push(`reverseLastErrorMessage: ${snapshot.reverse.lastErrorMessage ?? "-"}`);
        }
    }

    const activeTodos = snapshot.activeTodos ?? [];
    lines.push(...(activeTodos.length === 0 ? ["Todo: none"] : activeTodos.map(renderTodoSummary)));
    return `${lines.join("\n")}\n`;
}

function renderTodoSummary(todo: import("@portable-devshell/shared").ActiveTodoSummary): string {
    return `Todo: ${todo.completed}/${todo.total} completed${todo.currentItem === undefined ? "" : ` — ${todo.currentItem}`}`;
}
