import type { TuiAppStore } from "../../../state/TuiAppStore.js";
import { selectTuiLogs } from "../../../state/reducer/TuiStoreModel.js";
import type { TuiInteractionProjection } from "../../TuiInteractionProjection.js";
import type { TuiUiIntent } from "../../../state/TuiInteractionState.js";
import type { TuiCommandDispatcherAudit } from "./TuiCommandDispatcherAudit.js";
import type { TuiCommandDispatcherEditor } from "./TuiCommandDispatcherEditor.js";
import type { TuiCommandDispatcherFocus } from "./TuiCommandDispatcherFocus.js";

interface CommandDispatcherDetailOptions {
    audit: TuiCommandDispatcherAudit;
    dispatch(intent: TuiUiIntent): Promise<boolean>;
    editor: TuiCommandDispatcherEditor;
    focus: TuiCommandDispatcherFocus;
    projection: TuiInteractionProjection;
    store: TuiAppStore;
}

export class TuiCommandDispatcherDetail {
    readonly #audit: TuiCommandDispatcherAudit;
    readonly #dispatch: CommandDispatcherDetailOptions["dispatch"];
    readonly #editor: TuiCommandDispatcherEditor;
    readonly #focus: TuiCommandDispatcherFocus;
    readonly #projection: TuiInteractionProjection;
    readonly #store: TuiAppStore;

    constructor(options: CommandDispatcherDetailOptions) {
        this.#audit = options.audit;
        this.#dispatch = options.dispatch;
        this.#editor = options.editor;
        this.#focus = options.focus;
        this.#projection = options.projection;
        this.#store = options.store;
    }

    async activate(): Promise<boolean> {
            const state = this.#store.getState();
            const boxId = state.ui.mainFocusId;
            const box = this.#projection.selectMainScreenModel(state).boxes.find((candidate) => candidate.id === boxId);
            const lineId = box?.selectedDetailLineId;
            const actionId = boxId === undefined || lineId === undefined ? undefined : lineId.slice(`${boxId}:`.length);
            const selectedLine = box?.expandedLines.find((line) => line.id === lineId);
            if (selectedLine?.disabled === true) {
                this.#store.setScreenStatus(state.ui.selectedPage, "Action is unavailable in the current state.");
                return false;
            }

            if (box?.editable === true && selectedLine?.editable === true) {
                return await this.#dispatch({ type: "contextConversation.edit" });
            }

            if (state.ui.selectedPage === "connections" && actionId?.startsWith("oauth.approve:")) {
                const approvalId = actionId.slice("oauth.approve:".length);
                const approval = state.readModel.oauthApprovals.find(
                    (candidate) => candidate.approvalId === approvalId,
                );
                const requestSummary = approval === undefined
                    ? `OAuth request ${approvalId}`
                    : `OAuth ${approval.kind} for ${approval.clientName}; scopes=${approval.requestedScopes.join(", ") || "none"}; resources=${approval.requestedResources.join(", ") || "none"}; redirects=${approval.redirectUris.join(", ") || "none"}`;
                return await this.#dispatch({
                    body: `Approve ${requestSummary}? The client may receive authorization immediately.`,
                    confirmIntent: { approvalId, decision: "approve", type: "oauthApproval.decide" },
                    confirmLabel: "Approve",
                    title: "Confirm OAuth Approval",
                    type: "overlay.openConfirm"
                });
            }

            if (state.ui.selectedPage === "connections" && actionId?.startsWith("oauth.deny:")) {
                const approvalId = actionId.slice("oauth.deny:".length);
                const approval = state.readModel.oauthApprovals.find(
                    (candidate) => candidate.approvalId === approvalId,
                );
                const requestSummary = approval === undefined
                    ? `OAuth request ${approvalId}`
                    : `OAuth ${approval.kind} for ${approval.clientName}; scopes=${approval.requestedScopes.join(", ") || "none"}; resources=${approval.requestedResources.join(", ") || "none"}; redirects=${approval.redirectUris.join(", ") || "none"}`;
                return await this.#dispatch({
                    body: `Deny ${requestSummary}? The current OAuth request will be rejected immediately.`,
                    confirmIntent: { approvalId, decision: "deny", type: "oauthApproval.decide" },
                    confirmLabel: "Deny",
                    title: "Confirm OAuth Denial",
                    type: "overlay.openConfirm"
                });
            }

            if (state.ui.selectedPage === "instances" && actionId?.startsWith("instance.toggleEnabled:")) {
                const instance = actionId.slice("instance.toggleEnabled:".length);
                const entry = state.instances.find((candidate) => candidate.name === instance);
                if (entry === undefined) {
                    return false;
                }
                if (entry.enabled) {
                    const running = state.readModel.instanceState[instance]?.snapshot?.daemonState !== "stopped";
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

            if (state.ui.selectedPage === "todo" && state.ui.selectedInstance !== undefined && button === "delete-project") {
                const taskId = todoTaskIdFromBox(boxId);
                if (taskId === undefined) return false;
                const instance = state.ui.selectedInstance;
                const todo = state.readModel.instanceState[instance]?.todo;
                const title = todo?.taskId === taskId
                    ? todo.title
                    : todo?.tasks?.find((task) => task.taskId === taskId)?.title;
                return await this.#dispatch({
                    body: `Delete Todo project ${title ?? taskId} (${taskId}) from instance ${instance}? This permanently removes the project and its history.`,
                    confirmIntent: { instance, taskId, type: "todo.delete" },
                    confirmLabel: "Delete",
                    title: "Confirm Todo Project Deletion",
                    type: "overlay.openConfirm"
                });
            }

            if (state.ui.selectedPage === "connections" && button === "restart-control") {
                return await this.#dispatch({
                    body: "Restart the control runtime now? TUI will reconnect automatically.",
                    confirmIntent: { type: "control.restart" },
                    confirmLabel: "Restart Control",
                    title: "Restart Control",
                    type: "overlay.openConfirm"
                });
            }
            if (state.ui.selectedPage === "connections" && (button === "save" || button === "cancel")) {
                if (state.interaction.editor?.kind !== "connector") {
                    this.#store.setEditor({ editing: false, key: `connector:${state.ui.selectedInstance}`, kind: "connector" });
                }
                return button === "save" ? await this.#editor.save(false) : await this.#editor.discard();
            }

            if ((state.ui.selectedPage === "config" || state.ui.selectedPage === "connections") && boxId !== undefined && actionId?.startsWith("field:")) {
                return this.#editor.openPageEditor(state.ui.selectedPage === "config" ? "config" : "connector", boxId);
            }

            if (state.ui.selectedPage === "audit" && state.ui.selectedInstance !== undefined && actionId?.startsWith("approval.open:")) {
                return await this.#dispatch({ approvalId: actionId.slice("approval.open:".length), instance: state.ui.selectedInstance, type: "approval.open" });
            }

            if (state.ui.selectedPage === "audit" && state.ui.selectedInstance !== undefined && (actionId === "context.disable" || actionId === "context.renew")) {
                const ctxId = ctxIdFromBox(boxId);
                if (ctxId === undefined) return false;
                if (actionId === "context.disable") {
                    const context = state.readModel.contexts.find((candidate) => candidate.ctxId === ctxId);
                    const workspace = context === undefined
                        ? undefined
                        : (context.environments ?? [{
                              instance: context.instance,
                              temporaryDirectory: context.temporaryDirectory,
                              workspace: context.workspace,
                          }]).find((environment) => environment.instance === state.ui.selectedInstance)?.workspace;
                    return await this.#dispatch({
                        body: `Disable Context ${ctxId}${workspace === undefined ? "" : ` from workspace ${workspace}`} across all attached instances? Disabled Contexts cannot be renewed; the client must establish a new Context.`,
                        confirmIntent: { ctxId, instance: state.ui.selectedInstance, type: "context.disable" },
                        confirmLabel: "Disable",
                        title: "Confirm Context Disable",
                        type: "overlay.openConfirm"
                    });
                }
                return await this.#dispatch({
                    ctxId,
                    instance: state.ui.selectedInstance,
                    type: "context.renew"
                });
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
                const entry = selectTuiLogs(state, state.ui.selectedInstance ?? "").find((candidate) => candidate.seq === Number(actionId.slice("log:".length)));
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
            if (actionId?.startsWith("instance.openTerminal:")) {
                return await this.#dispatch({
                    instance: actionId.slice("instance.openTerminal:".length),
                    type: "instance.openTerminal"
                });
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
            case "open-terminal":
                return await this.#dispatch({ instance, type: "instance.openTerminal" });
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

}

function ctxIdFromBox(boxId: string | undefined): string | undefined {
    if (boxId === undefined) return undefined;
    const prefix = "audit-context:";
    return boxId.startsWith(prefix) ? boxId.slice(prefix.length) : undefined;
}

function todoTaskIdFromBox(boxId: string | undefined): string | undefined {
    if (boxId === undefined) return undefined;
    const prefix = "todo-summary:";
    return boxId.startsWith(prefix) ? boxId.slice(prefix.length) : undefined;
}
