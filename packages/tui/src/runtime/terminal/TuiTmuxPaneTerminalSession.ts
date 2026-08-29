import type { TuiTmuxInspectPane, TuiTmuxInputResult } from "../operation/TuiRuntimeTmuxOperations.js";
import { TuiTerminalBuffer } from "./TuiTerminalBuffer.js";
import type { TuiTerminalLine } from "./TuiTerminalModel.js";
import {
    projectTmuxPanes,
    renderTmuxInspectView,
    routeTmuxAttachInput,
    routeTmuxPaneBrowseInput,
    scrollTmuxInspectView,
    TUI_TMUX_INSPECT_MAX_LINES,
    TUI_TMUX_MULTI_WRITER_WARNING,
    type TuiTmuxListPane,
    type TuiTmuxPaneViewModel,
    type TuiTmuxScrollView,
} from "../../view/page/terminal/TuiTmuxPaneTerminalModel.js";

export interface TuiTmuxPaneTerminalOperations {
    inspectPane(instance: string, workspace: string, pane: string, lines?: number): Promise<TuiTmuxInspectPane | undefined>;
    listPanes(instance: string): Promise<TuiTmuxListPane[]>;
    sendInput(instance: string, workspace: string, task: string, input: string): Promise<TuiTmuxInputResult>;
}

export type TuiTmuxPaneTerminalStatus = "error" | "idle" | "loading" | "ready";

export interface TuiTmuxPaneTerminalActive {
    attached: boolean;
    command?: string;
    cwd?: string;
    historyLimit: number;
    lines: TuiTerminalLine[];
    name: string;
    paneId: string;
    scroll: TuiTmuxScrollView;
    status: string;
    taskId?: string;
    warning?: string;
    workspace: string;
}

export interface TuiTmuxPaneTerminalSnapshot {
    active?: TuiTmuxPaneTerminalActive;
    error?: string;
    instance?: string;
    panes: TuiTmuxPaneViewModel[];
    selectedIndex: number;
    status: TuiTmuxPaneTerminalStatus;
}

export interface TuiTmuxPaneTerminalScheduler {
    setInterval(listener: () => void, intervalMs: number): () => void;
}

const defaultScheduler: TuiTmuxPaneTerminalScheduler = {
    setInterval(listener, intervalMs) {
        const handle = setInterval(listener, intervalMs);
        return () => clearInterval(handle);
    },
};

export class TuiTmuxPaneTerminalSession {
    readonly #listeners = new Set<() => void>();
    readonly #operations: TuiTmuxPaneTerminalOperations;
    readonly #scheduler: TuiTmuxPaneTerminalScheduler;
    #disposed = false;
    #inputTail: Promise<void> = Promise.resolve();
    #refreshGeneration = 0;
    #refreshInFlight?: Promise<void>;
    #snapshot: TuiTmuxPaneTerminalSnapshot = { panes: [], selectedIndex: 0, status: "idle" };
    #stopPolling?: () => void;
    #viewportRows: number;

    constructor(options: {
        operations: TuiTmuxPaneTerminalOperations;
        scheduler?: TuiTmuxPaneTerminalScheduler;
        viewportRows?: number;
    }) {
        this.#operations = options.operations;
        this.#scheduler = options.scheduler ?? defaultScheduler;
        this.#viewportRows = Math.max(1, Math.floor(options.viewportRows ?? 24));
    }

    dispose(): void {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        this.stopPolling();
        this.#refreshGeneration += 1;
        this.#listeners.clear();
    }

    getSnapshot(): TuiTmuxPaneTerminalSnapshot {
        return this.#snapshot;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    setViewportRows(rows: number): void {
        this.#viewportRows = Math.max(1, Math.floor(rows));
        const active = this.#snapshot.active;
        if (active === undefined) {
            return;
        }
        this.#replace({
            ...this.#snapshot,
            active: { ...active, scroll: renderTmuxInspectView(active.lines, this.#viewportRows, active.scroll.offset) },
        });
    }

    async bind(instance: string | undefined): Promise<void> {
        if (this.#disposed) {
            return;
        }
        this.#refreshGeneration += 1;
        this.#refreshInFlight = undefined;
        this.stopPolling();
        if (instance === undefined) {
            this.#replace({ panes: [], selectedIndex: 0, status: "idle" });
            return;
        }
        this.#replace({ active: undefined, error: undefined, instance, panes: [], selectedIndex: 0, status: "loading" });
        await this.refresh();
    }

    async refresh(): Promise<void> {
        if (this.#disposed) {
            return;
        }
        if (this.#refreshInFlight !== undefined) {
            return await this.#refreshInFlight;
        }
        const running = this.#refreshOnce();
        this.#refreshInFlight = running;
        try {
            await running;
        } finally {
            if (this.#refreshInFlight === running) {
                this.#refreshInFlight = undefined;
            }
        }
    }

    async #refreshOnce(): Promise<void> {
        const instance = this.#snapshot.instance;
        if (instance === undefined) {
            return;
        }
        const generation = ++this.#refreshGeneration;
        const previouslySelected = this.#snapshot.panes[this.#snapshot.selectedIndex];
        let panes: TuiTmuxPaneViewModel[];
        try {
            panes = projectTmuxPanes(await this.#operations.listPanes(instance));
        } catch (error) {
            if (generation !== this.#refreshGeneration) {
                return;
            }
            this.#replace({ ...this.#snapshot, error: readErrorMessage(error), status: "error" });
            return;
        }
        if (generation !== this.#refreshGeneration) {
            return;
        }

        const preservedIndex = previouslySelected === undefined
            ? -1
            : panes.findIndex((pane) => pane.id === previouslySelected.id && pane.workspace === previouslySelected.workspace);
        const selectedIndex = preservedIndex >= 0
            ? preservedIndex
            : clampIndex(this.#snapshot.selectedIndex, panes.length);
        let active = this.#snapshot.active;
        if (active !== undefined) {
            const current = panes.find((pane) => pane.id === active?.paneId && pane.workspace === active?.workspace);
            if (current === undefined) {
                active = undefined;
            } else {
                const sameTaskRunning =
                    active.taskId !== undefined &&
                    current.mode === "attach" &&
                    current.taskId === active.taskId;
                active = {
                    ...active,
                    attached: active.attached && sameTaskRunning,
                    name: current.name,
                    status: current.status,
                    taskId: sameTaskRunning ? active.taskId : undefined,
                    warning: active.attached && sameTaskRunning ? active.warning : undefined,
                };
            }
        }
        if (active !== undefined) {
            let detail: TuiTmuxInspectPane | undefined;
            try {
                detail = await this.#operations.inspectPane(instance, active.workspace, active.paneId);
            } catch (error) {
                if (generation !== this.#refreshGeneration) {
                    return;
                }
                this.#replace({ ...this.#snapshot, error: readErrorMessage(error), status: "error" });
                return;
            }
            if (generation !== this.#refreshGeneration) {
                return;
            }
            active = await this.#applyInspect(active, detail);
            if (generation !== this.#refreshGeneration) {
                return;
            }
        }
        this.#replace({ active, error: undefined, instance, panes, selectedIndex, status: "ready" });
    }

    selectNext(): void {
        this.#select(this.#snapshot.selectedIndex + 1);
    }

    selectPrevious(): void {
        this.#select(this.#snapshot.selectedIndex - 1);
    }

    selectIndex(index: number): void {
        this.#select(index);
    }

    async activate(): Promise<void> {
        await this.#openSelected(true);
    }

    async #openSelected(attach: boolean): Promise<void> {
        if (this.#disposed) {
            return;
        }
        const instance = this.#snapshot.instance;
        const pane = this.#snapshot.panes[this.#snapshot.selectedIndex];
        if (instance === undefined || pane === undefined) {
            return;
        }
        const generation = ++this.#refreshGeneration;
        let detail: TuiTmuxInspectPane | undefined;
        try {
            detail = await this.#operations.inspectPane(instance, pane.workspace, pane.id);
        } catch (error) {
            if (generation !== this.#refreshGeneration) {
                return;
            }
            this.#replace({ ...this.#snapshot, error: readErrorMessage(error), status: "error" });
            return;
        }
        if (generation !== this.#refreshGeneration) {
            return;
        }
        const taskId = detail?.taskId !== undefined && detail.taskStatus === "running"
            ? detail.taskId
            : undefined;
        const lines = await parseTmuxInspectLines(detail?.lines ?? []);
        if (generation !== this.#refreshGeneration) {
            return;
        }
        this.#replace({
            ...this.#snapshot,
            active: {
                attached: attach && taskId !== undefined,
                command: detail?.command,
                cwd: detail?.cwd,
                historyLimit: TUI_TMUX_INSPECT_MAX_LINES,
                lines,
                name: pane.name,
                paneId: pane.id,
                scroll: renderTmuxInspectView(lines, this.#viewportRows, lines.length),
                status: detail?.status ?? pane.status,
                taskId,
                warning: attach && taskId !== undefined ? TUI_TMUX_MULTI_WRITER_WARNING : undefined,
                workspace: pane.workspace,
            },
            error: undefined,
        });
    }

    scroll(delta: number): void {
        const active = this.#snapshot.active;
        if (active === undefined) {
            return;
        }
        this.#replace({
            ...this.#snapshot,
            active: { ...active, scroll: scrollTmuxInspectView(active.lines, this.#viewportRows, active.scroll.offset, delta) },
        });
    }

    exitAttach(): void {
        const active = this.#snapshot.active;
        if (active === undefined || !active.attached) {
            return;
        }
        this.#replace({ ...this.#snapshot, active: { ...active, attached: false, warning: undefined } });
    }

    async handleInput(raw: string): Promise<void> {
        if (this.#disposed) {
            return;
        }
        const active = this.#snapshot.active;
        const instance = this.#snapshot.instance;
        if (active?.attached !== true || instance === undefined) {
            return;
        }
        const action = routeTmuxAttachInput(raw);
        if (action.kind === "exit") {
            this.exitAttach();
            return;
        }
        if (action.kind === "noop") {
            return;
        }
        const taskId = active.taskId;
        if (taskId === undefined) {
            return;
        }
        const workspace = active.workspace;
        const pending = this.#inputTail.then(async () => {
            if (this.#disposed) {
                return;
            }
            const before = this.#snapshot.active;
            if (
                this.#snapshot.instance !== instance ||
                before?.attached !== true ||
                before.taskId !== taskId ||
                before.workspace !== workspace
            ) {
                return;
            }
            let result: TuiTmuxInputResult;
            try {
                result = await this.#operations.sendInput(instance, workspace, taskId, action.input);
            } catch (error) {
                if (!this.#disposed) {
                    this.#replace({ ...this.#snapshot, error: readErrorMessage(error) });
                }
                return;
            }
            if (this.#disposed) {
                return;
            }
            this.#refreshGeneration += 1;
            const current = this.#snapshot.active;
            if (current === undefined || current.taskId !== taskId || current.workspace !== workspace) {
                return;
            }
            const lines = [...current.lines, ...(await parseTmuxInspectLines(result.output))];
            const offset = current.scroll.atBottom ? lines.length : current.scroll.offset;
            const exited = result.status !== "running";
            this.#replace({
                ...this.#snapshot,
                active: {
                    ...current,
                    attached: exited ? false : current.attached,
                    lines,
                    scroll: renderTmuxInspectView(lines, this.#viewportRows, offset),
                    status: result.status,
                    taskId: exited ? undefined : current.taskId,
                    warning: exited ? undefined : current.warning,
                },
                error: undefined,
            });
        });
        this.#inputTail = pending.catch(() => undefined);
        await pending;
    }

    closeActive(): void {
        if (this.#snapshot.active === undefined) {
            return;
        }
        this.#replace({ ...this.#snapshot, active: undefined });
    }

    async handleRawInput(raw: string): Promise<void> {
        const active = this.#snapshot.active;
        if (active !== undefined && active.attached) {
            await this.handleInput(raw);
            return;
        }
        const action = routeTmuxPaneBrowseInput(raw, active === undefined ? "list" : "view");
        switch (action.kind) {
            case "select":
                if (action.direction === "next") {
                    this.selectNext();
                } else {
                    this.selectPrevious();
                }
                return;
            case "activate":
                await this.activate();
                return;
            case "scroll":
                this.scroll(action.delta);
                return;
            case "close":
                this.closeActive();
                return;
            case "noop":
                return;
        }
    }

    startPolling(intervalMs: number, maxTicks: number = Number.POSITIVE_INFINITY): void {
        if (this.#disposed) {
            return;
        }
        this.stopPolling();
        let ticks = 0;
        this.#stopPolling = this.#scheduler.setInterval(() => {
            ticks += 1;
            void this.refresh();
            if (ticks >= maxTicks) {
                this.stopPolling();
            }
        }, intervalMs);
    }

    stopPolling(): void {
        this.#stopPolling?.();
        this.#stopPolling = undefined;
    }

    async #applyInspect(active: TuiTmuxPaneTerminalActive, detail: TuiTmuxInspectPane | undefined): Promise<TuiTmuxPaneTerminalActive> {
        const lines = await parseTmuxInspectLines(detail?.lines ?? []);
        const offset = active.scroll.atBottom ? lines.length : active.scroll.offset;
        const taskId =
            active.taskId !== undefined &&
            detail?.taskId === active.taskId &&
            detail.taskStatus === "running"
                ? active.taskId
                : undefined;
        return {
            ...active,
            attached: active.attached && taskId !== undefined,
            command: detail?.command ?? active.command,
            cwd: detail?.cwd ?? active.cwd,
            lines,
            scroll: renderTmuxInspectView(lines, this.#viewportRows, offset),
            status: detail?.status ?? active.status,
            taskId,
            warning: active.attached && taskId !== undefined ? active.warning : undefined,
        };
    }

    #select(index: number): void {
        const panes = this.#snapshot.panes;
        if (panes.length === 0) {
            return;
        }
        const clamped = clampIndex(index, panes.length);
        if (clamped === this.#snapshot.selectedIndex) {
            return;
        }
        const keepViewOpen = this.#snapshot.active !== undefined;
        this.#replace({ ...this.#snapshot, active: undefined, selectedIndex: clamped });
        if (keepViewOpen) {
            void this.#openSelected(false);
        }
    }

    #replace(snapshot: TuiTmuxPaneTerminalSnapshot): void {
        this.#snapshot = snapshot;
        for (const listener of this.#listeners) {
            listener();
        }
    }
}

function clampIndex(index: number, length: number): number {
    if (length <= 0) {
        return 0;
    }
    return Math.min(Math.max(0, Math.floor(index)), length - 1);
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const TMUX_INSPECT_PARSE_MIN_COLUMNS = 80;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|\u001B[@-Z\\-_]/g;

export async function parseTmuxInspectLines(rawLines: readonly string[]): Promise<TuiTerminalLine[]> {
    if (rawLines.length === 0) {
        return [];
    }
    const columns = Math.max(TMUX_INSPECT_PARSE_MIN_COLUMNS, ...rawLines.map(visibleWidth));
    const buffer = new TuiTerminalBuffer({ columns, rows: rawLines.length });
    try {
        await buffer.write(rawLines.join("\r\n"));
        return buffer.getSnapshot().lines;
    } finally {
        buffer.dispose();
    }
}

function visibleWidth(line: string): number {
    return line.replace(ANSI_ESCAPE_PATTERN, "").length;
}
