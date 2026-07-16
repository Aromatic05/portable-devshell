import { auditInputText, auditOutputText, resolveAuditOutput } from "../../page/TuiPageAuditInputPresentation.js";
import type { TuiAppStore } from "../../store/TuiAppStore.js";
import { selectMainScrollKey } from "../../store/TuiSelectors.js";
import type { TuiUiIntent } from "../../interaction/TuiInteractionModel.js";

interface CommandAuditOptions {
    dispatch(intent: TuiUiIntent): Promise<boolean>;
    store: TuiAppStore;
}

export class TuiCommandDispatcherAudit {
    readonly #dispatch: CommandAuditOptions["dispatch"];
    readonly #store: TuiAppStore;

    constructor(options: CommandAuditOptions) {
        this.#dispatch = options.dispatch;
        this.#store = options.store;
    }

    openDetail(approvalId: string): void {
        const state = this.#store.getState();
        this.#store.clearToolForm();
        this.#store.setAuditPage({
            approvalId,
            listFocusId: state.ui.mainFocusId,
            listScrollOffset: state.ui.scrollOffsets[selectMainScrollKey(state)] ?? 0,
            mode: "approvalDetail",
            selectedAction: "back"
        });
        this.#store.setFocusScope("approvalDetail");
    }

    callIdFromBox(boxId: string): string | undefined {
        return boxId.startsWith("audit-") ? boxId.slice("audit-".length) : undefined;
    }

    async openInput(instance: string, callId: string): Promise<boolean> {
        const record = this.#store.getState().toolCallsByInstance[instance]?.find((candidate) => candidate.callId === callId);
        if (record === undefined) {
            return false;
        }
        return await this.#dispatch({
            body: auditInputText(record.input, record.inputSummary),
            title: `${record.toolName} · input`,
            type: "textDetail.open"
        });
    }

    async openOutput(instance: string, callId: string): Promise<boolean> {
        const record = this.#store.getState().toolCallsByInstance[instance]?.find((candidate) => candidate.callId === callId);
        if (record === undefined) {
            return false;
        }
        const output = resolveAuditOutput(record.output, this.#store.getState().logsByInstance[instance] ?? [], callId);
        return await this.#dispatch({
            body: auditOutputText(output),
            title: `${record.toolName} · output`,
            type: "textDetail.open"
        });
    }

    openDenyConfirm(): void {
        const auditPage = this.#store.getState().interaction.auditPage;
        if (auditPage.mode !== "approvalDetail") {
            return;
        }
        this.#store.setAuditPage({ ...auditPage, mode: "denyConfirm", selectedAction: "back" });
        this.#store.setFocusScope("denyConfirm");
    }

    returnToList(): void {
        const auditPage = this.#store.getState().interaction.auditPage;
        this.#store.setAuditPage({ mode: "list" });
        this.#store.setFocusScope("mainBoxes");
        this.#store.setMainFocusId(auditPage.listFocusId);
        if (auditPage.listScrollOffset !== undefined) {
            this.#store.setScrollOffset(selectMainScrollKey(this.#store.getState()), auditPage.listScrollOffset);
        }
    }

    async activate(): Promise<boolean> {
        const state = this.#store.getState();
        const { auditPage } = state.interaction;
        const instance = state.ui.selectedInstance;
        if (auditPage.approvalId === undefined || instance === undefined) {
            return false;
        }
        if (auditPage.selectedAction === "back") {
            return await this.#dispatch({ type: "approval.back" });
        }
        if (auditPage.selectedAction === "input" && auditPage.mode === "approvalDetail") {
            const approval = state.approvalsByInstance[instance]?.find((candidate) => candidate.approvalId === auditPage.approvalId);
            const toolCall = approval === undefined
                ? undefined
                : state.toolCallsByInstance[instance]?.find((candidate) => candidate.callId === approval.callId);
            if (approval === undefined) {
                return false;
            }
            return await this.#dispatch({
                body: auditInputText(toolCall?.input, approval.inputSummary),
                title: `${approval.toolName} · approval input`,
                type: "textDetail.open"
            });
        }
        if (auditPage.selectedAction === "approve" && auditPage.mode === "approvalDetail") {
            return await this.#dispatch({
                body: "Approve this tool call? The requested operation may execute immediately.",
                confirmIntent: { approvalId: auditPage.approvalId, decision: "approve", instance, type: "approval.decide" },
                confirmLabel: "Approve",
                title: "Confirm Approval",
                type: "overlay.openConfirm"
            });
        }
        if (auditPage.selectedAction === "deny") {
            if (auditPage.mode === "approvalDetail") {
                return await this.#dispatch({ approvalId: auditPage.approvalId, decision: "deny", instance, type: "approval.decide" });
            }
            return await this.#dispatch({ approvalId: auditPage.approvalId, instance, type: "approval.confirmDeny" });
        }
        return false;
    }

}
