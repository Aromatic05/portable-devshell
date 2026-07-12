import type { CliInstanceSnapshotEnvelope } from "../../control/CliControlStream.js";

export function renderInstanceSnapshot(snapshot: CliInstanceSnapshotEnvelope["snapshot"]): string {
    return [
        `instance: ${snapshot.name}`,
        `status: ${snapshot.status}`,
        `ready: ${snapshot.ready}`,
        `daemonState: ${snapshot.daemonState}`,
        `connectionState: ${snapshot.connectionState}`,
        `lastSeq: ${snapshot.lastSeq}`,
        renderTodoSummary(snapshot.activeTodo)
    ].join("\n") + "\n";
}

function renderTodoSummary(todo: import("@portable-devshell/shared").ActiveTodoSummary | undefined): string {
    if (todo === undefined) {
        return "Todo: none";
    }
    return `Todo: ${todo.completed}/${todo.total} completed${todo.currentItem === undefined ? "" : ` — ${todo.currentItem}`}`;
}
