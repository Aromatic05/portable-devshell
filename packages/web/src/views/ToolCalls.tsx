import { type FormEvent, useEffect, useMemo, useState } from "react";

import { ToolCallFilters } from "../components/toolcall/ToolCallFilters.js";
import { ToolCallEntry } from "../components/toolcall/ToolCallEntry.js";
import {
    contextFilterValue,
    emptyToolCallFilters,
    filterToolCalls,
    hasActiveToolCallFilters,
    selectedContextId,
    type ToolCallFilters as Filters,
} from "../selectors/toolCalls.js";
import type { WebState, WebStore } from "../state/WebStore.js";

export function ToolCalls({
    state,
    store,
}: {
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
    const contexts = useMemo(() => {
        const fromCalls = allCalls
            .filter(
                (call) =>
                    call.ctxId !== undefined &&
                    (filters.instance === "all" || call.instance === filters.instance),
            )
            .map((call) => call.ctxId!);
        const fromMessages = Object.entries(state.contextMessages)
            .filter(([instance]) => filters.instance === "all" || instance === filters.instance)
            .flatMap(([, messages]) => messages.map((message) => message.ctxId));
        return [...new Set([...fromCalls, ...fromMessages])].sort();
    }, [allCalls, filters.instance, state.contextMessages]);
    const tools = useMemo(
        () => [...new Set(allCalls.map((call) => call.toolName))].sort(),
        [allCalls],
    );
    const calls = useMemo(
        () => filterToolCalls(allCalls, filters),
        [allCalls, filters],
    );
    const active = hasActiveToolCallFilters(filters);
    const ctxId = selectedContextId(filters.ctxId);
    const concreteContext = filters.instance !== "all" && ctxId !== undefined;
    const messages = concreteContext
        ? (state.contextMessages[filters.instance] ?? [])
              .filter((message) => message.ctxId === ctxId)
              .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        : [];
    const operation = concreteContext
        ? `context-message:${filters.instance}:${ctxId}`
        : undefined;

    useEffect(() => {
        if (
            filters.ctxId !== "all" &&
            filters.ctxId !== "unscoped" &&
            !contexts.map(contextFilterValue).includes(filters.ctxId)
        ) {
            setFilters((current) => ({ ...current, ctxId: "all" }));
        }
    }, [contexts, filters.ctxId]);

    async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        if (!concreteContext || draft.trim().length === 0) return;
        const queued = await store.queueContextMessage(
            filters.instance,
            ctxId!,
            draft,
        );
        if (queued) setDraft("");
    }

    return <section>
        <h2>Tool Calls</h2>
        <p aria-live="polite" className="hint">{calls.length} of {allCalls.length} tool calls{active ? " match active filters." : "."}</p>
        <ToolCallFilters contexts={contexts} filters={filters} instances={instances} onChange={setFilters} onClear={() => setFilters(emptyToolCallFilters)} tools={tools} />
        <section className="card context-composer" aria-labelledby="context-message-title">
            <h3 id="context-message-title">Message to Context</h3>
            {concreteContext ? <>
                <p className="hint">{filters.instance} · {ctxId}</p>
                <form onSubmit={(event) => void submit(event)}>
                    <label>Message<textarea maxLength={20_000} onChange={(event) => setDraft(event.target.value)} placeholder="Send guidance to the Agent working in this Context" rows={4} value={draft} /></label>
                    <button className="primary" disabled={draft.trim().length === 0 || (operation !== undefined && state.operations[operation] !== undefined)} type="submit">{operation !== undefined && state.operations[operation] !== undefined ? "Sending…" : "Send message"}</button>
                </form>
                {messages.length === 0 ? <p className="empty">No messages sent to this Context.</p> : <ol className="context-messages">{messages.map((message) => <li key={message.id}><span className={`result ${message.status === "delivered" ? "success" : message.status === "failed" ? "failure" : "pending"}`}>{message.status}</span><time>{message.createdAt}</time><p>{message.text}</p>{message.error === undefined ? null : <p className="error">{message.error}</p>}</li>)}</ol>}
            </> : <p className="empty">Select one instance and one scoped Context to send a message.</p>}
        </section>
        {state.connection === "offline" && allCalls.length === 0 ? <p className="empty">Tool calls are unavailable while offline.</p> : state.connection === "connecting" && allCalls.length === 0 ? <p className="empty">Loading tool calls…</p> : calls.length === 0 ? <p className="empty">{active ? "No tool calls match these filters." : "No tool calls are available."}</p> : <ol className="feed activity-feed">{calls.map((call) => <ToolCallEntry call={call} key={`${call.instance}-${call.callId}`} logs={state.logs[call.instance] ?? []} />)}</ol>}
    </section>;
}
