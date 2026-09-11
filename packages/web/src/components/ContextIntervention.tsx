import { type FormEvent, useEffect, useMemo, useState } from "react";

import type { JsonValue, ToolCallRecord } from "@portable-devshell/shared/browser";

import type { WebState, WebStore } from "../state/WebStore.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";

const commentPageSize = 8;

export function ContextIntervention({
    disabled = false,
    ctxId,
    instance,
    state,
    store,
}: {
    disabled?: boolean;
    ctxId: string;
    instance: string;
    state: WebState;
    store: WebStore;
}) {
    const [draft, setDraft] = useState("");
    const [queuedPage, setQueuedPage] = useState(0);
    const [historyPage, setHistoryPage] = useState(0);
    const [disableConfirmation, setDisableConfirmation] = useState(false);
    const context = state.readModel.contexts.find((record) => record.ctxId === ctxId);
    const environment = context === undefined
        ? undefined
        : (context.environments ?? [{
              instance: context.instance,
              temporaryDirectory: context.temporaryDirectory,
              workspace: context.workspace,
          }]).find((candidate) => candidate.instance === instance);
    const interactive = state.connection === "online" && !disabled;
    const instanceState = state.readModel.instanceState[instance];
    const queuedComments = useMemo(
        () => (instanceState?.contextMessages ?? [])
            .filter((message) => message.ctxId === ctxId && message.status !== "delivered")
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
        [ctxId, instanceState?.contextMessages],
    );
    const commentCalls = useMemo(
        () => (instanceState?.commentCalls ?? [])
            .filter((call) => call.ctxId === ctxId && readCallComments(call).length > 0)
            .sort((left, right) =>
                (right.completedAt ?? right.startedAt).localeCompare(left.completedAt ?? left.startedAt)
            ),
        [ctxId, instanceState?.commentCalls],
    );
    const queuedPages = pageCount(queuedComments.length, commentPageSize);
    const historyPages = pageCount(commentCalls.length, commentPageSize);
    const visibleQueuedPage = Math.min(queuedPage, queuedPages - 1);
    const visibleHistoryPage = Math.min(historyPage, historyPages - 1);
    const operation = `context-message:${instance}:${ctxId}`;
    const renewOperation = `context-renew:${ctxId}`;
    const disableOperation = `context-disable:${ctxId}`;

    useEffect(() => {
        setDraft("");
        setQueuedPage(0);
        setHistoryPage(0);
        setDisableConfirmation(false);
    }, [ctxId, instance]);

    async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        if (!interactive || draft.trim().length === 0) return;
        const queued = await store.queueContextMessage(instance, ctxId, draft.trim());
        if (queued) setDraft("");
    }

    return <section className="card context-intervention" aria-labelledby="context-intervention-title">
        <div className="context-intervention-heading">
            <div>
                <h3 id="context-intervention-title">Context intervention</h3>
                <p className="hint">{instance} · {ctxId}</p>
            </div>
            {context === undefined || context.status === "disabled" ? null : <div className="actions">
                <button
                    disabled={!interactive || state.operations[renewOperation] !== undefined}
                    onClick={() => void store.renewContext(ctxId)}
                    type="button"
                >{state.operations[renewOperation] !== undefined ? "Renewing…" : "Renew Context"}</button>
                <button
                    className="danger"
                    disabled={!interactive}
                    onClick={() => setDisableConfirmation(true)}
                    type="button"
                >Disable Context</button>
            </div>}
        </div>
        {context === undefined ? <p className="hint">Context registry record unavailable.</p> : <p className="hint">
            Workspace: {environment?.workspace ?? context.workspace ?? "not attached"} · Status: {context.status} · expires {context.expiresAt}
        </p>}
        <form onSubmit={(event) => void submit(event)}>
            <label>Comment
                <textarea
                    disabled={!interactive}
                    maxLength={20_000}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Attach guidance to the next tool call in this Context"
                    rows={3}
                    value={draft}
                />
            </label>
            <button
                className="primary"
                disabled={!interactive || draft.trim().length === 0 || state.operations[operation] !== undefined}
                type="submit"
            >{state.operations[operation] !== undefined ? "Sending…" : "Queue Comment"}</button>
        </form>
        {queuedComments.length === 0 ? null : <section>
            <h4>Queued Comments</h4>
            <ol className="context-messages">
                {pageItems(queuedComments, visibleQueuedPage, commentPageSize).map((message) => <li key={message.id}>
                    <span className={`result ${message.status === "failed" ? "failure" : "pending"}`}>{message.status}</span>
                    <time>{message.createdAt}</time>
                    <p>{message.text}</p>
                    {message.error === undefined ? null : <p className="error">{message.error}</p>}
                </li>)}
            </ol>
            <Pagination label="Queued Comments" onPageChange={setQueuedPage} page={visibleQueuedPage} pageCount={queuedPages} />
        </section>}
        {commentCalls.length === 0 ? null : <section>
            <h4>Delivered Comment history</h4>
            <ol className="context-messages">
                {pageItems(commentCalls, visibleHistoryPage, commentPageSize).map((call) => <li key={call.callId}>
                    <span className="result success">{call.toolName}</span>
                    <time>{call.completedAt ?? call.startedAt}</time>
                    <p><strong>{call.callId}</strong></p>
                    {readCallComments(call).map((comment, index) => <p key={`${call.callId}:${index}`}>{comment}</p>)}
                </li>)}
            </ol>
            <Pagination label="Comment history" onPageChange={setHistoryPage} page={visibleHistoryPage} pageCount={historyPages} />
        </section>}
        {disableConfirmation ? <ConfirmationDialog
            actionLabel="Disable"
            busy={state.operations[disableOperation] !== undefined}
            description={`Disable Context ${ctxId}${environment?.workspace === undefined ? "" : ` from workspace ${environment.workspace}`} across all attached instances? This cannot be renewed; the client must establish a new Context.`}
            disabled={!interactive}
            onCancel={() => setDisableConfirmation(false)}
            onConfirm={() => {
                const request = store.disableContext(ctxId);
                void request.finally(() => setDisableConfirmation(false));
            }}
        /> : null}
    </section>;
}

function Pagination({
    label,
    onPageChange,
    page,
    pageCount,
}: {
    label: string;
    onPageChange(page: number): void;
    page: number;
    pageCount: number;
}) {
    if (pageCount < 2) return null;
    return <nav aria-label={`${label} pagination`} className="pagination">
        <button disabled={page === 0} onClick={() => onPageChange(page - 1)} type="button">Previous page</button>
        <span aria-live="polite">Page {page + 1} of {pageCount}</span>
        <button disabled={page === pageCount - 1} onClick={() => onPageChange(page + 1)} type="button">Next page</button>
    </nav>;
}

function pageCount(total: number, size: number): number {
    return Math.max(1, Math.ceil(total / size));
}

function pageItems<T>(items: readonly T[], page: number, size: number): T[] {
    return items.slice(page * size, (page + 1) * size);
}

function readCallComments(call: ToolCallRecord): string[] {
    return readComments(call.output);
}

function readComments(value: JsonValue | undefined): string[] {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const comment = (value as Record<string, JsonValue>).comment;
    return Array.isArray(comment) && comment.every((entry) => typeof entry === "string")
        ? comment
        : [];
}
