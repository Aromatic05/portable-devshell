import { useEffect, useMemo, useState } from "react";

import { webRouteHref, type WebRoute } from "../routing/hashRoute.js";
import {
    filterWebMessageSessions,
    selectWebMessageEntries,
    selectWebMessageSessions,
} from "../selectors/messages.js";
import type { WebState } from "../state/WebState.js";

export function Messages({
    navigate,
    route,
    state,
}: {
    navigate(route: WebRoute): void;
    route: Extract<WebRoute, { page: "messages" }>;
    state: WebState;
}) {
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [query, setQuery] = useState("");
    const sessions = useMemo(() => selectWebMessageSessions(state), [state]);
    const visibleSessions = useMemo(
        () => filterWebMessageSessions(sessions, query),
        [query, sessions],
    );
    const selected = route.view === "thread"
        ? sessions.find((session) =>
            session.instance === route.instance && session.ctxId === route.ctxId
        )
        : undefined;
    const entries = route.view === "thread"
        ? selectWebMessageEntries(state, route.instance, route.ctxId)
        : [];
    const sidebarOpen = drawerOpen;

    useEffect(() => setDrawerOpen(false), [route]);

    return <section className="messages-page">
        <button
            aria-label="Close conversations"
            className={`messages-backdrop${sidebarOpen ? " open" : ""}`}
            onClick={() => setDrawerOpen(false)}
            tabIndex={sidebarOpen ? 0 : -1}
            type="button"
        />
        <div className={`messages-sidebar${sidebarOpen ? " open" : ""}`}>
            <div className="messages-sidebar-heading">
                <strong>Conversations</strong>
                <button
                    aria-label="Close conversations"
                    className="messages-sidebar-close"
                    onClick={() => setDrawerOpen(false)}
                    type="button"
                >×</button>
            </div>
            <label className="messages-search">
                <span className="sr-only">Search conversations</span>
                <input
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search conversations"
                    type="search"
                    value={query}
                />
            </label>
            <nav aria-label="Conversations" className="conversation-list">
                {visibleSessions.length === 0 ? <p className="empty">No conversations found.</p> : visibleSessions.map((session) => {
                    const active = route.view === "thread" &&
                        route.instance === session.instance &&
                        route.ctxId === session.ctxId;
                    return <button
                        aria-current={active ? "page" : undefined}
                        className={active ? "selected" : ""}
                        key={`${session.instance}:${session.ctxId}`}
                        onClick={() => {
                            setDrawerOpen(false);
                            navigate({
                                page: "messages",
                                view: "thread",
                                instance: session.instance,
                                ctxId: session.ctxId,
                            });
                        }}
                        type="button"
                    >
                        <strong>{session.title}</strong>
                        <span>{session.instance} · {session.status ?? "history"}</span>
                        <time dateTime={session.latestAt}>{formatMessageDate(session.latestAt)}</time>
                    </button>;
                })}
            </nav>
        </div>
        <div className="messages-content">
            <header className="messages-thread-heading">
                <button
                    aria-label="Open conversations"
                    className="messages-drawer-toggle"
                    onClick={() => setDrawerOpen(true)}
                    type="button"
                >
                    <span aria-hidden="true" className="two-line-menu"><i /><i /></span>
                </button>
                <div>
                    <h2>{selected?.title ?? "Messages"}</h2>
                    {selected === undefined ? null : <p>{selected.instance} · {selected.ctxId}</p>}
                </div>
                {selected === undefined ? null : <a
                    className="messages-audit-link"
                    href={webRouteHref({
                        page: "audit",
                        view: "timeline",
                        scope: {
                            kind: "context",
                            instance: selected.instance,
                            ctxId: selected.ctxId,
                        },
                    })}
                >Open in Audit</a>}
            </header>
            {route.view === "contexts" ? <div className="messages-placeholder">
                <h3>Messages</h3>
                <p className="empty">Choose a conversation to read its Comment and Report history.</p>
            </div> : selected === undefined ? <div className="messages-placeholder">
                <h3>Conversation unavailable</h3>
                <p className="empty">This Context is no longer present in the current read model.</p>
            </div> : <div aria-label="Conversation history" className="message-history" role="log">
                {entries.length === 0 ? <p className="empty">No Comments or Reports yet.</p> : entries.map((entry) => <article
                    className={`message-entry ${entry.kind}`}
                    key={entry.id}
                >
                    <div className="message-meta">
                        <strong>{entry.kind === "comment" ? "You" : "Agent"}</strong>
                        <time dateTime={entry.at}>{formatMessageDate(entry.at)}</time>
                        {entry.kind === "comment" && entry.status !== "delivered"
                            ? <span className="result pending">{entry.status}</span>
                            : null}
                    </div>
                    <p>{entry.text}</p>
                </article>)}
            </div>}
        </div>
    </section>;
}

function formatMessageDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}
