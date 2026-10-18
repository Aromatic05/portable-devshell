import type {
    ArtifactSourceDescriptor,
    ArtifactViewImageResult,
    JsonValue,
    ToolCallRecord,
} from "@portable-devshell/shared";

import type { TuiAppStore } from "../../../state/store/App.js";
import type { TuiInteractionProjection } from "../../Projection.js";
import type { TuiUiIntent } from "../../../state/Interaction.js";
import { topTuiOverlay } from "../../../state/Overlay.js";
import type { TuiFocusManager } from "../../focus/Manager.js";

type TuiArtifactViewImageSourceRequest =
    | { handle: string; instance?: string }
    | { instance?: string; path: string; workspace?: string };

export type TuiArtifactViewImageRequest =
    | { imageRef: string; name: string; source: ArtifactSourceDescriptor }
    | TuiArtifactViewImageSourceRequest;

interface CommandAuditOptions {
    dispatch(intent: TuiUiIntent): Promise<boolean>;
    focusManager: TuiFocusManager;
    onArtifactViewImage?(
        instance: string,
        input: TuiArtifactViewImageRequest,
    ): Promise<ArtifactViewImageResult>;
    onToolCallDetail?(
        instance: string,
        callId: string,
    ): Promise<ToolCallRecord | undefined>;
    projection: TuiInteractionProjection;
    store: TuiAppStore;
}

export class TuiCommandDispatcherAudit {
    readonly #dispatch: CommandAuditOptions["dispatch"];
    readonly #focusManager: TuiFocusManager;
    readonly #onArtifactViewImage?: CommandAuditOptions["onArtifactViewImage"];
    readonly #onToolCallDetail?: CommandAuditOptions["onToolCallDetail"];
    readonly #projection: TuiInteractionProjection;
    readonly #store: TuiAppStore;

    constructor(options: CommandAuditOptions) {
        this.#dispatch = options.dispatch;
        this.#focusManager = options.focusManager;
        this.#onArtifactViewImage = options.onArtifactViewImage;
        this.#onToolCallDetail = options.onToolCallDetail;
        this.#projection = options.projection;
        this.#store = options.store;
    }

    openDetail(instance: string, approvalId: string): void {
        this.#focusManager.pushRestore("approvalDetail");
        this.#store.pushOverlay({
            approvalId,
            instance,
            kind: "approval",
            selectedAction: "back",
        });
    }

    callIdFromBox(boxId: string): string | undefined {
        return boxId.startsWith("audit-call:")
            ? boxId.slice("audit-call:".length)
            : undefined;
    }

    async openInput(instance: string, callId: string): Promise<boolean> {
        const record = await this.#readToolCall(instance, callId);
        if (record === undefined) return false;
        return await this.#dispatch({
            body: this.#projection.auditInputText(record.input, record.inputSummary),
            title: `${record.toolName} · input`,
            type: "textDetail.open",
        });
    }

    async openOutput(instance: string, callId: string): Promise<boolean> {
        const record = await this.#readToolCall(instance, callId);
        if (record === undefined) return false;
        const output = this.#projection.resolveAuditOutput(record.output, instance, callId);
        const imageInput =
            record.toolName === "artifact_viewImage"
                ? readArtifactViewImageInput(record.input, record.output)
                : undefined;
        if (
            imageInput !== undefined &&
            this.#onArtifactViewImage !== undefined
        ) {
            return await this.#openImageOutput(
                instance,
                record.toolName,
                imageInput,
                output,
            );
        }
        return await this.#dispatch({
            body: this.#projection.auditOutputText(output),
            title: `${record.toolName} · output`,
            type: "textDetail.open",
        });
    }

    returnToPage(): boolean {
        const overlay = topTuiOverlay(
            this.#store.getState().interaction.overlays,
        );
        if (overlay?.kind !== "approval") return false;
        this.#store.popOverlay();
        this.#focusManager.restore();
        return true;
    }

    async activate(): Promise<boolean> {
        const state = this.#store.getState();
        const overlay = topTuiOverlay(state.interaction.overlays);
        if (overlay?.kind !== "approval") return false;
        const approval = (
            this.#projection.domains.approval(overlay.instance).approvals ?? []
        ).find(
            (candidate: { approvalId: string }) =>
                candidate.approvalId === overlay.approvalId,
        );
        if (approval === undefined) return this.returnToPage();

        switch (overlay.selectedAction) {
            case "back":
                return this.returnToPage();
            case "input": {
                const toolCall = await this.#readToolCall(
                    overlay.instance,
                    approval.callId,
                );
                return await this.#dispatch({
                    body: this.#projection.auditInputText(
                        toolCall?.input,
                        approval.inputSummary,
                    ),
                    title: `${approval.toolName} · approval input`,
                    type: "textDetail.open",
                });
            }
            case "approve":
                return await this.#dispatch({
                    body: `Approve ${approval.toolName} on ${overlay.instance}${approval.workspace === undefined ? "" : ` in workspace ${approval.workspace}`} (risk ${approval.riskLevel})? The requested operation may execute immediately.`,
                    confirmIntent: {
                        approvalId: overlay.approvalId,
                        decision: "approve",
                        instance: overlay.instance,
                        type: "approval.decide",
                    },
                    confirmLabel: "Approve",
                    title: "Confirm Approval",
                    type: "overlay.openConfirm",
                });
            case "deny":
                return await this.#dispatch({
                    body: `Deny ${approval.toolName} on ${overlay.instance}${approval.workspace === undefined ? "" : ` in workspace ${approval.workspace}`} (risk ${approval.riskLevel})?`,
                    confirmIntent: {
                        approvalId: overlay.approvalId,
                        instance: overlay.instance,
                        type: "approval.confirmDeny",
                    },
                    confirmLabel: "Deny",
                    title: "Confirm Deny",
                    type: "overlay.openConfirm",
                });
        }
    }

    async #readToolCall(
        instance: string,
        callId: string,
    ): Promise<ToolCallRecord | undefined> {
        const compact = (
            this.#projection.domains.toolCalls.instances[instance]?.calls ?? []
        ).find((candidate: ToolCallRecord) => candidate.callId === callId);
        if (compact === undefined) return undefined;
        if (compact.input !== undefined && compact.output !== undefined)
            return compact;
        return (await this.#onToolCallDetail?.(instance, callId)) ?? compact;
    }

    async #openImageOutput(
        instance: string,
        toolName: string,
        input: TuiArtifactViewImageRequest,
        output: JsonValue | undefined,
    ): Promise<boolean> {
        const title = `${toolName} · output`;
        await this.#dispatch({
            body: `${this.#projection.auditOutputText(output)}\n\nLoading image preview...`,
            title,
            type: "textDetail.open",
        });
        try {
            const image = await this.#onArtifactViewImage!(instance, input);
            const overlay = topTuiOverlay(
                this.#store.getState().interaction.overlays,
            );
            if (overlay?.kind !== "text-detail" || overlay.title !== title)
                return true;
            this.#store.replaceTopOverlay({
                ...overlay,
                body: this.#projection.auditOutputText(output),
                image,
            });
        } catch (error) {
            const overlay = topTuiOverlay(
                this.#store.getState().interaction.overlays,
            );
            if (overlay?.kind === "text-detail" && overlay.title === title) {
                this.#store.replaceTopOverlay({
                    ...overlay,
                    body: `${this.#projection.auditOutputText(output)}\n\nImage preview unavailable: ${readErrorMessage(error)}`,
                });
            }
        }
        return true;
    }
}

function readArtifactViewImageInput(
    input: JsonValue | undefined,
    output: JsonValue | undefined,
): TuiArtifactViewImageRequest | undefined {
    const stored = readStoredArtifactViewImageRequest(output);
    if (stored !== undefined) return stored;
    const inputRequest = readArtifactViewImageRequest(input);
    const outputSource = readArtifactViewImageSource(output);
    if (outputSource === undefined) return inputRequest;
    if ("handle" in outputSource) return outputSource;
    if (
        inputRequest !== undefined &&
        "path" in inputRequest &&
        inputRequest.path === outputSource.path
    ) {
        return {
            ...inputRequest,
            ...outputSource,
            workspace: outputSource.workspace ?? inputRequest.workspace,
        };
    }
    return outputSource;
}

function readStoredArtifactViewImageRequest(
    value: JsonValue | undefined,
): Extract<TuiArtifactViewImageRequest, { imageRef: string }> | undefined {
    if (!isRecord(value)) return undefined;
    const imageRef =
        typeof value.imageRef === "string" && value.imageRef.length > 0
            ? value.imageRef
            : undefined;
    const name =
        typeof value.name === "string" && value.name.length > 0
            ? value.name
            : undefined;
    const source = readArtifactSourceDescriptor(value.source);
    return imageRef === undefined || name === undefined || source === undefined
        ? undefined
        : { imageRef, name, source };
}

function readArtifactSourceDescriptor(
    value: JsonValue | undefined,
): ArtifactSourceDescriptor | undefined {
    const source = readArtifactViewImageRequest(value);
    if (source === undefined || source.instance === undefined) return undefined;
    const type =
        isRecord(value) &&
        (value.type === "artifact" ||
            value.type === "file" ||
            value.type === "directory")
            ? value.type
            : undefined;
    return {
        ...source,
        ...(type === undefined ? {} : { type }),
        instance: source.instance,
    };
}

function readArtifactViewImageSource(
    value: JsonValue | undefined,
): TuiArtifactViewImageSourceRequest | undefined {
    if (!isRecord(value)) return undefined;
    return readArtifactViewImageRequest(value.source);
}

function readArtifactViewImageRequest(
    value: JsonValue | undefined,
): TuiArtifactViewImageSourceRequest | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const handle =
        typeof value.handle === "string" && value.handle.length > 0
            ? value.handle
            : undefined;
    const path =
        typeof value.path === "string" && value.path.length > 0
            ? value.path
            : undefined;
    const instance =
        typeof value.instance === "string" && value.instance.length > 0
            ? value.instance
            : undefined;
    const workspace =
        typeof value.workspace === "string" && value.workspace.length > 0
            ? value.workspace
            : undefined;
    if ((handle === undefined) === (path === undefined)) return undefined;
    return handle === undefined
        ? {
              ...(instance === undefined ? {} : { instance }),
              path: path!,
              ...(workspace === undefined ? {} : { workspace }),
          }
        : { handle, ...(instance === undefined ? {} : { instance }) };
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
