import type { CliInstanceSnapshotEnvelope } from "../../control/CliControlStream.js";

export function renderInstanceSnapshot(snapshot: CliInstanceSnapshotEnvelope["snapshot"]): string {
    const lines = [
        `instance: ${snapshot.name}`,
        `status: ${snapshot.status}`,
        `ready: ${snapshot.ready}`,
        `daemonState: ${snapshot.daemonState}`,
        `connectionState: ${snapshot.connectionState}`,
        `lastSeq: ${snapshot.lastSeq}`
    ];

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

    lines.push(renderTodoSummary(snapshot.activeTodo));
    return `${lines.join("\n")}\n`;
}

function renderTodoSummary(todo: import("@portable-devshell/shared").ActiveTodoSummary | undefined): string {
    if (todo === undefined) {
        return "Todo: none";
    }
    return `Todo: ${todo.completed}/${todo.total} completed${todo.currentItem === undefined ? "" : ` — ${todo.currentItem}`}`;
}
