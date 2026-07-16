import type {
    InstanceCreateDraft,
    InstanceCreateSchema,
    InstanceCreateSummary,
    ConfigDraft,
    ConfigInstancePatch,
    ConfigMcpPatch,
    JsonValue
} from "@portable-devshell/shared";

import type { TuiFocusManager } from "../../focus/TuiFocusManager.js";
import type { TuiUiIntent } from "../../../state/TuiInteractionState.js";
import type { TuiAppStore } from "../../../state/TuiAppStore.js";
import type { TuiPageId } from "../../../state/TuiUiState.js";
import type { TuiInteractionProjection } from "../../TuiInteractionProjection.js";
import { TuiCommandDispatcherAudit } from "./TuiCommandDispatcherAudit.js";
import { TuiCommandDispatcherDetail } from "./TuiCommandDispatcherDetail.js";
import { TuiCommandDispatcherEditor } from "./TuiCommandDispatcherEditor.js";
import { TuiCommandDispatcherFocus } from "./TuiCommandDispatcherFocus.js";
import { TuiCommandDispatcherNavigation } from "./TuiCommandDispatcherNavigation.js";

export interface TuiCommandDispatcherOptions {
    focusManager: TuiFocusManager;
    onApprovalDecision(
        instance: string,
        approvalId: string,
        decision: "approve" | "deny"
    ): Promise<void>;
    onArtifactRevokeShare?(shareId: string): Promise<void>;
    onArtifactCancelTransfer?(transferId: string): Promise<void>;
    onInstanceAction(
        action: "refresh" | "restart" | "start" | "stop",
        instance: string
    ): Promise<void>;
    onAttachShell(instance: string): Promise<void>;
    mainViewportRows(): number;
    onLogsReload(): Promise<void>;
    onPageReload(page: TuiPageId, instance: string | undefined): Promise<void>;
    onQuit(): Promise<void>;
    onRedraw(): void;
    onToolCall(
        instance: string,
        toolName: string,
        input: string
    ): Promise<boolean>;
    onApplyConfig?(): Promise<JsonValue>;
    onControlRestart?(): Promise<void>;
    onCreateInstance?(draft: InstanceCreateDraft): Promise<string | undefined>;
    onGetInstanceCreateSchema?(): Promise<InstanceCreateSchema>;
    onInstanceConfigUpdate?(
        instanceName: string,
        patch: ConfigInstancePatch
    ): Promise<void>;
    onInstanceDangerAction?(action: "delete", instance: string): Promise<void>;
    onInstanceEnabledChange?(instance: string, enabled: boolean): Promise<void>;
    onMcpConfigUpdate?(mcp: ConfigMcpPatch): Promise<void>;
    onOAuthApprovalDecision?(
        approvalId: string,
        decision: "approve" | "deny"
    ): Promise<void>;
    onValidateConfigDraft?(draft: ConfigDraft): Promise<void>;
    onValidateInstanceCreateDraft?(
        draft: InstanceCreateDraft
    ): Promise<InstanceCreateSummary>;
    projection: TuiInteractionProjection;
    store: TuiAppStore;
}

export class TuiCommandDispatcher {
    readonly #audit: TuiCommandDispatcherAudit;
    readonly #detail: TuiCommandDispatcherDetail;
    readonly #editor: TuiCommandDispatcherEditor;
    readonly #focus: TuiCommandDispatcherFocus;
    readonly #focusManager: TuiFocusManager;
    readonly #navigation: TuiCommandDispatcherNavigation;
    readonly #options: TuiCommandDispatcherOptions;
    readonly #store: TuiAppStore;

    constructor(options: TuiCommandDispatcherOptions) {
        this.#focusManager = options.focusManager;
        this.#options = options;
        this.#store = options.store;
        this.#focus = new TuiCommandDispatcherFocus({
            mainViewportRows: options.mainViewportRows,
            projection: options.projection,
            store: this.#store
        });
        this.#audit = new TuiCommandDispatcherAudit({
            dispatch: (intent) => this.dispatch(intent),
            projection: options.projection,
            store: this.#store
        });
        this.#editor = new TuiCommandDispatcherEditor({
            dispatch: (intent) => this.dispatch(intent),
            onApplyConfig: options.onApplyConfig ?? unavailable,
            onCreateInstance: options.onCreateInstance ?? unavailable,
            onGetInstanceCreateSchema:
                options.onGetInstanceCreateSchema ?? unavailable,
            onInstanceAction: options.onInstanceAction,
            onInstanceConfigUpdate:
                options.onInstanceConfigUpdate ?? unavailable,
            onMcpConfigUpdate: options.onMcpConfigUpdate ?? unavailable,
            onValidateConfigDraft:
                options.onValidateConfigDraft ?? unavailable,
            onValidateInstanceCreateDraft:
                options.onValidateInstanceCreateDraft ?? unavailable,
            projection: options.projection,
            store: this.#store,
            syncMainFocus: () => this.#focus.syncMainFocus()
        });
        this.#detail = new TuiCommandDispatcherDetail({
            audit: this.#audit,
            dispatch: (intent) => this.dispatch(intent),
            editor: this.#editor,
            focus: this.#focus,
            onOAuthApprovalDecision:
                options.onOAuthApprovalDecision ?? unavailable,
            projection: options.projection,
            store: this.#store
        });
        this.#navigation = new TuiCommandDispatcherNavigation({
            dispatch: (intent) => this.dispatch(intent),
            focus: this.#focus,
            focusManager: this.#focusManager,
            onLogsReload: options.onLogsReload,
            onPageReload: options.onPageReload,
            onRedraw: options.onRedraw,
            projection: options.projection,
            store: this.#store
        });
    }

    async dispatch(intent: TuiUiIntent): Promise<boolean> {
        const navigationResult = await this.#navigation.dispatch(intent);
        if (navigationResult !== undefined) {
            return navigationResult;
        }

        switch (intent.type) {
            case "app.requestQuit":
            case "app.quit":
                await this.#options.onQuit();
                return true;
            case "control.restart":
                await (this.#options.onControlRestart ?? unavailable)();
                this.#store.setControlRestartRequired(false);
                this.#store.setScreenStatus(
                    "connector",
                    "Control runtime restarted and MCP configuration reloaded."
                );
                return true;
            case "focus.activate":
                return await this.#activateCurrentScope();
            case "ui.cancel":
                return this.#cancel();
            case "instance.start":
                await this.#options.onInstanceAction("start", intent.instance);
                return true;
            case "instance.restart":
                await this.#options.onInstanceAction("restart", intent.instance);
                return true;
            case "instance.stop":
                await this.#options.onInstanceAction("stop", intent.instance);
                return true;
            case "instance.setEnabled":
                await (this.#options.onInstanceEnabledChange ?? unavailable)(
                    intent.instance,
                    intent.enabled
                );
                return true;
            case "instance.attachShell":
                await this.#options.onAttachShell(intent.instance);
                return true;
            case "instance.delete":
                await (this.#options.onInstanceDangerAction ?? unavailable)(
                    "delete",
                    intent.instance
                );
                return true;
            case "artifact.revokeShare":
                await (this.#options.onArtifactRevokeShare ?? unavailable)(
                    intent.shareId
                );
                this.#store.setScreenStatus(
                    "instances",
                    `Artifact share ${intent.shareId} revoked.`
                );
                return true;
            case "artifact.cancelTransfer":
                await (this.#options.onArtifactCancelTransfer ?? unavailable)(
                    intent.transferId
                );
                this.#store.setScreenStatus(
                    "instances",
                    `Artifact transfer ${intent.transferId} cancellation requested.`
                );
                return true;
            case "approval.open":
                this.#audit.openDetail(intent.approvalId);
                return true;
            case "approval.decide":
                return await this.#decideApproval(
                    intent.instance,
                    intent.approvalId,
                    intent.decision
                );
            case "oauthApproval.decide":
                await (this.#options.onOAuthApprovalDecision ?? unavailable)(
                    intent.approvalId,
                    intent.decision
                );
                this.#store.setScreenStatus(
                    "oauth",
                    intent.decision === "approve"
                        ? "OAuth approval granted."
                        : "OAuth approval denied."
                );
                return true;
            case "approval.confirmDeny":
                await this.#options.onApprovalDecision(
                    intent.instance,
                    intent.approvalId,
                    "deny"
                );
                this.#audit.returnToList();
                return true;
            case "approval.back":
                this.#audit.returnToList();
                return true;
            case "toolForm.open":
                this.#focusManager.pushRestore("toolForm");
                this.#store.setToolForm(
                    intent.instance,
                    intent.toolName,
                    '{"command":""}'
                );
                return true;
            case "toolForm.append":
                return this.#updateToolForm((input) => {
                    return `${input}${intent.text}`;
                });
            case "toolForm.backspace":
                return this.#updateToolForm((input) => input.slice(0, -1));
            case "toolForm.submit":
                return await this.#submitToolForm();
            case "toolForm.cancel":
                this.#store.clearToolForm();
                this.#focusManager.restore();
                return true;
            case "editor.open":
                this.#store.setEditor({
                    editing: false,
                    key: intent.key,
                    kind: intent.kind,
                    ...(intent.schema === undefined
                        ? {}
                        : { schema: intent.schema }),
                    ...(intent.kind === "create" ? { step: 1 } : {})
                });
                this.#store.setFocusScope(
                    intent.kind === "create" ? "wizard" : "form"
                );
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
            default:
                return false;
        }
    }

    async dispatchMany(intents: readonly TuiUiIntent[]): Promise<void> {
        for (const intent of intents) {
            await this.dispatch(intent);
        }
    }

    #cancel(): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        if (scope === "approvalDetail" || scope === "denyConfirm") {
            this.#audit.returnToList();
            return true;
        }
        if (scope === "form" || scope === "wizard") {
            void this.#editor.discard();
            return true;
        }
        return this.#navigation.cancelPassiveScope();
    }

    async #activateCurrentScope(): Promise<boolean> {
        const scope = this.#store.getState().interaction.focusScope;
        const state = this.#store.getState();
        if (scope === "sidebarPages" || scope === "sidebarInstances") {
            return await this.#navigation.activateSidebarSelection();
        }
        if (scope === "mainBoxes") {
            const focused = this.#focusManager.currentFocus();
            if (focused?.kind === "line") {
                return await this.#detail.activate();
            }
            const approvalId = focused?.kind === "box"
                ? this.#focus.approvalIdFromBox(focused.id)
                : undefined;
            if (
                state.ui.selectedPage === "audit" &&
                state.ui.selectedInstance !== undefined &&
                approvalId !== undefined
            ) {
                return await this.dispatch({
                    approvalId,
                    instance: state.ui.selectedInstance,
                    type: "approval.open"
                });
            }
            return await this.dispatch({ type: "screen.toggle" });
        }
        if (scope === "boxDetail") {
            return await this.#detail.activate();
        }
        if (scope === "textDetail") {
            return await this.dispatch({ type: "textDetail.close" });
        }
        if (scope === "approvalDetail" || scope === "denyConfirm") {
            return await this.#audit.activate();
        }
        if (scope === "form" || scope === "wizard") {
            return await this.#editor.activate();
        }
        return true;
    }

    async #decideApproval(
        instance: string,
        approvalId: string,
        decision: "approve" | "deny"
    ): Promise<boolean> {
        if (decision === "deny") {
            this.#audit.openDenyConfirm();
            return true;
        }
        await this.#options.onApprovalDecision(
            instance,
            approvalId,
            decision
        );
        this.#audit.returnToList();
        return true;
    }

    #updateToolForm(update: (value: string) => string): boolean {
        const form = this.#store.getState().interaction.toolForm;
        if (form === undefined) {
            return false;
        }
        this.#store.setToolForm(
            form.instance,
            form.toolName,
            update(form.input)
        );
        return true;
    }

    async #submitToolForm(): Promise<boolean> {
        const form = this.#store.getState().interaction.toolForm;
        if (form === undefined) {
            return false;
        }
        if (
            await this.#options.onToolCall(
                form.instance,
                form.toolName,
                form.input
            )
        ) {
            this.#store.clearToolForm();
            this.#focusManager.restore();
        }
        return true;
    }
}

async function unavailable(): Promise<never> {
    throw new Error("Control RPC handler is unavailable.");
}
