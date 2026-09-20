import { useEffect, useState } from "react";
import type {
    ApprovalRequest,
    ArtifactStoredImageResult,
    InstanceLogEntry,
    ToolCallRecord,
} from "@portable-devshell/shared/browser";
import { workspaceFolderName } from "@portable-devshell/shared/browser";

import {
    formatRelativeTime,
    formatToolValue,
    resolveToolCallOutput,
    toolCallDuration,
} from "./Model.js";
import { toolCallResult } from "./Model.js";
import { ConfirmationDialog } from "../../../../component/Confirm.js";

export function ToolCallEntry({
    approval,
    call,
    disabled = false,
    initiallyOpen = false,
    logs,
    onLoadImage,
    onLoadDetail,
    onDecideApproval,
    onRefresh,
}: {
    approval?: ApprovalRequest;
    call: ToolCallRecord;
    disabled?: boolean;
    initiallyOpen?: boolean;
    logs: readonly InstanceLogEntry[];
    onLoadImage(imageRef: string): Promise<ArtifactStoredImageResult>;
    onLoadDetail(): Promise<ToolCallRecord | undefined>;
    onDecideApproval(
        approval: ApprovalRequest,
        decision: "approve" | "deny",
    ): Promise<void>;
    onRefresh(): Promise<void>;
}) {
    const [open, setOpen] = useState(initiallyOpen);
    const [detail, setDetail] = useState<ToolCallRecord | undefined>();
    const [loading, setLoading] = useState(false);
    const [loadFailure, setLoadFailure] = useState<string>();
    const [approvalDecision, setApprovalDecision] = useState<
        "approve" | "deny"
    >();
    const [approvalBusy, setApprovalBusy] = useState(false);
    const [approvalFailure, setApprovalFailure] = useState<string>();
    useEffect(() => {
        if (initiallyOpen) setOpen(true);
    }, [initiallyOpen]);
    const load = async (): Promise<void> => {
        if (
            detail !== undefined ||
            loading ||
            call.input !== undefined ||
            call.output !== undefined
        )
            return;
        setLoading(true);
        setLoadFailure(undefined);
        try {
            setDetail(await onLoadDetail());
        } catch (error) {
            setLoadFailure(
                errorMessage(error, "Tool Call detail could not be loaded."),
            );
        } finally {
            setLoading(false);
        }
    };
    const visibleCall =
        call.input !== undefined || call.output !== undefined
            ? call
            : (detail ?? call);
    return (
        <li className="activity-record tool-call-record">
            <details open={open}>
                <summary
                    onClick={(event) => {
                        event.preventDefault();
                        const next = !open;
                        setOpen(next);
                        if (next) void load();
                    }}
                >
                    <time dateTime={call.startedAt} title={call.startedAt}>
                        {formatRelativeTime(call.startedAt)}
                    </time>
                    <strong>{call.toolName}</strong>
                    <span>
                        {workspaceFolderName(call.workspace)} · {call.instance}
                    </span>
                    <span>ctx {call.ctxId ?? "unscoped"}</span>
                    <span className={`result ${toolCallResult(call)}`}>
                        {call.status}
                    </span>
                    {approval === undefined ? null : (
                        <span
                            className="audit-approval-actions"
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                            }}
                        >
                            <button
                                className="primary"
                                disabled={disabled || approvalBusy}
                                onClick={() => {
                                    setApprovalFailure(undefined);
                                    setApprovalDecision("approve");
                                }}
                                type="button"
                            >
                                Approve
                            </button>
                            <button
                                className="danger subtle"
                                disabled={disabled || approvalBusy}
                                onClick={() => {
                                    setApprovalFailure(undefined);
                                    setApprovalDecision("deny");
                                }}
                                type="button"
                            >
                                Deny
                            </button>
                        </span>
                    )}
                </summary>
                {open && loading ? <p>Loading details…</p> : null}
                {open && loadFailure !== undefined ? (
                    <p className="error" role="alert">
                        {loadFailure}
                    </p>
                ) : null}
                {open && !loading ? (
                    <ToolCallDetails
                        call={visibleCall}
                        disabled={disabled}
                        logs={logs}
                        onLoadImage={onLoadImage}
                        onRefresh={onRefresh}
                    />
                ) : null}
            </details>
            {approval === undefined || approvalDecision === undefined ? null : (
                <ConfirmationDialog
                    actionLabel={
                        approvalDecision === "approve" ? "Approve" : "Deny"
                    }
                    busy={approvalBusy}
                    description={`${approvalDecision === "approve" ? "Approve" : "Deny"} ${approval.toolName} on ${approval.instance}${approval.workspace === undefined ? "" : ` in ${approval.workspace}`}? ${approval.reason}`}
                    disabled={disabled}
                    error={approvalFailure}
                    onCancel={() => {
                        if (approvalBusy) return;
                        setApprovalFailure(undefined);
                        setApprovalDecision(undefined);
                    }}
                    onConfirm={() => {
                        const decision = approvalDecision;
                        setApprovalBusy(true);
                        setApprovalFailure(undefined);
                        void onDecideApproval(approval, decision)
                            .then(() => setApprovalDecision(undefined))
                            .catch((error: unknown) =>
                                setApprovalFailure(
                                    errorMessage(
                                        error,
                                        "Approval could not be recorded.",
                                    ),
                                ),
                            )
                            .finally(() => setApprovalBusy(false));
                    }}
                    variant={
                        approvalDecision === "deny" ? "destructive" : "default"
                    }
                />
            )}
        </li>
    );
}

function ToolCallDetails({
    call,
    disabled,
    logs,
    onLoadImage,
    onRefresh,
}: {
    call: ToolCallRecord;
    disabled: boolean;
    logs: readonly InstanceLogEntry[];
    onLoadImage(imageRef: string): Promise<ArtifactStoredImageResult>;
    onRefresh(): Promise<void>;
}) {
    const output = resolveToolCallOutput(call, logs);
    const imageMetadata = artifactImageMetadata(call);
    const imageRef = imageMetadata?.imageRef;
    const [image, setImage] = useState<ArtifactStoredImageResult>();
    const [imageFailure, setImageFailure] = useState<string>();
    const [imageLoading, setImageLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [refreshFailure, setRefreshFailure] = useState<string>();
    useEffect(() => {
        if (imageRef === undefined) {
            setImage(undefined);
            setImageFailure(undefined);
            setImageLoading(false);
            return;
        }
        let active = true;
        setImage(undefined);
        setImageFailure(undefined);
        setImageLoading(true);
        void onLoadImage(imageRef).then(
            (next) => {
                if (!active) return;
                setImage(next);
                setImageLoading(false);
            },
            (error: unknown) => {
                if (!active) return;
                setImageFailure(
                    errorMessage(error, "Image preview could not be loaded."),
                );
                setImageLoading(false);
            },
        );
        return () => {
            active = false;
        };
    }, [imageRef, onLoadImage]);
    const refresh = async (): Promise<void> => {
        setRefreshing(true);
        setRefreshFailure(undefined);
        try {
            await onRefresh();
        } catch (error) {
            setRefreshFailure(
                errorMessage(error, "Tool Call could not be refreshed."),
            );
        } finally {
            setRefreshing(false);
        }
    };
    return (
        <>
            <button
                disabled={disabled || refreshing}
                onClick={() => void refresh()}
                type="button"
            >
                {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            {refreshFailure === undefined ? null : (
                <p className="error" role="alert">
                    {refreshFailure}
                </p>
            )}
            <dl className="activity-detail">
                <div>
                    <dt>Call</dt>
                    <dd>{call.callId}</dd>
                </div>
                <div>
                    <dt>Context</dt>
                    <dd>{call.ctxId ?? "unscoped"}</dd>
                </div>
                <div>
                    <dt>Workspace</dt>
                    <dd>{call.workspace ?? "-"}</dd>
                </div>
                <div>
                    <dt>Started</dt>
                    <dd>{call.startedAt}</dd>
                </div>
                <div>
                    <dt>Completed</dt>
                    <dd>{call.completedAt ?? "-"}</dd>
                </div>
                <div>
                    <dt>Duration</dt>
                    <dd>{toolCallDuration(call)}</dd>
                </div>
                <div>
                    <dt>Request</dt>
                    <dd>{call.requestId ?? "-"}</dd>
                </div>
                {call.purpose === undefined ? null : (
                    <div>
                        <dt>Purpose</dt>
                        <dd>{call.purpose}</dd>
                    </div>
                )}
                {call.explanation === undefined ? null : (
                    <div>
                        <dt>Explanation</dt>
                        <dd>{call.explanation}</dd>
                    </div>
                )}
                <div>
                    <dt>Termination</dt>
                    <dd>{call.termination ?? "-"}</dd>
                </div>
                <div>
                    <dt>Exit code</dt>
                    <dd>{call.exitCode ?? "-"}</dd>
                </div>
            </dl>
            <h3>Input</h3>
            <pre>{formatToolValue(call.input, call.inputSummary)}</pre>
            <h3>Output</h3>
            <pre>{formatToolValue(output)}</pre>
            {imageMetadata === undefined ? null : (
                <>
                    <h3>Image</h3>
                    {imageLoading ? <p>Loading image preview…</p> : null}
                    {imageFailure === undefined ? null : (
                        <p className="error" role="alert">
                            {imageFailure}
                        </p>
                    )}
                    {image === undefined ? null : (
                        <img
                            alt={imageMetadata.name}
                            className="artifact-image-preview"
                            src={`data:${image.mediaType};base64,${image.content}`}
                        />
                    )}
                </>
            )}
            {call.error === undefined ? null : (
                <>
                    <h3>Error</h3>
                    <pre className="error">{call.error}</pre>
                </>
            )}
        </>
    );
}

function artifactImageMetadata(
    call: ToolCallRecord,
): { imageRef: string; name: string } | undefined {
    if (call.toolName !== "artifact_viewImage" || !isRecord(call.output))
        return undefined;
    const imageRef = call.output.imageRef;
    const name = call.output.name;
    return typeof imageRef === "string" &&
        imageRef.length > 0 &&
        typeof name === "string" &&
        name.length > 0
        ? { imageRef, name }
        : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message.length > 0
        ? error.message
        : fallback;
}
