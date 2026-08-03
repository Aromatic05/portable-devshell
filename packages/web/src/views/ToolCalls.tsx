import { type FormEvent, useEffect, useMemo, useState } from "react";

import type { JsonValue, ToolCallRecord } from "@portable-devshell/shared/browser";

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
    const allCalls = useMemo(
        () => Object.values(state.toolCalls).flat(),
        [state.toolCalls],
    );
    const allCommentCalls = useMemo(
        () => Object.values(state.commentCalls).flat(),
        [state.commentCalls],
    );
    const instances = useMemo(
        () => state.instances.map((instance) => instance.name).sort(),
        [state.instances],
    );
    const instance =
        filters.instance === "all" || instances.includes(filters.instance)
            ? filters.instance
            : "all";
    const contexts = useMemo(() => {
        return [...new Set([...allCalls, ...allCommentCalls]
            .filter(
                (call) =>
                    call.ctxId !== undefined &&
                    (instance === "all" || call.instance === instance),
            )
            .map((call) => call.ctxId!))].sort();
    }, [allCalls, allCommentCalls, instance]);
    const selectedCtxId = selectedContextId(filters.ctxId);
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
        () => selectToolCalls(allCalls, effectiveFilters),
        [allCalls, effectiveFilters],
    );
    const active = hasActiveToolCallFilters(effectiveFilters);
    const ctxId = selectedContextId(effectiveFilters.ctxId);
    const concreteContext =
        effectiveFilters.instance !== "all" &&
        ctxId !== undefined &&
        contexts.includes(ctxId);
    const queuedComments = concreteContext
        ? (state.contextMessages[effectiveFilters.instance] ?? [])
              .filter(
                  (message) =>
                      message.ctxId === ctxId &&
                      message.status !== "delivered",
              )
              .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        : [];
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
    const operation = concreteContext
        ? `context-message:${effectiveFilters.instance}:${ctxId}`
        : undefined;
    const interactive = state.connection === "online" && !disabled;

    useEffect(() => {
        if (
            effectiveFilters.instance === filters.instance &&
            effectiveFilters.ctxId === filters.ctxId
        ) return;
        setDraft("");
        setFilters(effectiveFilters);
    }, [effectiveFilters, filters.ctxId, filters.instance]);

    function changeFilters(next: Filters): void {
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

    const countText = selection.total > selection.items.length
        ? `Showing ${selection.items.length} of ${selection.total} matching tool calls.`
        : `${selection.total} of ${allCalls.length} tool calls${active ? " match active filters." : "."}`;

    return <section>
        <h2>Tool Calls</h2>
        <p aria-live="polite" className="hint">{countText}</p>
        <ToolCallFilters
            contexts={contexts}
            filters={effectiveFilters}
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
                    {queuedComments.map((message) => <li key={message.id}>
                        <span className={`result ${message.status === "delivered" ? "success" : message.status === "failed" ? "failure" : "pending"}`}>{message.status}</span>
                        <time>{message.createdAt}</time>
                        <p>{message.text}</p>
                        {message.error === undefined ? null : <p className="error">{message.error}</p>}
                    </li>)}
                    </ol>
                </>}
                <h4>Comment history</h4>
                {commentCalls.length === 0 ? <p className="empty">No tool calls with Comments in this Context.</p> : <ol className="context-messages">
                    {commentCalls.map((call) => <li key={call.callId}>
                        <span className="result success">{call.toolName}</span>
                        <time>{call.completedAt ?? call.startedAt}</time>
                        <p><strong>{call.callId}</strong></p>
                        {readCallComments(call).map((comment, index) => <p key={`${call.callId}:${index}`}>{comment}</p>)}
                    </li>)}
                </ol>}
            </> : <p className="empty">Select one instance and one scoped Context to queue a Comment.</p>}
        </section>
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
                        logs={state.logs[call.instance] ?? []}
                    />)}
                </ol>}
    </section>;
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
