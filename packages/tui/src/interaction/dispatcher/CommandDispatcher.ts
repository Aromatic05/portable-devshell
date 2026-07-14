import type { InstanceCreateDraft, InstanceCreateSchema, InstanceCreateSummary, JsonValue } from "@portable-devshell/shared";

import type { TuiAppStore } from "../../store/TuiAppStore.js";
import { selectMainBoxIds, selectMainScreenModel } from "../../store/TuiSelectors.js";
import { TuiFocusManager } from "../TuiFocusManager.js";
import type { TuiUiIntent } from "../TuiInteractionTypes.js";
import { CommandDispatcherAudit } from "./CommandDispatcherAudit.js";
import { CommandDispatcherEditor } from "./CommandDispatcherEditor.js";
import { CommandDispatcherDetail } from "./CommandDispatcherDetail.js";
import { CommandDispatcherFocus } from "./CommandDispatcherFocus.js";

export interface CommandDispatcherOptions {
    focusManager: TuiFocusManager;
    onApprovalDecision(instance: string, approvalId: string, decision: "approve" | "deny"): Promise<void>;
    onArtifactRevokeShare?(shareId: string): Promise<void>;
    onArtifactCancelTransfer?(transferId: string): Promise<void>;
    onInstanceAction(action: "refresh" | "restart" | "start" | "stop", instance: string): Promise<void>;
    onAttachShell(instance: string): Promise<void>;
    mainViewportRows(): number;
    onLogsReload(): Promise<void>;
    onPageReload(page: import("../../model/TuiUiTypes.js").PageId, instance: string | undefined): Promise<void>;
    onQuit(): Promise<void>;
    onRedraw(): void;
    onToolCall(instance: string, toolName: string, input: string): Promise<boolean>;
    onApplyConfig?(): Promise<JsonValue>;
    onControlRestart?(): Promise<void>;
    onCreateInstance?(draft: InstanceCreateDraft): Promise<string | undefined>;
    onGetInstanceCreateSchema?(): Promise<InstanceCreateSchema>;
    onInstanceConfigUpdate?(instance: Record<string, JsonValue>): Promise<void>;
    onInstanceDangerAction?(action: "delete", instance: string): Promise<void>;
    onInstanceEnabledChange?(instance: string, enabled: boolean): Promise<void>;
    onMcpConfigUpdate?(mcp: Record<string, JsonValue>): Promise<void>;
    onOAuthApprovalDecision?(approvalId: string, decision: "approve" | "deny"): Promise<void>;
    onValidateConfigDraft?(draft: Record<string, JsonValue>): Promise<void>;
    onValidateInstanceCreateDraft?(draft: InstanceCreateDraft): Promise<InstanceCreateSummary>;
    store: TuiAppStore;
}

export class CommandDispatcher {
    readonly #focusManager: TuiFocusManager;
    readonly #onApprovalDecision: CommandDispatcherOptions["onApprovalDecision"];
    readonly #onArtifactRevokeShare: (shareId: string) => Promise<void>;
    readonly #onArtifactCancelTransfer: (transferId: string) => Promise<void>;
    readonly #onInstanceAction: CommandDispatcherOptions["onInstanceAction"];
    readonly #onAttachShell: CommandDispatcherOptions["onAttachShell"];
    readonly #mainViewportRows: () => number;
    readonly #onLogsReload: () => Promise<void>;
    readonly #onPageReload: CommandDispatcherOptions["onPageReload"];
    readonly #onQuit: () => Promise<void>;
    readonly #onRedraw: () => void;
    readonly #onToolCall: CommandDispatcherOptions["onToolCall"];
    readonly #onApplyConfig: () => Promise<JsonValue>;
    readonly #onControlRestart: () => Promise<void>;
    readonly #onCreateInstance: (draft: InstanceCreateDraft) => Promise<string | undefined>;
    readonly #onGetInstanceCreateSchema: () => Promise<InstanceCreateSchema>;
    readonly #onInstanceConfigUpdate: (instance: Record<string, JsonValue>) => Promise<void>;
    readonly #onInstanceDangerAction: (action: "delete", instance: string) => Promise<void>;
    readonly #onInstanceEnabledChange: (instance: string, enabled: boolean) => Promise<void>;
    readonly #onMcpConfigUpdate: (mcp: Record<string, JsonValue>) => Promise<void>;
    readonly #onOAuthApprovalDecision: (approvalId: string, decision: "approve" | "deny") => Promise<void>;
    readonly #onValidateConfigDraft: (draft: Record<string, JsonValue>) => Promise<void>;
    readonly #onValidateInstanceCreateDraft: (draft: InstanceCreateDraft) => Promise<InstanceCreateSummary>;
    readonly #store: TuiAppStore;
    readonly #audit: CommandDispatcherAudit;
    readonly #editor: CommandDispatcherEditor;
    readonly #detail: CommandDispatcherDetail;
    readonly #focus: CommandDispatcherFocus;

    constructor(options: CommandDispatcherOptions) {
        this.#focusManager = options.focusManager;
        this.#onApprovalDecision = options.onApprovalDecision;
        this.#onArtifactRevokeShare = options.onArtifactRevokeShare ?? unavailable;
        this.#onArtifactCancelTransfer = options.onArtifactCancelTransfer ?? unavailable;
        this.#onInstanceAction = options.onInstanceAction;
        this.#onAttachShell = options.onAttachShell;
        this.#mainViewportRows = options.mainViewportRows;
        this.#onLogsReload = options.onLogsReload;
        this.#onPageReload = options.onPageReload;
        this.#onQuit = options.onQuit;
        this.#onRedraw = options.onRedraw;
        this.#onToolCall = options.onToolCall;
        this.#onApplyConfig = options.onApplyConfig ?? unavailable;
        this.#onControlRestart = options.onControlRestart ?? unavailable;
        this.#onCreateInstance = options.onCreateInstance ?? unavailable;
        this.#onGetInstanceCreateSchema = options.onGetInstanceCreateSchema ?? unavailable;
        this.#onInstanceConfigUpdate = options.onInstanceConfigUpdate ?? unavailable;
        this.#onInstanceDangerAction = options.onInstanceDangerAction ?? unavailable;
        this.#onInstanceEnabledChange = options.onInstanceEnabledChange ?? unavailable;
        this.#onMcpConfigUpdate = options.onMcpConfigUpdate ?? unavailable;
        this.#onOAuthApprovalDecision = options.onOAuthApprovalDecision ?? unavailable;
        this.#onValidateConfigDraft = options.onValidateConfigDraft ?? unavailable;
        this.#onValidateInstanceCreateDraft = options.onValidateInstanceCreateDraft ?? unavailable;
        this.#store = options.store;
        this.#focus = new CommandDispatcherFocus({ mainViewportRows: this.#mainViewportRows, store: this.#store });
        this.#audit = new CommandDispatcherAudit({ dispatch: (intent) => this.dispatch(intent), store: this.#store });
        this.#editor = new CommandDispatcherEditor({
            dispatch: (intent) => this.dispatch(intent),
            onApplyConfig: this.#onApplyConfig,
            onCreateInstance: this.#onCreateInstance,
            onGetInstanceCreateSchema: this.#onGetInstanceCreateSchema,
            onInstanceAction: this.#onInstanceAction,
            onInstanceConfigUpdate: this.#onInstanceConfigUpdate,
            onMcpConfigUpdate: this.#onMcpConfigUpdate,
            onValidateConfigDraft: this.#onValidateConfigDraft,
            onValidateInstanceCreateDraft: this.#onValidateInstanceCreateDraft,
            store: this.#store,
            syncMainFocus: () => this.#focus.syncMainFocus()
        });
        this.#detail = new CommandDispatcherDetail({
            audit: this.#audit,
            dispatch: (intent) => this.dispatch(intent),
            editor: this.#editor,
            focus: this.#focus,
            onOAuthApprovalDecision: this.#onOAuthApprovalDecision,
            store: this.#store
        });
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
                this.#focus.syncMainFocus();
                if (intent.page === "logs" && this.#store.getState().ui.selectedInstance !== undefined) {
                    await this.#onLogsReload();
                    this.#store.setScreenStatus("logs", "Logs reloaded from instance.readLogs.");
                }
                return true;
            case "instance.selectIndex": {
                const entry = this.#store.getState().instances[intent.index];
                if (entry === undefined) {
                    this.#store.setScreenStatus(this.#store.getState().ui.selectedPage, `Instance ${intent.index + 1} is unavailable.`);
                    return false;
                }
                this.#store.setSelectedInstance(entry.name);
                this.#store.setSidebarCursor({ id: entry.name, kind: "instance" });
                this.#focus.syncMainFocus();
                return true;
            }
            case "control.restart":
                await this.#onControlRestart();
                this.#store.setControlRestartRequired(false);
                this.#store.setScreenStatus("connector", "Control runtime restarted and MCP configuration reloaded.");
                return true;
            case "page.reload": {
                const state = this.#store.getState();
                try {
                    await this.#onPageReload(state.ui.selectedPage, state.ui.selectedInstance);
                    this.#store.setScreenStatus(state.ui.selectedPage, "Page reloaded.");
                    this.#focus.syncMainFocus();
                    return true;
                } catch (error) {
                    this.#store.setScreenStatus(state.ui.selectedPage, `Reload failed: ${readErrorMessage(error)}`);
                    return false;
                }
            }
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
            case "search.open": {
                const page = this.#store.getState().ui.selectedPage;
                if (!isSearchablePage(page)) {
                    return false;
                }
                this.#focusManager.pushRestore("search");
                this.#store.setSearchOpen(true);
                this.#store.setFocusScope("search");
                return true;
            }
            case "search.append": {
                const page = this.#store.getState().ui.selectedPage;
                const current = this.#store.getState().ui.searchQueries[page] ?? "";
                this.#store.setSearchQuery(page, `${current}${intent.text}`);
                this.#focus.syncMainFocus();
                return true;
            }
            case "search.backspace": {
                const page = this.#store.getState().ui.selectedPage;
                const current = this.#store.getState().ui.searchQueries[page] ?? "";
                this.#store.setSearchQuery(page, current.slice(0, -1));
                this.#focus.syncMainFocus();
                return true;
            }
            case "search.submit":
                this.#store.setSearchOpen(false);
                this.#focusManager.restore();
                return true;
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
                this.#focus.pauseLogFollow();
                return this.#focus.scrollMainColumn(-Math.max(1, this.#focus.boxViewportRows() - 1));
            case "screen.pageDown":
                return this.#focus.scrollMainColumn(Math.max(1, this.#focus.boxViewportRows() - 1));
            case "screen.home":
                this.#focus.pauseLogFollow();
                return this.#focus.setMainColumnOffset(0);
            case "screen.end":
                return this.#focus.setMainColumnOffset(this.#focus.maxMainScrollOffset());
            case "textDetail.open":
                this.#focusManager.pushRestore("textDetail");
                this.#store.setTextDetail({ body: intent.body, open: true, title: intent.title });
                this.#store.setFocusScope("textDetail");
                return true;
            case "textDetail.close":
                this.#store.setTextDetail({ body: "", open: false, title: "" });
                this.#focusManager.restore();
                return true;
            case "textDetail.scroll": {
                const detail = this.#store.getState().interaction.textDetail;
                this.#store.setTextDetail({ ...detail, scrollOffset: Math.max(0, detail.scrollOffset + intent.delta) });
                return true;
            }
            case "screen.toggle": {
                if (this.#store.getState().interaction.focusScope !== "mainBoxes") {
                    return false;
                }
                const boxId = this.#store.getState().ui.mainFocusId;
                if (boxId === undefined) {
                    return false;
                }
                const key = this.#focus.expandedKey(boxId);
                const expanded = this.#store.getState().ui.expandedBoxes[key] === true;
                this.#store.toggleExpanded(key);
                if (expanded) {
                    this.#store.setSelectedDetailLine(key, undefined);
                } else {
                    const box = selectMainScreenModel(this.#store.getState()).boxes.find((candidate) => candidate.id === boxId);
                    this.#store.setSelectedDetailLine(key, box?.expandedLines[0]?.id);
                }
                this.#focus.ensureMainFocusVisible();
                this.#store.setScreenStatus(this.#store.getState().ui.selectedPage, expanded ? "Collapsed box." : "Expanded box.");
                return true;
            }
            case "logs.toggleFollow": {
                const instance = this.#store.getState().ui.selectedInstance;
                if (this.#store.getState().ui.selectedPage !== "logs" || instance === undefined) {
                    return false;
                }
                const follow = this.#store.getState().ui.logsFollowByInstance[instance] === false;
                this.#store.setLogsFollow(instance, follow);
                if (follow) {
                    this.#store.setLogsPausedAtSeq(instance, undefined);
                    this.#focus.setMainColumnOffset(this.#focus.maxMainScrollOffset());
                } else {
                    this.#store.setLogsPausedAtSeq(instance, this.#store.getState().logsByInstance[instance]?.at(-1)?.seq);
                }
                this.#store.setScreenStatus("logs", follow ? "Following new log entries." : "Log follow paused.");
                return true;
            }
            case "logs.clearBuffer":
                if (this.#store.getState().ui.selectedPage !== "logs") {
                    return false;
                }
                this.#store.clearLogsBuffer();
                this.#store.setScreenStatus("logs", "Cleared local log buffer only.");
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
            case "instance.restart":
                await this.#onInstanceAction("restart", intent.instance);
                return true;
            case "instance.stop":
                await this.#onInstanceAction("stop", intent.instance);
                return true;
            case "instance.setEnabled":
                await this.#onInstanceEnabledChange(intent.instance, intent.enabled);
                return true;
            case "instance.attachShell":
                await this.#onAttachShell(intent.instance);
                return true;
            case "instance.delete":
                await this.#onInstanceDangerAction("delete", intent.instance);
                return true;
            case "artifact.revokeShare":
                await this.#onArtifactRevokeShare(intent.shareId);
                this.#store.setScreenStatus("instances", `Artifact share ${intent.shareId} revoked.`);
                return true;
            case "artifact.cancelTransfer":
                await this.#onArtifactCancelTransfer(intent.transferId);
                this.#store.setScreenStatus("instances", `Artifact transfer ${intent.transferId} cancellation requested.`);
                return true;
            case "approval.open":
                this.#audit.openDetail(intent.approvalId);
                return true;
            case "approval.decide":
                if (intent.decision === "deny") {
                    this.#audit.openDenyConfirm();
                    return true;
                }
                await this.#onApprovalDecision(intent.instance, intent.approvalId, intent.decision);
                this.#audit.returnToList();
                return true;
            case "oauthApproval.decide":
                await this.#onOAuthApprovalDecision(intent.approvalId, intent.decision);
                this.#store.setScreenStatus("oauth", intent.decision === "approve" ? "OAuth approval granted." : "OAuth approval denied.");
                return true;
            case "approval.confirmDeny":
                await this.#onApprovalDecision(intent.instance, intent.approvalId, "deny");
                this.#audit.returnToList();
                return true;
            case "approval.back":
                this.#audit.returnToList();
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
            case "editor.open":
                this.#store.setEditor({ editing: false, key: intent.key, kind: intent.kind, ...(intent.schema === undefined ? {} : { schema: intent.schema }), ...(intent.kind === "create" ? { step: 1 } : {}) });
                this.#store.setFocusScope(intent.kind === "create" ? "wizard" : "form");
                return true;
            case "editor.close":
                this.#editor.close();
                return true;
            case "editor.append":
                return this.#editor.editFocusedField(intent.text, false);
            case "editor.backspace":
                return this.#editor.editFocusedField("", true);
            case "editor.cursorMove":
                return this.#editor.moveCursor(intent.direction);
            case "editor.validate":
                return await this.#editor.validate();
            case "editor.save":
                return await this.#editor.save(false);
            case "editor.saveAndRestart":
                return await this.#editor.save(true);
            case "editor.reload":
                return await this.#editor.reload(false);
            case "editor.reloadConfirmed":
                return await this.#editor.reload(true);
            case "editor.discard":
                return await this.#editor.discard();
            case "wizard.step":
                return this.#editor.changeStep(intent.direction);
        }
    }

    async dispatchMany(intents: readonly TuiUiIntent[]): Promise<void> {
        for (const intent of intents) {
            await this.dispatch(intent);
        }
    }

    #cancel(): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        if (scope === "textDetail") {
            void this.dispatch({ type: "textDetail.close" });
            return true;
        }
        if (scope === "approvalDetail" || scope === "denyConfirm") {
            this.#audit.returnToList();
            return true;
        }
        if (scope === "form" || scope === "wizard") {
            void this.#editor.discard();
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

        if (scope === "confirm" || scope === "approvalDetail" || scope === "denyConfirm") {
            return this.#focusManager.move(direction);
        }

        if (scope === "form" || scope === "wizard") {
            return this.#focusManager.move(direction);
        }

        if (scope === "sidebarPages" || scope === "sidebarInstances") {
            if (!hasBoxes) {
                return false;
            }
            this.#store.setFocusScope("mainBoxes");
            this.#focus.syncMainFocus();
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
        if (scope === "textDetail") {
            void this.dispatch({ type: "textDetail.close" });
            return true;
        }
        if (scope === "approvalDetail" || scope === "denyConfirm") {
            return (direction === "up" || direction === "down") && this.#focusManager.move(direction);
        }
        if (scope === "boxDetail" || scope === "form" || scope === "wizard") {
            if (direction === "left" && scope === "boxDetail") {
                const cursor = this.#store.getState().interaction.sidebarCursor;
                this.#store.setFocusScope(cursor?.kind === "instance" ? "sidebarInstances" : "sidebarPages");
                return true;
            }
            return (direction === "up" || direction === "down") && this.#focusManager.move(direction);
        }
        if ((scope === "sidebarPages" || scope === "sidebarInstances") && direction === "right") {
            if (selectMainBoxIds(this.#store.getState()).length === 0) {
                return false;
            }
            this.#store.setFocusScope("mainBoxes");
            this.#focus.syncMainFocus();
            return true;
        }
        if (scope === "mainBoxes" && direction === "left") {
            const cursor = this.#store.getState().interaction.sidebarCursor;
            this.#store.setFocusScope(cursor?.kind === "instance" ? "sidebarInstances" : "sidebarPages");
            return true;
        }
        const moved = this.#focusManager.move(direction);
        if (moved && scope === "mainBoxes") {
            this.#focus.ensureMainFocusVisible();
        }
        return moved;
    }

    async #activateCurrentScope(): Promise<boolean> {
        const scope = this.#store.getState().interaction.focusScope;
        const state = this.#store.getState();
        if (scope === "sidebarPages" || scope === "sidebarInstances") {
            const cursor = this.#store.getState().interaction.sidebarCursor;
            if (cursor?.kind === "page") {
                this.#store.setSelectedPage(cursor.id);
                this.#focus.syncMainFocus();
                if (cursor.id === "logs" && this.#store.getState().ui.selectedInstance !== undefined) {
                    await this.#onLogsReload();
                    this.#store.setScreenStatus("logs", "Logs reloaded from instance.readLogs.");
                }
                return true;
            }
            if (cursor?.kind === "instance") {
                this.#store.setSelectedInstance(cursor.id);
                this.#focus.syncMainFocus();
                if (this.#store.getState().ui.selectedPage === "logs") {
                    await this.#onLogsReload();
                    this.#store.setScreenStatus("logs", "Logs reloaded from instance.readLogs.");
                }
                return true;
            }
        }
        if (scope === "mainBoxes") {
            const focused = this.#focusManager.currentFocus();
            if (focused?.kind === "line") {
                return await this.#detail.activate();
            }
            const approvalId = focused?.kind === "box" ? this.#focus.approvalIdFromBox(focused.id) : undefined;
            if (state.ui.selectedPage === "audit" && state.ui.selectedInstance !== undefined && approvalId !== undefined) {
                return await this.dispatch({ approvalId, instance: state.ui.selectedInstance, type: "approval.open" });
            }
            return await this.dispatch({ type: "screen.toggle" });
        }
        if (scope === "boxDetail") {
            return await this.#detail.activate();
        }
        if (scope === "textDetail") {
            void this.dispatch({ type: "textDetail.close" });
            return true;
        }
        if (scope === "approvalDetail" || scope === "denyConfirm") {
            return await this.#audit.activate();
        }
        if (scope === "form" || scope === "wizard") {
            return await this.#editor.activate();
        }
        return true;
    }


}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isSearchablePage(page: import("../../model/TuiUiTypes.js").PageId): boolean {
    return page === "instances" || page === "config" || page === "audit" || page === "logs";
}

async function unavailable(): Promise<never> {
    throw new Error("Control RPC handler is unavailable.");
}
