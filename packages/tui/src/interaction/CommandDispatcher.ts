import type { InstanceCreateDraft, InstanceCreateSchema, InstanceCreateSummary, JsonValue } from "@portable-devshell/shared";

import type { TuiAppStore } from "../store/TuiAppStore.js";
import { asRecord, cloneRecord, editorDraft, inputValue, normalizeDraftForSave, readPath, removeInputValue, setPath } from "../store/page/EditorSupport.js";
import { selectMainBoxFlowMetrics, selectMainBoxIds, selectMainScreenModel, selectMainScrollKey } from "../store/TuiSelectors.js";
import { TuiFocusManager } from "./TuiFocusManager.js";
import type { TuiEditorState, TuiUiIntent } from "./TuiInteractionTypes.js";

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
    onApplyConfig?(): Promise<void>;
    onCreateInstance?(draft: InstanceCreateDraft): Promise<void>;
    onGetInstanceCreateSchema?(): Promise<InstanceCreateSchema>;
    onInstanceConfigUpdate?(instance: Record<string, JsonValue>): Promise<void>;
    onInstanceDangerAction?(action: "delete" | "disable", instance: string): Promise<void>;
    onMcpConfigUpdate?(mcp: Record<string, JsonValue>): Promise<void>;
    onValidateConfigDraft?(draft: Record<string, JsonValue>): Promise<void>;
    onValidateInstanceCreateDraft?(draft: InstanceCreateDraft): Promise<InstanceCreateSummary>;
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
    readonly #onApplyConfig: () => Promise<void>;
    readonly #onCreateInstance: (draft: InstanceCreateDraft) => Promise<void>;
    readonly #onGetInstanceCreateSchema: () => Promise<InstanceCreateSchema>;
    readonly #onInstanceConfigUpdate: (instance: Record<string, JsonValue>) => Promise<void>;
    readonly #onInstanceDangerAction: (action: "delete" | "disable", instance: string) => Promise<void>;
    readonly #onMcpConfigUpdate: (mcp: Record<string, JsonValue>) => Promise<void>;
    readonly #onValidateConfigDraft: (draft: Record<string, JsonValue>) => Promise<void>;
    readonly #onValidateInstanceCreateDraft: (draft: InstanceCreateDraft) => Promise<InstanceCreateSummary>;
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
        this.#onApplyConfig = options.onApplyConfig ?? unavailable;
        this.#onCreateInstance = options.onCreateInstance ?? unavailable;
        this.#onGetInstanceCreateSchema = options.onGetInstanceCreateSchema ?? unavailable;
        this.#onInstanceConfigUpdate = options.onInstanceConfigUpdate ?? unavailable;
        this.#onInstanceDangerAction = options.onInstanceDangerAction ?? unavailable;
        this.#onMcpConfigUpdate = options.onMcpConfigUpdate ?? unavailable;
        this.#onValidateConfigDraft = options.onValidateConfigDraft ?? unavailable;
        this.#onValidateInstanceCreateDraft = options.onValidateInstanceCreateDraft ?? unavailable;
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
            case "instance.disable":
                await this.#onInstanceDangerAction("disable", intent.instance);
                return true;
            case "instance.delete":
                await this.#onInstanceDangerAction("delete", intent.instance);
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
            case "editor.open":
                this.#store.setEditor({ editing: false, key: intent.key, kind: intent.kind, ...(intent.schema === undefined ? {} : { schema: intent.schema }), ...(intent.kind === "create" ? { step: 1 } : {}) });
                this.#store.setFocusScope(intent.kind === "create" ? "wizard" : "form");
                return true;
            case "editor.close":
                this.#closeEditor();
                return true;
            case "editor.append":
                return this.#editFocusedField(intent.text, false);
            case "editor.backspace":
                return this.#editFocusedField("", true);
            case "editor.validate":
                return await this.#validateEditor();
            case "editor.save":
                return await this.#saveEditor();
            case "editor.discard":
                return await this.#discardEditor();
            case "wizard.step":
                return this.#changeWizardStep(intent.direction);
        }
    }

    async dispatchMany(intents: readonly TuiUiIntent[]): Promise<void> {
        for (const intent of intents) {
            await this.dispatch(intent);
        }
    }

    #cancel(): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        if (scope === "form" || scope === "wizard") {
            void this.#discardEditor();
            return true;
        }
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

        if (scope === "form" || scope === "wizard") {
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
        if (scope === "boxDetail" || scope === "form" || scope === "wizard") {
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
            return this.#focusManager.currentFocus()?.kind === "line" ? await this.#activateDetailLine() : false;
        }
        if (scope === "boxDetail") {
            return await this.#activateDetailLine();
        }
        if (scope === "form" || scope === "wizard") {
            return await this.#activateEditorFocus();
        }
        return true;
    }

    async #activateDetailLine(): Promise<boolean> {
            const state = this.#store.getState();
            const boxId = state.ui.mainFocusId;
            const instance = state.ui.selectedInstance;
            const box = selectMainScreenModel(state).boxes.find((candidate) => candidate.id === boxId);
            const lineId = box?.selectedDetailLineId;
            const actionId = boxId === undefined || lineId === undefined ? undefined : lineId.slice(`${boxId}:`.length);

            if ((state.ui.selectedPage === "config" || state.ui.selectedPage === "connector") && boxId !== undefined && lineId !== undefined) {
                return this.#openPageEditor(state.ui.selectedPage, boxId);
            }

            const button = actionId?.startsWith("button:") ? actionId.slice("button:".length) : undefined;

            if (button !== undefined && state.ui.selectedPage === "instances") {
                return await this.#activateInstanceButton(boxId, button);
            }
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

    async #openCreateWizard(): Promise<boolean> {
        try {
            const schema = await this.#onGetInstanceCreateSchema();
            const key = "create";
            if (this.#store.getState().ui.formDrafts[key] === undefined) {
                this.#store.setFormDraft(key, {
                    enabled: schema.defaultEnabled,
                    mcp: { allowTools: [...schema.defaultAllowTools], enabled: schema.defaultMcpEnabled },
                    name: "",
                    provider: schema.defaultProvider,
                    security: { mode: schema.defaultSecurityMode },
                    workspace: ""
                }, false);
            }
            this.#store.setMainFocusId("create-wizard");
            if (this.#store.getState().ui.expandedBoxes["instances:all:create-wizard"] !== true) {
                this.#store.toggleExpanded("instances:all:create-wizard");
            }
            await this.dispatch({ key, kind: "create", schema, type: "editor.open" });
            this.#selectFirstEditorItem();
            return true;
        } catch (error) {
            this.#store.setScreenStatus("instances", `Create setup failed: ${readErrorMessage(error)}`);
            return false;
        }
    }

    #openPageEditor(kind: "config" | "connector", boxId: string): boolean {
        const state = this.#store.getState();
        const instance = state.ui.selectedInstance;
        if (instance === undefined) {
            return false;
        }
        const key = kind === "config" ? `config:${instance}` : `connector:${instance}`;
        if (state.ui.formDrafts[key] === undefined) {
            const source = kind === "config" ? this.#instanceDraft(instance) : this.#mcpDraft();
            this.#store.setFormDraft(key, source, false);
        }
        const box = selectMainScreenModel(this.#store.getState()).boxes.find((candidate) => candidate.id === boxId);
        if (box !== undefined && !box.expanded) {
            this.#store.toggleExpanded(box.expandedKey);
        }
        this.#store.setMainFocusId(boxId);
        this.#store.setEditor({ editing: false, key, kind });
        this.#store.setFocusScope("form");
        this.#selectFirstEditorItem();
        return true;
    }

    async #activateInstanceButton(boxId: string | undefined, button: string): Promise<boolean> {
        const instance = this.#instanceNameFromBox(boxId);
        if (instance === undefined) {
            if (button === "create") {
                return await this.#openCreateWizard();
            }
            return false;
        }
        switch (button) {
            case "attach-shell":
                return await this.#openAttachShellConfirm(instance);
            case "open-config":
                this.#store.setSelectedInstance(instance);
                return await this.dispatch({ page: "config", type: "page.select" });
            case "open-connector":
                this.#store.setSelectedInstance(instance);
                return await this.dispatch({ page: "connector", type: "page.select" });
            case "open-audit":
                this.#store.setSelectedInstance(instance);
                return await this.dispatch({ page: "audit", type: "page.select" });
            case "open-logs":
                this.#store.setSelectedInstance(instance);
                return await this.dispatch({ page: "logs", type: "page.select" });
            case "disable":
                return await this.dispatch({
                    body: `Disable ${instance}?`,
                    confirmIntent: { instance, type: "instance.disable" },
                    confirmLabel: "Disable",
                    title: "Confirm Disable",
                    type: "overlay.openConfirm"
                });
            case "delete":
                return await this.dispatch({
                    body: `Delete ${instance}? This cannot be undone.`,
                    confirmIntent: { instance, type: "instance.delete" },
                    confirmLabel: "Delete",
                    title: "Confirm Delete",
                    type: "overlay.openConfirm"
                });
            default:
                return false;
        }
    }

    async #activateEditorFocus(): Promise<boolean> {
        const state = this.#store.getState();
        const editor = state.interaction.editor;
        const boxId = state.ui.mainFocusId;
        if (editor === undefined || boxId === undefined) {
            return false;
        }
        const lineId = state.interaction.selectedDetailLineIds[this.#expandedKey(boxId)];
        const action = lineId?.slice(`${boxId}:`.length);
        if (action?.startsWith("button:")) {
            switch (action.slice("button:".length)) {
                case "save":
                    return await this.#saveEditor();
                case "cancel":
                    return await this.#discardEditor();
                case "validate":
                    return await this.#validateEditor();
                case "create":
                    return await this.#createFromWizard();
                case "back":
                    return this.#changeWizardStep("previous");
                case "next":
                    return this.#changeWizardStep("next");
                case "disable":
                case "delete": {
                    const instance = state.ui.selectedInstance;
                    if (instance === undefined) {
                        return false;
                    }
                    return await this.dispatch({
                        body: `${action.slice("button:".length) === "delete" ? "Delete" : "Disable"} ${instance}?`,
                        confirmIntent: { instance, type: action.slice("button:".length) === "delete" ? "instance.delete" : "instance.disable" },
                        confirmLabel: action.slice("button:".length) === "delete" ? "Delete" : "Disable",
                        title: action.slice("button:".length) === "delete" ? "Confirm Delete" : "Confirm Disable",
                        type: "overlay.openConfirm"
                    });
                }
                default:
                    return false;
            }
        }
        if (action?.startsWith("field:")) {
            const field = action.slice("field:".length);
            const target = this.#draftTarget(field);
            const draft = this.#editorDraft(target.key, target.fallback);
            const current = readPath(draft, target.path);
            if (typeof current === "boolean") {
                this.#store.setFormDraft(target.key, setPath(draft, target.path, !current));
                return true;
            }
            this.#store.setEditor({ ...editor, editing: true, error: undefined });
            return true;
        }
        return false;
    }

    #editFocusedField(input: string, backspace: boolean): boolean {
        const editor = this.#store.getState().interaction.editor;
        const boxId = this.#store.getState().ui.mainFocusId;
        if (editor === undefined || boxId === undefined) {
            return false;
        }
        const lineId = this.#store.getState().interaction.selectedDetailLineIds[this.#expandedKey(boxId)];
        const action = lineId?.slice(`${boxId}:`.length);
        if (!editor.editing || action?.startsWith("field:") !== true) {
            return false;
        }
        const target = this.#draftTarget(action.slice("field:".length));
        const draft = this.#editorDraft(target.key, target.fallback);
        const current = readPath(draft, target.path);
        this.#store.setFormDraft(target.key, setPath(draft, target.path, backspace ? removeInputValue(current) : inputValue(current, input)));
        return true;
    }

    async #validateEditor(): Promise<boolean> {
        const editor = this.#store.getState().interaction.editor;
        if (editor === undefined) {
            return false;
        }
        try {
            if (editor.kind === "create") {
                const draft = normalizeDraftForSave(this.#editorDraft(editor.key, defaultCreateDraft()));
                const summary = await this.#onValidateInstanceCreateDraft(draft as unknown as InstanceCreateDraft);
                this.#store.setFormDraft(editor.key, draft);
                this.#store.setEditor({ ...editor, editing: false, error: undefined, summary: summary as unknown as JsonValue });
                return true;
            }
            const draft = this.#fullConfigDraft(editor.kind === "connector");
            this.#assertPublicAuth(draft);
            await this.#onValidateConfigDraft(draft);
            this.#store.setEditor({ ...editor, editing: false, error: undefined });
            return true;
        } catch (error) {
            this.#store.setEditor({ ...editor, editing: false, error: readErrorMessage(error) });
            return false;
        }
    }

    async #saveEditor(): Promise<boolean> {
        const editor = this.#store.getState().interaction.editor;
        const instance = this.#store.getState().ui.selectedInstance;
        if (editor === undefined) {
            return false;
        }
        if (editor.kind === "create") {
            return await this.#createFromWizard();
        }
        if (instance === undefined) {
            return false;
        }
        if (!(await this.#validateEditor())) {
            return false;
        }
        try {
            const instanceDraft = normalizeDraftForSave(this.#editorDraft(`config:${instance}`, this.#instanceDraft(instance)));
            await this.#onInstanceConfigUpdate(instanceDraft);
            if (editor.kind === "connector") {
                await this.#onMcpConfigUpdate(normalizeDraftForSave(this.#editorDraft(`connector:${instance}`, this.#mcpDraft())));
            }
            await this.#onApplyConfig();
            this.#store.setFormDraft(`config:${instance}`, instanceDraft, false);
            if (editor.kind === "connector") {
                this.#store.setFormDraft(`connector:${instance}`, this.#editorDraft(`connector:${instance}`, this.#mcpDraft()), false);
            }
            this.#store.setEditor({ ...editor, editing: false, error: undefined });
            this.#store.setScreenStatus(this.#store.getState().ui.selectedPage, "Saved through control RPC.");
            return true;
        } catch (error) {
            this.#store.setEditor({ ...editor, editing: false, error: readErrorMessage(error) });
            return false;
        }
    }

    async #createFromWizard(): Promise<boolean> {
        const editor = this.#store.getState().interaction.editor;
        if (editor?.kind !== "create") {
            return false;
        }
        if (!(await this.#validateEditor())) {
            return false;
        }
        try {
            await this.#onCreateInstance(normalizeDraftForSave(this.#editorDraft(editor.key, defaultCreateDraft())) as unknown as InstanceCreateDraft);
            this.#store.clearFormDraft(editor.key);
            this.#closeEditor();
            this.#store.setScreenStatus("instances", "Created through control RPC.");
            return true;
        } catch (error) {
            this.#store.setEditor({ ...editor, error: readErrorMessage(error) });
            return false;
        }
    }

    async #discardEditor(): Promise<boolean> {
        const editor = this.#store.getState().interaction.editor;
        if (editor === undefined) {
            return false;
        }
        if (this.#editorDraftKeys(editor).some((key) => this.#store.getState().ui.dirtyForms[key] === true)) {
            return await this.dispatch({
                body: "Discard unsaved changes?",
                confirmIntent: { type: "editor.close" },
                confirmLabel: "Discard",
                title: "Discard Unsaved Changes",
                type: "overlay.openConfirm"
            });
        }
        this.#closeEditor();
        return true;
    }

    #closeEditor(): void {
        const editor = this.#store.getState().interaction.editor;
        if (editor !== undefined) {
            for (const key of this.#editorDraftKeys(editor)) {
                this.#store.clearFormDraft(key);
            }
        }
        this.#store.setEditor(undefined);
        this.#store.setFocusScope("mainBoxes");
        this.#syncMainFocus();
    }

    #changeWizardStep(direction: "next" | "previous"): boolean {
        const editor = this.#store.getState().interaction.editor;
        if (editor?.kind !== "create") {
            return false;
        }
        const step = Math.min(5, Math.max(1, (editor.step ?? 1) + (direction === "next" ? 1 : -1)));
        this.#store.setEditor({ ...editor, editing: false, step });
        this.#selectFirstEditorItem();
        return true;
    }

    #selectFirstEditorItem(): void {
        const boxId = this.#store.getState().ui.mainFocusId;
        const box = boxId === undefined ? undefined : selectMainScreenModel(this.#store.getState()).boxes.find((candidate) => candidate.id === boxId);
        const line = box?.expandedLines.find((candidate) => candidate.id?.includes(":field:") === true || candidate.id?.includes(":button:") === true);
        if (box !== undefined && line?.id !== undefined) {
            this.#store.setSelectedDetailLine(box.expandedKey, line.id);
        }
    }

    #draftTarget(field: string): { fallback: Record<string, JsonValue>; key: string; path: string } {
        const editor = this.#store.getState().interaction.editor!;
        const instance = this.#store.getState().ui.selectedInstance;
        if (editor.kind === "create") {
            return { fallback: defaultCreateDraft(), key: editor.key, path: field };
        }
        if (editor.kind === "connector" && field.startsWith("instance.")) {
            const name = instance!;
            return { fallback: this.#instanceDraft(name), key: `config:${name}`, path: field.slice("instance.".length) };
        }
        return {
            fallback: editor.kind === "connector" ? this.#mcpDraft() : this.#instanceDraft(instance!),
            key: editor.key,
            path: field
        };
    }

    #editorDraft(key: string, fallback: Record<string, JsonValue>): Record<string, JsonValue> {
        return editorDraft(this.#store.getState(), key, fallback);
    }

    #editorDraftKeys(editor: TuiEditorState): string[] {
        if (editor.kind !== "connector") {
            return [editor.key];
        }

        const instance = this.#store.getState().ui.selectedInstance;
        return instance === undefined ? [editor.key] : [editor.key, `config:${instance}`];
    }

    #instanceDraft(instanceName: string): Record<string, JsonValue> {
        const configView = this.#store.getState().configView;
        const entries = configView?.instances;
        const entry = Array.isArray(entries)
            ? entries.find((value) => asRecord(value)?.name === instanceName)
            : undefined;
        return cloneRecord(asRecord(entry) ?? { enabled: true, mcp: { allowTools: [], enabled: true, path: `/${instanceName}/mcp` }, name: instanceName, provider: "local", security: { mode: "disabled" }, workspace: "" });
    }

    #mcpDraft(): Record<string, JsonValue> {
        return cloneRecord(asRecord(this.#store.getState().configView?.mcp) ?? { auth: { mode: "none" }, enabled: false, listenHost: "127.0.0.1", listenPort: 0 });
    }

    #fullConfigDraft(includeMcp: boolean): Record<string, JsonValue> {
        const state = this.#store.getState();
        const instance = state.ui.selectedInstance!;
        const config = cloneRecord(state.configView ?? { control: {}, instances: [], mcp: this.#mcpDraft(), version: 1 });
        const rawInstances = config.instances;
        const instances = Array.isArray(rawInstances)
            ? rawInstances.map((entry) =>
                  asRecord(entry)?.name === instance ? normalizeDraftForSave(this.#editorDraft(`config:${instance}`, this.#instanceDraft(instance))) : entry
              )
            : [];
        config.instances = instances;
        if (includeMcp) {
            config.mcp = normalizeDraftForSave(this.#editorDraft(`connector:${instance}`, this.#mcpDraft()));
        }
        return config;
    }

    #assertPublicAuth(config: Record<string, JsonValue>): void {
        const mcp = asRecord(config.mcp);
        const auth = asRecord(mcp?.auth);
        const baseUrl = mcp?.publicBaseUrl;
        const publicHost = mcp?.listenHost === "0.0.0.0";
        const publicUrl = typeof baseUrl === "string" && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(baseUrl);
        if ((publicHost || publicUrl) && auth?.mode === "none") {
            throw new Error("auth.mode=none cannot expose a non-local endpoint.");
        }
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

function defaultCreateDraft(): Record<string, JsonValue> {
    return {
        enabled: true,
        mcp: { allowTools: ["bash_run"], enabled: true },
        name: "",
        provider: "local",
        security: { mode: "disabled" },
        workspace: ""
    };
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function unavailable(): Promise<never> {
    throw new Error("Control RPC handler is unavailable.");
}
