import type { ArtifactViewImageInput, ArtifactViewImageResult, JsonValue } from "@portable-devshell/shared";

import { auditInputText, auditOutputText, resolveAuditOutput } from "../../../state/audit/TuiAuditPresentation.js";
import type { TuiAppStore } from "../../../state/TuiAppStore.js";
import type { TuiUiIntent } from "../../../state/TuiInteractionState.js";
import type { TuiInteractionProjection } from "../../TuiInteractionProjection.js";

interface CommandAuditOptions {
    dispatch(intent: TuiUiIntent): Promise<boolean>;
    onArtifactViewImage?(
        instance: string,
        input: ArtifactViewImageInput
    ): Promise<ArtifactViewImageResult>;
    projection: TuiInteractionProjection;
    store: TuiAppStore;
}

export class TuiCommandDispatcherAudit {
    readonly #dispatch: CommandAuditOptions["dispatch"];
    readonly #onArtifactViewImage?: CommandAuditOptions["onArtifactViewImage"];
    readonly #projection: TuiInteractionProjection;
    readonly #store: TuiAppStore;

    constructor(options: CommandAuditOptions) {
        this.#dispatch = options.dispatch;
        this.#onArtifactViewImage = options.onArtifactViewImage;
        this.#projection = options.projection;
        this.#store = options.store;
    }

    openDetail(approvalId: string): void {
        const state = this.#store.getState();
        this.#store.clearToolForm();
        this.#store.setAuditPage({
            approvalId,
            listFocusId: state.ui.mainFocusId,
            listScrollOffset: state.ui.scrollOffsets[this.#projection.selectMainScrollKey(state)] ?? 0,
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
        const imageInput = record.toolName === "artifact_viewImage"
            ? readArtifactViewImageInput(record.input)
            : undefined;
        if (imageInput !== undefined && this.#onArtifactViewImage !== undefined) {
            return await this.#openImageOutput(instance, record.toolName, imageInput, output);
        }
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
            this.#store.setScrollOffset(this.#projection.selectMainScrollKey(this.#store.getState()), auditPage.listScrollOffset);
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

    async #openImageOutput(
        instance: string,
        toolName: string,
        input: ArtifactViewImageInput,
        output: JsonValue | undefined
    ): Promise<boolean> {
        const title = `${toolName} · output`;
        await this.#dispatch({
            body: `${auditOutputText(output)}\n\nLoading image preview...`,
            title,
            type: "textDetail.open"
        });
        try {
            const image = await this.#onArtifactViewImage!(instance, input);
            const detail = this.#store.getState().interaction.textDetail;
            if (!detail.open || detail.title !== title) {
                return true;
            }
            this.#store.setTextDetail({
                body: auditOutputText(output),
                image,
                open: true,
                title
            });
        } catch (error) {
            const detail = this.#store.getState().interaction.textDetail;
            if (detail.open && detail.title === title) {
                this.#store.setTextDetail({
                    body: `${auditOutputText(output)}\n\nImage preview unavailable: ${readErrorMessage(error)}`,
                    open: true,
                    title
                });
            }
        }
        return true;
    }
}

function readArtifactViewImageInput(value: JsonValue | undefined): ArtifactViewImageInput | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const handle = typeof value.handle === "string" && value.handle.length > 0 ? value.handle : undefined;
    const path = typeof value.path === "string" && value.path.length > 0 ? value.path : undefined;
    const instance = typeof value.instance === "string" && value.instance.length > 0 ? value.instance : undefined;
    if ((handle === undefined) === (path === undefined)) {
        return undefined;
    }
    return handle === undefined
        ? { ...(instance === undefined ? {} : { instance }), path: path! }
        : { handle, ...(instance === undefined ? {} : { instance }) };
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
