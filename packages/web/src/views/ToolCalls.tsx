import { type FormEvent, useEffect, useMemo, useState } from "react";

import type { JsonValue, ToolCallRecord } from "@portable-devshell/shared/browser";

import { ConfirmationDialog } from "../components/ConfirmationDialog.js";
import { ToolCallFilters } from "../components/toolcall/ToolCallFilters.js";
import { ToolCallEntry } from "../components/toolcall/ToolCallEntry.js";
import {
    allContextsFilter,
    emptyToolCallFilters,
    hasActiveToolCallFilters,
    selectToolCalls,
    selectedContextId,
    unscopedContextFilter,
    type ToolCallFilters as Filters,
} from "../selectors/toolCalls.js";
import type { WebState, WebStore } from "../state/WebStore.js";

const toolCallPageSize = 20;
const commentPageSize = 8;

export function ToolCalls({
    disabled = false,
    state,
    store,
}: {
    disabled?: boolean;
    state: WebState;
    store: WebStore;
}) {
    const [filters, setFilters] = useState<Filters>(emptyToolCallFilters);
    const [draft, setDraft] = useState("");
    const [toolCallPage, setToolCallPage] = useState(0);
    const [queuedCommentPage, setQueuedCommentPage] = useState(0);
    const [commentHistoryPage, setCommentHistoryPage] = useState(0);
    const [disableConfirmation, setDisableConfirmation] = useState<{
        ctxId: string;
        instance: string;
    }>();
    const instanceState = state.readModel.instanceState;
    const allCalls = useMemo(
        () => Object.values(instanceState).flatMap((value) => value.toolCalls),
        [instanceState],
    );
    const allCommentCalls = useMemo(
        () => Object.values(instanceState).flatMap((value) => value.commentCalls),
        [instanceState],
    );
    const instances = useMemo(
        () => state.readModel.instances.map((instance) => instance.name).sort(),
        [state.readModel.instances],
    );
    const selectedCtxId = selectedContextId(filters.ctxId);
    const contextInstances = useMemo(() => {
        const owners = new Map<string, string>();
        for (const context of state.readModel.contexts) owners.set(context.ctxId, context.instance);
        for (const call of [...allCalls, ...allCommentCalls]) {
            if (call.ctxId !== undefined) owners.set(call.ctxId, call.instance);
        }
        return owners;
    }, [allCalls, allCommentCalls, state.readModel.contexts]);
    const contexts = useMemo(() => [...contextInstances.keys()].sort(), [contextInstances]);
    const contextInstance = selectedCtxId === undefined
        ? undefined
        : contextInstances.get(selectedCtxId);
    const instance = contextInstance ?? (
        filters.instance === "all" || instances.includes(filters.instance)
            ? filters.instance
            : "all"
    );
    const contextFilter =
        filters.ctxId === allContextsFilter ||
        filters.ctxId === unscopedContextFilter ||
        (selectedCtxId !== undefined && contexts.includes(selectedCtxId))
            ? filters.ctxId
            : allContextsFilter;
    const effectiveFilters = useMemo(
        () => ({ ...filters, ctxId: contextFilter, instance }),
        [contextFilter, filters, instance],
    );
    const tools = useMemo(
        () => [...new Set(allCalls.map((call) => call.toolName))].sort(),
        [allCalls],
    );
    const selection = useMemo(
        () => selectToolCalls(
            allCalls,
            effectiveFilters,
            Date.now(),
            toolCallPage * toolCallPageSize,
            toolCallPageSize,
        ),
        [allCalls, effectiveFilters, toolCallPage],
    );
    const active = hasActiveToolCallFilters(effectiveFilters);
    const ctxId = selectedContextId(effectiveFilters.ctxId);
    const concreteContext =
        effectiveFilters.instance !== "all" &&
        ctxId !== undefined &&
        contexts.includes(ctxId);
    const queuedComments = concreteContext
        ? (instanceState[effectiveFilters.instance]?.contextMessages ?? [])
              .filter(
                  (message) =>
                      message.ctxId === ctxId &&
                      message.status !== "delivered",
              )
              .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        : [];
    const queuedCommentPages = pageCount(queuedComments.length, commentPageSize);
    const visibleQueuedCommentPage = Math.min(queuedCommentPage, queuedCommentPages - 1);
    const visibleQueuedComments = pageItems(
        queuedComments,
        visibleQueuedCommentPage,
        commentPageSize,
    );
    const commentCalls = concreteContext
        ? allCommentCalls
              .filter(
                  (call) =>
                      call.instance === effectiveFilters.instance &&
                      call.ctxId === ctxId &&
                      readCallComments(call).length > 0,
              )
              .sort((left, right) =>
                  (right.completedAt ?? right.startedAt).localeCompare(
                      left.completedAt ?? left.startedAt,
                  ),
              )
        : [];
    const commentHistoryPages = pageCount(commentCalls.length, commentPageSize);
    const visibleCommentHistoryPage = Math.min(commentHistoryPage, commentHistoryPages - 1);
    const visibleCommentCalls = pageItems(
        commentCalls,
        visibleCommentHistoryPage,
        commentPageSize,
    );
    const operation = concreteContext
        ? `context-message:${effectiveFilters.instance}:${ctxId}`
        : undefined;
    const interactive = state.connection === "online" && !disabled;
    const contextRecord = concreteContext
        ? state.readModel.contexts.find(
              (record) =>
                  record.ctxId === ctxId &&
                  record.instance === effectiveFilters.instance,
          )
        : undefined;
    const disableOperation = disableConfirmation === undefined
        ? undefined
        : `context-disable:${disableConfirmation.ctxId}`;

    useEffect(() => {
        if (
            effectiveFilters.instance === filters.instance &&
            effectiveFilters.ctxId === filters.ctxId
        ) return;
        setDraft("");
        setFilters(effectiveFilters);
    }, [effectiveFilters, filters.ctxId, filters.instance]);

    useEffect(() => {
        setToolCallPage(0);
    }, [effectiveFilters]);

    useEffect(() => {
        setQueuedCommentPage(0);
        setCommentHistoryPage(0);
    }, [concreteContext, ctxId, effectiveFilters.instance]);

    function changeFilters(next: Filters): void {
        setToolCallPage(0);
        setFilters((current) => {
            const contextChanged =
                next.instance !== current.instance || next.ctxId !== current.ctxId;
            if (contextChanged) setDraft("");
            return next.instance !== current.instance
                ? { ...next, ctxId: allContextsFilter }
                : next;
        });
    }

    async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        if (!interactive || !concreteContext || draft.trim().length === 0) return;
        const queued = await store.queueContextMessage(
            effectiveFilters.instance,
            ctxId,
            draft.trim(),
        );
        if (queued) setDraft("");
    }

    const countText = selection.total === 0
        ? `0 of ${allCalls.length} tool calls${active ? " match active filters." : "."}`
        : `Showing ${toolCallPage * toolCallPageSize + 1}-${toolCallPage * toolCallPageSize + selection.items.length} of ${selection.total} matching tool calls.`;

    return <section>
        <h2>Tool Calls</h2>
        <p aria-live="polite" className="hint">{countText}</p>
        <ToolCallFilters
            contexts={contexts}
            filters={effectiveFilters}
            instanceLocked={contextInstance !== undefined}
            instances={instances}
            onChange={changeFilters}
            onClear={() => {
                setDraft("");
                setFilters(emptyToolCallFilters);
            }}
            tools={tools}
        />
        <section className="card context-composer" aria-labelledby="context-comment-title">
            <h3 id="context-comment-title">Comment for next tool call</h3>
            {concreteContext ? <>
                <p className="hint">{effectiveFilters.instance} · {ctxId}</p>
                {contextRecord === undefined ? null : <p className="hint">
                    Status: {contextRecord.status} · expires {contextRecord.expiresAt}
                </p>}
                {contextRecord !== undefined && contextRecord.status !== "disabled" ? <p>
                    <button
                        className="danger"
                        disabled={!interactive}
                        onClick={() => setDisableConfirmation({
                            ctxId,
                            instance: effectiveFilters.instance,
                        })}
                        type="button"
                    >
                        Disable Context
                    </button>{" "}
                    <button
                        disabled={!interactive}
                        onClick={() => void store.renewContext(ctxId)}
                        type="button"
                    >
                        Renew Context
                    </button>
                </p> : null}
                <form onSubmit={(event) => void submit(event)}>
                    <label>
                        Comment
                        <textarea
                            disabled={!interactive}
                            maxLength={20_000}
                            onChange={(event) => setDraft(event.target.value)}
                            placeholder="Attach guidance to the next tool call in this Context"
                            rows={4}
                            value={draft}
                        />
                    </label>
                    <button
                        className="primary"
                        disabled={
                            !interactive ||
                            draft.trim().length === 0 ||
                            (operation !== undefined && state.operations[operation] !== undefined)
                        }
                        type="submit"
                    >
                        {operation !== undefined && state.operations[operation] !== undefined
                            ? "Sending…"
                            : "Queue Comment"}
                    </button>
                </form>
                {!interactive ? <p className="empty">
                    {disabled ? "Finish the session operation before queuing a Comment." : "Reconnect before queuing a Comment."}
                </p> : null}
                {queuedComments.length === 0 ? null : <>
                    <h4>Queued for next call</h4>
                    <ol className="context-messages">
                    {visibleQueuedComments.map((message) => <li key={message.id}>
                        <span className={`result ${message.status === "delivered" ? "success" : message.status === "failed" ? "failure" : "pending"}`}>{message.status}</span>
                        <time>{message.createdAt}</time>
                        <p>{message.text}</p>
                        {message.error === undefined ? null : <p className="error">{message.error}</p>}
                    </li>)}
                    </ol>
                    <Pagination
                        label="Queued Comments"
                        onPageChange={setQueuedCommentPage}
                        page={visibleQueuedCommentPage}
                        pageCount={queuedCommentPages}
                    />
                </>}
                <h4>Comment history</h4>
                {commentCalls.length === 0 ? <p className="empty">No tool calls with Comments in this Context.</p> : <ol className="context-messages">
                    {visibleCommentCalls.map((call) => <li key={call.callId}>
                        <span className="result success">{call.toolName}</span>
                        <time>{call.completedAt ?? call.startedAt}</time>
                        <p><strong>{call.callId}</strong></p>
                        {readCallComments(call).map((comment, index) => <p key={`${call.callId}:${index}`}>{comment}</p>)}
                    </li>)}
                </ol>}
                {commentCalls.length === 0 ? null : <Pagination
                    label="Comment history"
                    onPageChange={setCommentHistoryPage}
                    page={visibleCommentHistoryPage}
                    pageCount={commentHistoryPages}
                />}
            </> : <p className="empty">Select one instance and one scoped Context to queue a Comment.</p>}
        </section>
        {disableConfirmation === undefined ? null : <ConfirmationDialog
            actionLabel="Disable"
            busy={disableOperation !== undefined && state.operations[disableOperation] !== undefined}
            description={`Disable Context ${disableConfirmation.ctxId} for ${disableConfirmation.instance}? This cannot be renewed; the client must establish a new Context.`}
            onCancel={() => setDisableConfirmation(undefined)}
            onConfirm={() => {
                const request = store.disableContext(disableConfirmation.ctxId);
                void request.finally(() => setDisableConfirmation(undefined));
            }}
        />}
        {state.connection === "offline" && allCalls.length === 0
            ? <p className="empty">Tool calls are unavailable while offline.</p>
            : state.connection === "connecting" && allCalls.length === 0
              ? <p className="empty">Loading tool calls…</p>
              : selection.items.length === 0
                ? <p className="empty">{active ? "No tool calls match these filters." : "No tool calls are available."}</p>
                : <ol className="feed activity-feed">
                    {selection.items.map((call) => <ToolCallEntry
                        call={call}
                        key={`${call.instance}-${call.callId}`}
                        logs={instanceState[call.instance]?.logs ?? []}
                    />)}
                </ol>}
        <Pagination
            label="Tool calls"
            onPageChange={setToolCallPage}
            page={toolCallPage}
            pageCount={pageCount(selection.total, toolCallPageSize)}
        />
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
