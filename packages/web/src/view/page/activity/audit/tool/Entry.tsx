import { useEffect, useRef, useState } from "react";
import type {
    ApprovalRequest,
    ArtifactImageContent,
    InstanceLogEntry,
    ToolCallRecord,
} from "@portable-devshell/shared";

import { workspaceFolderName } from "../../../../Presentation.js";
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
    approvalPending = false,
    call,
    disabled = false,
    initiallyOpen = false,
    logs,
    now = Date.now(),
    onLoadImage,
    onLoadDetail,
    onDecideApproval,
    onRefresh,
}: {
    approval?: ApprovalRequest;
    approvalPending?: boolean;
    call: ToolCallRecord;
    disabled?: boolean;
    initiallyOpen?: boolean;
    logs: readonly InstanceLogEntry[];
    now?: number;
    onLoadImage(imageRef: string): Promise<ArtifactImageContent>;
    onLoadDetail(): Promise<ToolCallRecord | undefined>;
    onDecideApproval(
        approval: ApprovalRequest,
        decision: "approve" | "deny",
    ): Promise<void>;
    onRefresh(): Promise<void>;
}) {
    const [open, setOpen] = useState(initiallyOpen);
    const [detail, setDetail] = useState<{ source: ToolCallRecord; value: ToolCallRecord }>();
    const detailEpoch = useRef(0);
    const [loading, setLoading] = useState(false);
    const [loadFailure, setLoadFailure] = useState<string>();
    const [approvalDecision, setApprovalDecision] = useState<
        "approve" | "deny"
    >();
    const [approvalBusy, setApprovalBusy] = useState(false);
    const [approvalFailure, setApprovalFailure] = useState<string>();
    const approvalEpoch = useRef(0);
    const deciding = useRef(false);
    const approvalKey = JSON.stringify([approval?.instance, approval?.approvalId]);
    useEffect(() => {
        approvalEpoch.current += 1;
        deciding.current = false;
        setApprovalBusy(false);
        setApprovalDecision(undefined);
        setApprovalFailure(undefined);
        return () => { approvalEpoch.current += 1; };
    }, [approvalKey]);
    useEffect(() => {
        if (initiallyOpen) setOpen(true);
    }, [initiallyOpen]);
    const loadDetail = useRef(onLoadDetail);
    loadDetail.current = onLoadDetail;
    useEffect(() => {
        const epoch = ++detailEpoch.current;
        setDetail(undefined);
        setLoadFailure(undefined);
        setLoading(false);
        if (!open || call.input !== undefined || call.output !== undefined) return;
        setLoading(true);
        void loadDetail.current().then((next) => {
            if (epoch !== detailEpoch.current) return;
            if (next?.instance === call.instance && next.callId === call.callId) setDetail({ source: call, value: next });
            setLoading(false);
        }, (error: unknown) => {
            if (epoch !== detailEpoch.current) return;
            setLoadFailure(errorMessage(error, "Tool Call detail could not be loaded."));
            setLoading(false);
        });
        return () => { detailEpoch.current += 1; };
    }, [call, open]);
    const currentDetail = detail?.source === call ? detail.value : undefined;
    const visibleCall = {
        ...call,
        input: call.input === undefined ? currentDetail?.input : call.input,
        output: call.output === undefined ? currentDetail?.output : call.output,
    };
    return (
        <li className="activity-record tool-call-record">
            <details open={open}>
                <summary
                    onClick={(event) => {
                        event.preventDefault();
                        const next = !open;
                        setOpen(next);
                    }}
                >
                    <time dateTime={call.startedAt} title={call.startedAt}>
                        {formatRelativeTime(call.startedAt, now)}
                    </time>
                    <strong>{call.toolName}</strong>
                    <span>
                        {workspaceFolderName(call.workspace)} · {call.instance}
                    </span>
                    <span>{call.ctxId === undefined
                        ? `${call.extensionId === undefined ? call.source : `extension ${call.extensionId}`} · no Context`
                        : `ctx ${call.ctxId}`}</span>
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
                                disabled={disabled || approvalBusy || approvalPending}
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
                                disabled={disabled || approvalBusy || approvalPending}
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
                    busy={approvalBusy || approvalPending}
                    description={`${approvalDecision === "approve" ? "Approve" : "Deny"} ${approval.toolName} on ${approval.instance}${approval.workspace === undefined ? "" : ` in ${approval.workspace}`}? ${approval.reason}`}
                    disabled={disabled}
                    error={approvalFailure}
                    onCancel={() => {
                        if (approvalBusy) return;
                        setApprovalFailure(undefined);
                        setApprovalDecision(undefined);
                    }}
                    onConfirm={() => {
                        if (deciding.current || approvalPending) return;
                        deciding.current = true;
                        const epoch = approvalEpoch.current;
                        const decision = approvalDecision;
                        setApprovalBusy(true);
                        setApprovalFailure(undefined);
                        void onDecideApproval(approval, decision)
                            .then(() => { if (epoch === approvalEpoch.current) setApprovalDecision(undefined); })
                            .catch((error: unknown) => {
                                if (epoch !== approvalEpoch.current) return;
                                setApprovalFailure(
                                    errorMessage(
                                        error,
                                        "Approval could not be recorded.",
                                    ),
                                );
                            })
                            .finally(() => {
                                if (epoch !== approvalEpoch.current) return;
                                deciding.current = false;
                                setApprovalBusy(false);
                            });
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
    onLoadImage(imageRef: string): Promise<ArtifactImageContent>;
    onRefresh(): Promise<void>;
}) {
    const output = resolveToolCallOutput(call, logs);
    const imageMetadata = artifactImageMetadata(call);
    const imageRef = imageMetadata?.imageRef;
    const [image, setImage] = useState<ArtifactImageContent>();
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
                    <dd>{call.ctxId ?? "Not bound"}</dd>
                </div>
                <div>
                    <dt>Source</dt>
                    <dd>{call.source}</dd>
                </div>
                {call.extensionId === undefined ? null : (
                    <div>
                        <dt>Extension</dt>
                        <dd>{call.extensionId}</dd>
                    </div>
                )}
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
