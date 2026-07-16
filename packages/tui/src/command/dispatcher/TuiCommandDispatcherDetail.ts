import type { TuiAppStore } from "../../store/TuiAppStore.js";
import { selectMainScreenModel } from "../../store/TuiSelectors.js";
import type { TuiUiIntent } from "../../interaction/TuiInteractionModel.js";
import type { TuiCommandDispatcherAudit } from "./TuiCommandDispatcherAudit.js";
import type { TuiCommandDispatcherEditor } from "./TuiCommandDispatcherEditor.js";
import type { TuiCommandDispatcherFocus } from "./TuiCommandDispatcherFocus.js";

interface CommandDispatcherDetailOptions {
    audit: TuiCommandDispatcherAudit;
    dispatch(intent: TuiUiIntent): Promise<boolean>;
    editor: TuiCommandDispatcherEditor;
    focus: TuiCommandDispatcherFocus;
    onOAuthApprovalDecision(approvalId: string, decision: "approve" | "deny"): Promise<void>;
    store: TuiAppStore;
}

export class TuiCommandDispatcherDetail {
    readonly #audit: TuiCommandDispatcherAudit;
    readonly #dispatch: CommandDispatcherDetailOptions["dispatch"];
    readonly #editor: TuiCommandDispatcherEditor;
    readonly #focus: TuiCommandDispatcherFocus;
    readonly #onOAuthApprovalDecision: CommandDispatcherDetailOptions["onOAuthApprovalDecision"];
    readonly #store: TuiAppStore;

    constructor(options: CommandDispatcherDetailOptions) {
        this.#audit = options.audit;
        this.#dispatch = options.dispatch;
        this.#editor = options.editor;
        this.#focus = options.focus;
        this.#onOAuthApprovalDecision = options.onOAuthApprovalDecision;
        this.#store = options.store;
    }

    async activate(): Promise<boolean> {
            const state = this.#store.getState();
            const boxId = state.ui.mainFocusId;
            const box = selectMainScreenModel(state).boxes.find((candidate) => candidate.id === boxId);
            const lineId = box?.selectedDetailLineId;
            const actionId = boxId === undefined || lineId === undefined ? undefined : lineId.slice(`${boxId}:`.length);
            const selectedLine = box?.expandedLines.find((line) => line.id === lineId);
            if (selectedLine?.disabled === true) {
                this.#store.setScreenStatus(state.ui.selectedPage, "Action is unavailable in the current state.");
                return false;
            }

            if (state.ui.selectedPage === "oauth" && actionId?.startsWith("oauth.approve:")) {
                const approvalId = actionId.slice("oauth.approve:".length);
                return await this.#dispatch({
                    body: "Approve this OAuth request? The client may receive authorization immediately.",
                    confirmIntent: { approvalId, decision: "approve", type: "oauthApproval.decide" },
                    confirmLabel: "Approve",
                    title: "Confirm OAuth Approval",
                    type: "overlay.openConfirm"
                });
            }

            if (state.ui.selectedPage === "oauth" && actionId?.startsWith("oauth.deny:")) {
                await this.#onOAuthApprovalDecision(actionId.slice("oauth.deny:".length), "deny");
                this.#store.setScreenStatus("oauth", "OAuth approval denied.");
                return true;
            }

            if (state.ui.selectedPage === "instances" && actionId?.startsWith("instance.toggleEnabled:")) {
                const instance = actionId.slice("instance.toggleEnabled:".length);
                const entry = state.instances.find((candidate) => candidate.name === instance);
                if (entry === undefined) {
                    return false;
                }
                if (entry.enabled) {
                    const running = state.snapshotsByInstance[instance]?.daemonState !== "stopped";
                    return await this.#dispatch({
                        body: running ? `Stop and disable ${instance}?` : `Disable ${instance}?`,
                        confirmIntent: { enabled: false, instance, type: "instance.setEnabled" },
                        confirmLabel: "Disable",
                        title: "Confirm Disable",
                        type: "overlay.openConfirm"
                    });
                }
                return await this.#dispatch({ enabled: true, instance, type: "instance.setEnabled" });
            }

            const button = actionId?.startsWith("button:") ? actionId.slice("button:".length) : undefined;

            if (state.ui.selectedPage === "connector" && button === "restart-control") {
                return await this.#dispatch({
                    body: "Restart the control runtime now? TUI will reconnect automatically.",
                    confirmIntent: { type: "control.restart" },
                    confirmLabel: "Restart Control",
                    title: "Restart Control",
                    type: "overlay.openConfirm"
                });
            }
            if (state.ui.selectedPage === "connector" && (button === "save" || button === "cancel")) {
                if (state.interaction.editor?.kind !== "connector") {
                    this.#store.setEditor({ editing: false, key: `connector:${state.ui.selectedInstance}`, kind: "connector" });
                }
                return button === "save" ? await this.#editor.save(false) : await this.#editor.discard();
            }

            if ((state.ui.selectedPage === "config" || state.ui.selectedPage === "connector") && boxId !== undefined && actionId?.startsWith("field:")) {
                return this.#editor.openPageEditor(state.ui.selectedPage, boxId);
            }

            if (state.ui.selectedPage === "audit" && state.ui.selectedInstance !== undefined && actionId?.startsWith("approval.open:")) {
                return await this.#dispatch({ approvalId: actionId.slice("approval.open:".length), instance: state.ui.selectedInstance, type: "approval.open" });
            }

            const callId = boxId === undefined ? undefined : this.#audit.callIdFromBox(boxId);
            if (state.ui.selectedPage === "audit" && state.ui.selectedInstance !== undefined && callId !== undefined) {
                if (actionId === "input") {
                    return await this.#audit.openInput(state.ui.selectedInstance, callId);
                }
                if (actionId === "output") {
                    return await this.#audit.openOutput(state.ui.selectedInstance, callId);
                }
            }

            if (button === "clear-filter" && (state.ui.selectedPage === "instances" || state.ui.selectedPage === "todo" || state.ui.selectedPage === "config" || state.ui.selectedPage === "audit")) {
                this.#store.setSearchQuery(state.ui.selectedPage, "");
                this.#focus.syncMainFocus();
                return true;
            }
            if (button !== undefined && state.ui.selectedPage === "logs") {
                switch (button) {
                    case "reload":
                        return await this.#dispatch({ type: "page.reload" });
                    case "toggle-follow":
                        return await this.#dispatch({ type: "logs.toggleFollow" });
                    case "clear-filter":
                        this.#store.setSearchQuery("logs", "");
                        this.#focus.syncMainFocus();
                        return true;
                    case "clear-buffer":
                        return await this.#dispatch({ type: "logs.clearBuffer" });
                }
            }
            if (state.ui.selectedPage === "logs" && actionId?.startsWith("log:")) {
                const entry = state.logsByInstance[state.ui.selectedInstance ?? ""]?.find((candidate) => candidate.seq === Number(actionId.slice("log:".length)));
                if (entry?.callId === undefined) {
                    this.#store.setScreenStatus("logs", "This log entry has no linked tool call.");
                    return false;
                }
                this.#store.setSelectedPage("audit");
                this.#store.setFocusScope("mainBoxes");
                this.#store.setMainFocusId(`audit-${entry.callId}`);
                this.#focus.ensureMainFocusVisible();
                return true;
            }
            if (button !== undefined && state.ui.selectedPage === "instances") {
                return await this.#activateInstanceButton(boxId, button);
            }
            if (actionId?.startsWith("instance.attachShell:")) {
                return await this.#openAttachShellConfirm(actionId.slice("instance.attachShell:".length));
            }
            if (selectedLine !== undefined && selectedLine.text.length > 60) {
                return await this.#dispatch({
                    body: selectedLine.text,
                    title: `${box?.title ?? state.ui.selectedPage} · full text`,
                    type: "textDetail.open"
                });
            }
            return await this.#dispatch({ type: "screen.toggle" });
    }

    async #activateInstanceButton(boxId: string | undefined, button: string): Promise<boolean> {
        const instance = this.#focus.instanceNameFromBox(boxId);
        if (instance === undefined) {
            if (button === "create") {
                return await this.#editor.openCreateWizard();
            }
            return false;
        }
        if (button.startsWith("artifact-revoke:")) {
            const shareId = button.slice("artifact-revoke:".length);
            return await this.#dispatch({
                body: `Revoke artifact share ${shareId}? Existing download links will stop working.`,
                confirmIntent: { shareId, type: "artifact.revokeShare" },
                confirmLabel: "Revoke",
                title: "Confirm Share Revocation",
                type: "overlay.openConfirm"
            });
        }
        if (button.startsWith("artifact-cancel:")) {
            const transferId = button.slice("artifact-cancel:".length);
            return await this.#dispatch({
                body: `Cancel artifact transfer ${transferId}? Partial receive data will be cleaned up.`,
                confirmIntent: { transferId, type: "artifact.cancelTransfer" },
                confirmLabel: "Cancel Transfer",
                title: "Confirm Transfer Cancellation",
                type: "overlay.openConfirm"
            });
        }
        switch (button) {
            case "attach-shell":
                return await this.#openAttachShellConfirm(instance);
            case "start":
                return await this.#dispatch({ instance, type: "instance.start" });
            case "restart":
                return await this.#dispatch({
                    body: `Restart ${instance}?`,
                    confirmIntent: { instance, type: "instance.restart" },
                    confirmLabel: "Restart",
                    title: "Confirm Restart",
                    type: "overlay.openConfirm"
                });
            case "stop":
                return await this.#dispatch({
                    body: `Stop ${instance}?`,
                    confirmIntent: { instance, type: "instance.stop" },
                    confirmLabel: "Stop",
                    title: "Confirm Stop",
                    type: "overlay.openConfirm"
                });
            case "delete":
                return await this.#dispatch({
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

    async #openAttachShellConfirm(instance: string): Promise<boolean> {
        return this.#dispatch({
            body: "This shell is not audited and is not controlled by devshell.",
            confirmIntent: { instance, type: "instance.attachShell" },
            confirmLabel: "Attach Shell",
            title: "UNMANAGED SHELL",
            type: "overlay.openConfirm"
        });
    }


}
