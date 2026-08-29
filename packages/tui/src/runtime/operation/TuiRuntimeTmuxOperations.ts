import { withRequestTimeout, type JsonValue } from "@portable-devshell/shared";

import type { TuiRuntimeOperationClients } from "./TuiRuntimeOperationPorts.js";
import type { TuiAppStore } from "../../state/TuiAppStore.js";
import { TUI_TMUX_INSPECT_MAX_LINES, type TuiTmuxListPane } from "../../view/page/terminal/TuiTmuxPaneTerminalModel.js";

export interface TuiTmuxInspectPane {
    command?: string;
    cwd?: string;
    id: string;
    lines: string[];
    locked?: boolean;
    name: string;
    status: string;
    taskId?: string;
    taskStatus?: string;
    workspace: string;
}

export interface TuiTmuxInputResult {
    output: string[];
    status: string;
    task: string;
}

export class TuiRuntimeTmuxOperations {
    constructor(private readonly options: {
        clients: TuiRuntimeOperationClients;
        operationTimeoutMs: number;
        store: TuiAppStore;
    }) {}

    async listPanes(instance: string): Promise<TuiTmuxListPane[]> {
        const workspaces = this.#candidateWorkspaces(instance);
        const panes: TuiTmuxListPane[] = [];
        let firstError: unknown;
        let successfulCalls = 0;
        for (const workspace of workspaces) {
            try {
                const result = await this.call(instance, workspace, "tmux_list", {});
                successfulCalls += 1;
                panes.push(...readPanes(result, workspace));
            } catch (error) {
                firstError ??= error;
            }
        }
        if (successfulCalls === 0 && firstError !== undefined) {
            throw firstError;
        }
        return panes.sort(comparePanes);
    }

    async inspectPane(instance: string, workspace: string, pane: string, lines = 200): Promise<TuiTmuxInspectPane | undefined> {
        const half = Math.max(1, Math.min(TUI_TMUX_INSPECT_MAX_LINES, Math.floor(lines)));
        const result = await this.call(instance, workspace, "tmux_inspect", { end: 0, pane, start: -half });
        const candidates = readRecordArray(result, "panes");
        const detail = candidates.find((candidate) => candidate.id === pane)
            ?? candidates.find((candidate) => candidate.name === pane);
        if (detail === undefined) {
            return undefined;
        }
        return {
            command: readString(detail, "command"),
            cwd: readString(detail, "cwd"),
            id: readRequiredString(detail, "id"),
            lines: readStringArray(detail, "lines"),
            locked: detail.locked === true,
            name: readRequiredString(detail, "name"),
            status: readRequiredString(detail, "status"),
            taskId: readNestedString(detail, "task", "id"),
            taskStatus: readNestedString(detail, "task", "status"),
            workspace,
        };
    }

    async sendInput(instance: string, workspace: string, task: string, input: string): Promise<TuiTmuxInputResult> {
        const result = await this.call(instance, workspace, "tmux_input", { input, task, timeMs: 0 });
        return {
            output: readStringArray(result, "output"),
            status: readNestedString(result, "task", "status") ?? "unknown",
            task: readNestedString(result, "task", "id") ?? task,
        };
    }

    private async call(instance: string, workspace: string, toolName: string, input: JsonValue): Promise<Record<string, JsonValue>> {
        const feedback = (await withRequestTimeout(
            this.options.clients.tool.call(instance, toolName, input, workspace),
            this.options.operationTimeoutMs,
            `tool.call:${toolName}`,
            "uncertain",
        )) as Record<string, JsonValue>;
        const error = feedback.error as { code?: string; message?: string } | undefined;
        if (error !== undefined && typeof error === "object" && error.code !== undefined) {
            throw new Error(`${error.code}: ${error.message ?? "tmux tool call failed"}`);
        }
        return feedback;
    }

    #candidateWorkspaces(instance: string): string[] {
        const state = this.options.store.getState();
        const workspaces: string[] = [];
        const seen = new Set<string>();
        const add = (workspace: string | undefined) => {
            if (workspace === undefined || workspace.length === 0 || seen.has(workspace)) return;
            seen.add(workspace);
            workspaces.push(workspace);
        };

        const toolCalls = state.readModel.instanceState[instance]?.toolCalls ?? [];
        for (const call of [...toolCalls].sort((left, right) => right.startedAt.localeCompare(left.startedAt))) {
            if (call.toolName.startsWith("tmux_")) add(call.workspace);
        }
        return workspaces.slice(0, 32);
    }
}

function readPanes(result: Record<string, JsonValue>, workspace: string): TuiTmuxListPane[] {
    return readRecordArray(result, "panes").map((pane) => {
        const base = {
            id: readRequiredString(pane, "id"),
            name: readRequiredString(pane, "name"),
            status: readRequiredString(pane, "status"),
            workspace,
        };
        const taskId = readNestedString(pane, "task", "id");
        if (taskId === undefined) {
            return base;
        }
        return {
            ...base,
            task: { id: taskId, status: readNestedString(pane, "task", "status") ?? "unknown" },
        };
    });
}

function comparePanes(left: TuiTmuxListPane, right: TuiTmuxListPane): number {
    const leftRank = left.task?.status === "running" ? 0 : left.task === undefined ? 2 : 1;
    const rightRank = right.task?.status === "running" ? 0 : right.task === undefined ? 2 : 1;
    return leftRank - rightRank || left.workspace.localeCompare(right.workspace) || left.name.localeCompare(right.name);
}

function readRecordArray(result: Record<string, JsonValue>, key: string): Record<string, JsonValue>[] {
    const value = result[key];
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry): entry is Record<string, JsonValue> => typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

function readStringArray(record: Record<string, JsonValue>, key: string): string[] {
    const value = record[key];
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry): entry is string => typeof entry === "string");
}

function readRequiredString(record: Record<string, JsonValue>, key: string): string {
    const value = record[key];
    return typeof value === "string" ? value : "";
}

function readString(record: Record<string, JsonValue>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

function readNestedString(record: Record<string, JsonValue>, key: string, nested: string): string | undefined {
    const value = record[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const inner = (value as Record<string, JsonValue>)[nested];
    return typeof inner === "string" ? inner : undefined;
}
