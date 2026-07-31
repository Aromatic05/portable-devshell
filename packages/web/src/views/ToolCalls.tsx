import { type FormEvent, useEffect, useMemo, useState } from "react";

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
    const instances = useMemo(
        () => state.instances.map((instance) => instance.name).sort(),
        [state.instances],
    );
    const instance =
        filters.instance === "all" || instances.includes(filters.instance)
            ? filters.instance
            : "all";
    const contexts = useMemo(() => {
        const fromCalls = allCalls
            .filter(
                (call) =>
                    call.ctxId !== undefined &&
                    (instance === "all" || call.instance === instance),
            )
            .map((call) => call.ctxId!);
        const fromMessages = Object.entries(state.contextMessages)
            .filter(([messageInstance]) =>
                instance === "all" || messageInstance === instance
            )
            .flatMap(([, messages]) => messages.map((message) => message.ctxId));
        return [...new Set([...fromCalls, ...fromMessages])].sort();
    }, [allCalls, instance, state.contextMessages]);
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
    const messages = concreteContext
        ? (state.contextMessages[effectiveFilters.instance] ?? [])
              .filter((message) => message.ctxId === ctxId)
              .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
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
        <section className="card context-composer" aria-labelledby="context-message-title">
            <h3 id="context-message-title">Message to Context</h3>
            {concreteContext ? <>
                <p className="hint">{effectiveFilters.instance} · {ctxId}</p>
                <form onSubmit={(event) => void submit(event)}>
                    <label>
                        Message
                        <textarea
                            disabled={!interactive}
                            maxLength={20_000}
                            onChange={(event) => setDraft(event.target.value)}
                            placeholder="Send guidance to the Agent working in this Context"
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
                            : "Send message"}
                    </button>
                </form>
                {!interactive ? <p className="empty">
                    {disabled ? "Finish the session operation before sending a message." : "Reconnect before sending a message."}
                </p> : null}
                {messages.length === 0 ? <p className="empty">No messages sent to this Context.</p> : <ol className="context-messages">
                    {messages.map((message) => <li key={message.id}>
                        <span className={`result ${message.status === "delivered" ? "success" : message.status === "failed" ? "failure" : "pending"}`}>{message.status}</span>
                        <time>{message.createdAt}</time>
                        <p>{message.text}</p>
                        {message.error === undefined ? null : <p className="error">{message.error}</p>}
                    </li>)}
                </ol>}
            </> : <p className="empty">Select one instance and one scoped Context to send a message.</p>}
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
