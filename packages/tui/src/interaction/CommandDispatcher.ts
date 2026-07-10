import type { TuiAppStore } from "../store/TuiAppStore.js";
import { selectMainBoxFlowMetrics, selectMainBoxIds, selectMainScreenModel, selectMainScrollKey } from "../store/TuiSelectors.js";
import { TuiFocusManager } from "./TuiFocusManager.js";
import type { TuiUiIntent } from "./TuiInteractionTypes.js";

export interface CommandDispatcherOptions {
    focusManager: TuiFocusManager;
    onApprovalDecision(instance: string, approvalId: string, decision: "approve" | "deny"): Promise<void>;
    onInstanceAction(action: "refresh" | "start" | "stop", instance: string): Promise<void>;
    onAttachShell(instance: string): Promise<void>;
    mainViewportRows(): number;
    onLogsReload(): Promise<void>;
    onQuit(): Promise<void>;
    onRedraw(): void;
    onToolCall(instance: string, toolName: string, input: string): Promise<boolean>;
    store: TuiAppStore;
}

export class CommandDispatcher {
    readonly #focusManager: TuiFocusManager;
    readonly #onApprovalDecision: CommandDispatcherOptions["onApprovalDecision"];
    readonly #onInstanceAction: CommandDispatcherOptions["onInstanceAction"];
    readonly #onAttachShell: CommandDispatcherOptions["onAttachShell"];
    readonly #mainViewportRows: () => number;
    readonly #onLogsReload: () => Promise<void>;
    readonly #onQuit: () => Promise<void>;
    readonly #onRedraw: () => void;
    readonly #onToolCall: CommandDispatcherOptions["onToolCall"];
    readonly #store: TuiAppStore;

    constructor(options: CommandDispatcherOptions) {
        this.#focusManager = options.focusManager;
        this.#onApprovalDecision = options.onApprovalDecision;
        this.#onInstanceAction = options.onInstanceAction;
        this.#onAttachShell = options.onAttachShell;
        this.#mainViewportRows = options.mainViewportRows;
        this.#onLogsReload = options.onLogsReload;
        this.#onQuit = options.onQuit;
        this.#onRedraw = options.onRedraw;
        this.#onToolCall = options.onToolCall;
        this.#store = options.store;
    }

    async dispatch(intent: TuiUiIntent): Promise<boolean> {
        switch (intent.type) {
            case "app.requestQuit":
            case "app.quit":
                await this.#onQuit();
                return true;
            case "page.select":
                this.#store.setSelectedPage(intent.page);
                this.#store.setSidebarCursor({ id: intent.page, kind: "page" });
                this.#syncMainFocus();
                if (intent.page === "logs" && this.#store.getState().ui.selectedInstance !== undefined) {
                    await this.#onLogsReload();
                    this.#store.setScreenStatus("logs", "Logs reloaded from instance.readLogs.");
                }
                return true;
            case "focus.move":
                if (intent.direction === "next" || intent.direction === "previous") {
                    return this.#moveAcrossScopes(intent.direction);
                }
                return this.#moveWithinScope(intent.direction);
            case "focus.activate":
                return await this.#activateCurrentScope();
            case "ui.cancel":
                return this.#cancel();
            case "ui.help":
                return await this.dispatch({ page: "help", type: "page.select" });
            case "ui.redraw":
                this.#store.bumpRedrawNonce();
                this.#onRedraw();
                return true;
            case "search.open":
                this.#focusManager.pushRestore("search");
                this.#store.setSearchOpen(true);
                this.#store.setFocusScope("search");
                return true;
            case "search.append": {
                const page = this.#store.getState().ui.selectedPage;
                const current = this.#store.getState().ui.searchQueries[page] ?? "";
                this.#store.setSearchQuery(page, `${current}${intent.text}`);
                return true;
            }
            case "search.backspace": {
                const page = this.#store.getState().ui.selectedPage;
                const current = this.#store.getState().ui.searchQueries[page] ?? "";
                this.#store.setSearchQuery(page, current.slice(0, -1));
                return true;
            }
            case "search.submit":
                this.#store.setSearchOpen(false);
                this.#focusManager.restore();
                return true;
            case "actionMenu.open":
                return this.#openInstanceActionMenu();
            case "actionMenu.move": {
                const items = this.#store.getState().interaction.actionMenu.items;
                if (items.length === 0) {
                    return false;
                }
                const current = this.#store.getState().interaction.actionMenu.selectedIndex;
                const next = intent.direction === "down" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
                this.#store.setActionMenu(this.#store.getState().interaction.actionMenu.title, items, next);
                return true;
            }
            case "actionMenu.submit": {
                const selectedIndex = this.#store.getState().interaction.actionMenu.selectedIndex;
                const item = this.#store.getState().interaction.actionMenu.items[selectedIndex];
                if (item === undefined) {
                    return false;
                }
                this.#store.setActionMenu("", []);
                this.#focusManager.restore();
                return await this.dispatch(item.intent);
            }
            case "confirm.accept": {
                if (this.#store.getState().interaction.selectedConfirmButton === "cancel") {
                    return await this.dispatch({ type: "confirm.cancel" });
                }
                const confirmIntent = this.#store.getState().interaction.confirmDialog.confirmIntent;
                this.#store.setConfirmDialog({
                    body: "",
                    confirmIntent: { type: "ui.cancel" },
                    open: false,
                    title: ""
                });
                this.#focusManager.restore();
                return await this.dispatch(confirmIntent);
            }
            case "confirm.cancel":
                this.#store.setConfirmDialog({
                    body: "",
                    confirmIntent: { type: "ui.cancel" },
                    open: false,
                    title: ""
                });
                this.#focusManager.restore();
                return true;
            case "screen.pageUp":
                return this.#scrollMainColumn(-Math.max(1, this.#boxViewportRows() - 1));
            case "screen.pageDown":
                return this.#scrollMainColumn(Math.max(1, this.#boxViewportRows() - 1));
            case "screen.home":
                return this.#setMainColumnOffset(0);
            case "screen.end":
                return this.#setMainColumnOffset(this.#maxMainScrollOffset());
            case "screen.toggle": {
                if (this.#store.getState().interaction.focusScope !== "mainBoxes") {
                    return false;
                }
                const boxId = this.#store.getState().ui.mainFocusId;
                if (boxId === undefined) {
                    return false;
                }
                const key = this.#expandedKey(boxId);
                const expanded = this.#store.getState().ui.expandedBoxes[key] === true;
                this.#store.toggleExpanded(key);
                this.#ensureMainFocusVisible();
                this.#store.setScreenStatus(this.#store.getState().ui.selectedPage, expanded ? "Collapsed box." : "Expanded box.");
                return true;
            }
            case "logs.reload":
                if (this.#store.getState().ui.selectedPage !== "logs" || this.#store.getState().ui.selectedInstance === undefined) {
                    return false;
                }
                await this.#onLogsReload();
                this.#store.setScreenStatus("logs", "Logs reloaded from instance.readLogs.");
                return true;
            case "logs.toggleFollow":
                this.#store.setScreenStatus(this.#store.getState().ui.selectedPage, "Use Up/Down/Home/End to inspect log history.");
                return true;
            case "logs.clearBuffer":
                if (this.#store.getState().ui.selectedPage !== "logs") {
                    return false;
                }
                this.#store.clearLogsBuffer();
                this.#store.setScreenStatus("logs", "Cleared local log buffer only.");
                return true;
            case "overlay.openActionMenu":
                this.#focusManager.pushRestore("actionMenu");
                this.#store.setActionMenu(intent.title, intent.items);
                this.#store.setFocusScope("actionMenu");
                return true;
            case "overlay.openConfirm":
                this.#focusManager.pushRestore("confirm");
                this.#store.setConfirmDialog({
                    body: intent.body,
                    cancelLabel: intent.cancelLabel,
                    confirmIntent: intent.confirmIntent,
                    confirmLabel: intent.confirmLabel,
                    open: true,
                    title: intent.title
                });
                this.#store.setFocusScope("confirm");
                return true;
            case "overlay.closeActionMenu":
                this.#store.setActionMenu("", []);
                this.#focusManager.restore();
                return true;
            case "overlay.closeConfirm":
                this.#store.setConfirmDialog({
                    body: "",
                    confirmIntent: { type: "ui.cancel" },
                    open: false,
                    title: ""
                });
                this.#focusManager.restore();
                return true;
            case "focus.scope.set":
                this.#store.setFocusScope(intent.focusScope);
                return true;
            case "mainFocus.set":
                this.#store.setMainFocusId(intent.id);
                return true;
            case "confirm.focus":
                this.#store.setConfirmFocus(intent.button);
                return true;
            case "ui.toggleExpanded":
                this.#store.toggleExpanded(intent.key);
                return true;
            case "screen.setStatus":
                this.#store.setScreenStatus(intent.page, intent.status);
                return true;
            case "screen.clearStatus":
                this.#store.setScreenStatus(this.#store.getState().ui.selectedPage, undefined);
                return true;
            case "instance.start":
                await this.#onInstanceAction("start", intent.instance);
                return true;
            case "instance.stop":
                await this.#onInstanceAction("stop", intent.instance);
                return true;
            case "instance.refresh":
                await this.#onInstanceAction("refresh", intent.instance);
                return true;
            case "instance.attachShell":
                await this.#onAttachShell(intent.instance);
                return true;
            case "instance.openLogs":
                return await this.dispatch({ page: "logs", type: "page.select" });
            case "instance.openAudit":
                return await this.dispatch({ page: "audit", type: "page.select" });
            case "approval.open":
                this.#openApprovalActionMenu(intent.instance, intent.approvalId);
                return true;
            case "approval.decide":
                await this.#onApprovalDecision(intent.instance, intent.approvalId, intent.decision);
                return true;
            case "toolForm.open":
                this.#focusManager.pushRestore("toolForm");
                this.#store.setToolForm(intent.instance, intent.toolName, '{"command":""}');
                return true;
            case "toolForm.append": {
                const form = this.#store.getState().interaction.toolForm;
                if (form === undefined) {
                    return false;
                }
                this.#store.setToolForm(form.instance, form.toolName, `${form.input}${intent.text}`);
                return true;
            }
            case "toolForm.backspace": {
                const form = this.#store.getState().interaction.toolForm;
                if (form === undefined) {
                    return false;
                }
                this.#store.setToolForm(form.instance, form.toolName, form.input.slice(0, -1));
                return true;
            }
            case "toolForm.submit": {
                const form = this.#store.getState().interaction.toolForm;
                if (form === undefined) {
                    return false;
                }
                if (await this.#onToolCall(form.instance, form.toolName, form.input)) {
                    this.#store.clearToolForm();
                    this.#focusManager.restore();
                }
                return true;
            }
            case "toolForm.cancel":
                this.#store.clearToolForm();
                this.#focusManager.restore();
                return true;
        }
    }

    async dispatchMany(intents: readonly TuiUiIntent[]): Promise<void> {
        for (const intent of intents) {
            await this.dispatch(intent);
        }
    }

    #cancel(): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        if (scope === "actionMenu") {
            this.#store.setActionMenu("", []);
            this.#focusManager.restore();
            return true;
        }
        if (scope === "confirm") {
            void this.dispatch({ type: "confirm.cancel" });
            return true;
        }
        if (scope === "search") {
            this.#store.setSearchOpen(false);
            this.#focusManager.restore();
            return true;
        }
        if (scope === "toolForm") {
            this.#store.clearToolForm();
            this.#focusManager.restore();
            return true;
        }
        if (scope === "boxDetail") {
            this.#store.setFocusScope("mainBoxes");
            return true;
        }
        if (scope === "mainBoxes") {
            const cursor = this.#store.getState().interaction.sidebarCursor;
            this.#store.setFocusScope(cursor?.kind === "instance" ? "sidebarInstances" : "sidebarPages");
            return true;
        }
        if (scope === "sidebarInstances") {
            this.#store.setSidebarCursor({ id: this.#store.getState().ui.selectedPage, kind: "page" });
            this.#store.setFocusScope("sidebarPages");
            return true;
        }
        return false;
    }

    #moveAcrossScopes(direction: "next" | "previous"): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        const boxIds = selectMainBoxIds(this.#store.getState());
        const hasBoxes = boxIds.length > 0;

        if (scope === "confirm") {
            return this.#focusManager.move(direction);
        }

        if (scope === "sidebarPages" || scope === "sidebarInstances") {
            if (!hasBoxes) {
                return false;
            }
            this.#store.setFocusScope("mainBoxes");
            this.#syncMainFocus();
            return true;
        }
        if (scope === "mainBoxes" || scope === "boxDetail") {
            const cursor = this.#store.getState().interaction.sidebarCursor;
            this.#store.setFocusScope(cursor?.kind === "instance" ? "sidebarInstances" : "sidebarPages");
            return true;
        }
        return false;
    }

    #moveWithinScope(direction: "up" | "down" | "left" | "right"): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        if (scope === "boxDetail") {
            return (direction === "up" || direction === "down") && this.#focusManager.move(direction);
        }
        const moved = this.#focusManager.move(direction);
        if (moved && scope === "mainBoxes") {
            this.#ensureMainFocusVisible();
        }
        return moved;
    }

    async #activateCurrentScope(): Promise<boolean> {
        const scope = this.#store.getState().interaction.focusScope;
        if (scope === "sidebarPages" || scope === "sidebarInstances") {
            const cursor = this.#store.getState().interaction.sidebarCursor;
            if (cursor?.kind === "page") {
                this.#store.setSelectedPage(cursor.id);
                this.#syncMainFocus();
                if (cursor.id === "logs" && this.#store.getState().ui.selectedInstance !== undefined) {
                    await this.#onLogsReload();
                    this.#store.setScreenStatus("logs", "Logs reloaded from instance.readLogs.");
                }
                return true;
            }
            if (cursor?.kind === "instance") {
                this.#store.setSelectedInstance(cursor.id);
                this.#syncMainFocus();
                if (this.#store.getState().ui.selectedPage === "logs") {
                    await this.#onLogsReload();
                    this.#store.setScreenStatus("logs", "Logs reloaded from instance.readLogs.");
                }
                return true;
            }
        }
        if (scope === "mainBoxes") {
            const state = this.#store.getState();
            const boxId = state.ui.mainFocusId;
            if (boxId === undefined) {
                return false;
            }
            const box = selectMainScreenModel(state).boxes.find((candidate) => candidate.id === boxId);
            if (box === undefined || box.expandedLines.length === 0) {
                return false;
            }
            if (!box.expanded) {
                this.#store.toggleExpanded(this.#expandedKey(boxId));
            }
            this.#store.setSelectedDetailLine(this.#expandedKey(boxId), box.selectedDetailLineId ?? box.expandedLines[0].id);
            this.#store.setFocusScope("boxDetail");
            this.#ensureMainFocusVisible();
            this.#store.setScreenStatus(this.#store.getState().ui.selectedPage, "Opened box detail.");
            return true;
        }
        if (scope === "boxDetail") {
            const state = this.#store.getState();
            const boxId = state.ui.mainFocusId;
            const instance = state.ui.selectedInstance;
            const box = selectMainScreenModel(state).boxes.find((candidate) => candidate.id === boxId);
            const lineId = box?.selectedDetailLineId;
            const actionId = boxId === undefined || lineId === undefined ? undefined : lineId.slice(`${boxId}:`.length);

            if (instance !== undefined && actionId?.startsWith("approval.action:")) {
                return await this.dispatch({ approvalId: actionId.slice("approval.action:".length), instance, type: "approval.open" });
            }
            if (instance !== undefined && actionId?.startsWith("tool.action:")) {
                return await this.dispatch({ instance, toolName: actionId.slice("tool.action:".length), type: "toolForm.open" });
            }
            if (actionId?.startsWith("instance.attachShell:")) {
                return await this.#openAttachShellConfirm(actionId.slice("instance.attachShell:".length));
            }
            this.#store.setScreenStatus(this.#store.getState().ui.selectedPage, "Detail has no action.");
            return true;
        }
        return true;
    }

    #openInstanceActionMenu(): boolean {
        const state = this.#store.getState();
        const focusedBox = selectMainScreenModel(state).boxes.find((box) => box.id === state.ui.mainFocusId);
        const instance = state.ui.selectedPage === "instances" ? this.#instanceNameFromBox(focusedBox?.id) : state.ui.selectedInstance;
        if (instance === undefined) {
            this.#store.setScreenStatus(state.ui.selectedPage, "Focus an entry before opening actions.");
            return false;
        }

        this.#focusManager.pushRestore("actionMenu");
        this.#store.setActionMenu(`Actions: ${instance}`, [
            {
                id: "instance.attachShell",
                intent: {
                    body: "This shell is not audited and is not controlled by devshell.",
                    confirmIntent: { instance, type: "instance.attachShell" },
                    confirmLabel: "Attach Shell",
                    title: "UNMANAGED SHELL",
                    type: "overlay.openConfirm"
                },
                label: state.ui.selectedPage === "instances" ? "Attach Shell" : `Attach Shell to ${instance}`
            },
            { id: "instance.start", intent: { instance, type: "instance.start" }, label: "Start Worker" },
            {
                id: "instance.stop",
                intent: {
                    body: `Stop Worker for ${instance}?`,
                    confirmIntent: { instance, type: "instance.stop" },
                    confirmLabel: "Stop Worker",
                    title: "Confirm Stop Worker",
                    type: "overlay.openConfirm"
                },
                label: "Stop Worker"
            },
            { id: "instance.refresh", intent: { instance, type: "instance.refresh" }, label: "Refresh Status" },
            { id: "instance.logs", intent: { type: "instance.openLogs" }, label: "Open Logs" },
            { id: "instance.audit", intent: { type: "instance.openAudit" }, label: "Open Audit" },
            { id: "instance.callTool", intent: { instance, toolName: "bash_run", type: "toolForm.open" }, label: "Call Tool" }
        ]);
        this.#store.setFocusScope("actionMenu");
        return true;
    }

    async #openAttachShellConfirm(instance: string): Promise<boolean> {
        return this.dispatch({
            body: "This shell is not audited and is not controlled by devshell.",
            confirmIntent: { instance, type: "instance.attachShell" },
            confirmLabel: "Attach Shell",
            title: "UNMANAGED SHELL",
            type: "overlay.openConfirm"
        });
    }

    #openApprovalActionMenu(instance: string, approvalId: string): void {
        this.#focusManager.pushRestore("actionMenu");
        this.#store.setActionMenu(`Approval: ${approvalId}`, [
            { id: "approval.approve", intent: { approvalId, decision: "approve", instance, type: "approval.decide" }, label: "Approve" },
            { id: "approval.deny", intent: { approvalId, decision: "deny", instance, type: "approval.decide" }, label: "Deny" },
            { id: "approval.cancel", intent: { type: "overlay.closeActionMenu" }, label: "Cancel" }
        ]);
        this.#store.setFocusScope("actionMenu");
    }

    #syncMainFocus(): void {
        const boxIds = selectMainBoxIds(this.#store.getState());
        if (boxIds.length === 0) {
            this.#store.setMainFocusId(undefined);
            return;
        }
        const current = this.#store.getState().ui.mainFocusId;
        if (current === undefined || !boxIds.includes(current)) {
            this.#store.setMainFocusId(boxIds[0]);
        }
        this.#ensureMainFocusVisible();
    }

    #expandedKey(boxId: string): string {
        const state = this.#store.getState();
        return selectMainScreenModel(state).boxes.find((box) => box.id === boxId)?.expandedKey ?? `${state.ui.selectedPage}:${state.ui.selectedInstance}:${boxId}`;
    }

    #instanceNameFromBox(boxId: string | undefined): string | undefined {
        return boxId?.startsWith("instance:") ? boxId.slice("instance:".length) : undefined;
    }

    #scrollMainColumn(delta: number): boolean {
        const key = selectMainScrollKey(this.#store.getState());
        const current = this.#store.getState().ui.scrollOffsets[key] ?? 0;
        const next = clamp(delta === 0 ? current : current + delta, 0, this.#maxMainScrollOffset());
        this.#store.setScrollOffset(key, next);
        return true;
    }

    #setMainColumnOffset(offset: number): boolean {
        const key = selectMainScrollKey(this.#store.getState());
        this.#store.setScrollOffset(key, clamp(offset, 0, this.#maxMainScrollOffset()));
        return true;
    }

    #ensureMainFocusVisible(): void {
        const state = this.#store.getState();
        const boxId = state.ui.mainFocusId;
        if (boxId === undefined) {
            return;
        }

        const metrics = selectMainBoxFlowMetrics(state);
        const range = metrics.boxRanges[boxId];
        if (range === undefined) {
            return;
        }

        const viewportRows = this.#boxViewportRows();
        if (viewportRows <= 0) {
            return;
        }

        const current = state.ui.scrollOffsets[metrics.scrollKey] ?? 0;
        if (range.start < current) {
            this.#store.setScrollOffset(metrics.scrollKey, range.start);
            return;
        }

        if (range.end > current + viewportRows) {
            this.#store.setScrollOffset(metrics.scrollKey, clamp(range.end - viewportRows, 0, this.#maxMainScrollOffset()));
        }
    }

    #boxViewportRows(): number {
        const model = selectMainScreenModel(this.#store.getState());
        return Math.max(0, this.#mainViewportRows() - 1 - (model.statusLine === undefined ? 0 : 1) - (model.emptyState === undefined ? 0 : 1));
    }

    #maxMainScrollOffset(): number {
        const metrics = selectMainBoxFlowMetrics(this.#store.getState());
        return Math.max(0, metrics.totalLines - this.#boxViewportRows());
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
