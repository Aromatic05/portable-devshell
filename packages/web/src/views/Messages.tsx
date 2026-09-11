import {
    type FormEvent,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";

import { webRouteHref, type WebRoute } from "../routing/hashRoute.js";
import {
    filterWebMessageSessions,
    selectWebMessageEntries,
    selectWebMessageSession,
    selectWebMessageSessions,
    type WebMessageEntry,
} from "../selectors/messages.js";
import type { WebState } from "../state/WebState.js";
import type { WebStore } from "../state/WebStore.js";

export function Messages({
    navigate,
    route,
    state,
    store,
}: {
    navigate(route: WebRoute): void;
    route: Extract<WebRoute, { page: "messages" }>;
    state: WebState;
    store: WebStore;
}) {
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [draft, setDraft] = useState("");
    const [query, setQuery] = useState("");
    const historyEndRef = useRef<HTMLDivElement>(null);
    const followBottomRef = useRef(true);
    const previousThreadKeyRef = useRef<string>();
    const sessions = useMemo(() => selectWebMessageSessions(state), [state]);
    const visibleSessions = useMemo(
        () => filterWebMessageSessions(sessions, query),
        [query, sessions],
    );
    const selected = route.view === "thread"
        ? selectWebMessageSession(state, route.instance, route.ctxId)
        : undefined;
    const entries = route.view === "thread"
        ? selectWebMessageEntries(state, route.instance, route.ctxId)
        : [];
    const threadKey = route.view === "thread"
        ? `${route.instance}\u0000${route.ctxId}`
        : undefined;
    const latestEntryId = entries.at(-1)?.id;
    const sidebarOpen = drawerOpen;

    useEffect(() => {
        setDrawerOpen(false);
        setDraft("");
    }, [route]);

    useLayoutEffect(() => {
        if (threadKey === undefined) {
            previousThreadKeyRef.current = undefined;
            return;
        }
        if (previousThreadKeyRef.current !== threadKey) {
            previousThreadKeyRef.current = threadKey;
            followBottomRef.current = true;
        }
        const end = historyEndRef.current;
        if (followBottomRef.current && typeof end?.scrollIntoView === "function") {
            end.scrollIntoView({ block: "end" });
        }
    }, [latestEntryId, threadKey]);

    useEffect(() => {
        if (threadKey === undefined) return;
        const updateFollowBottom = () => {
            const distanceFromBottom =
                document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
            followBottomRef.current = distanceFromBottom <= 96;
        };
        window.addEventListener("scroll", updateFollowBottom, { passive: true });
        return () => window.removeEventListener("scroll", updateFollowBottom);
    }, [threadKey]);

    async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        if (route.view !== "thread") return;
        const text = draft.trim();
        if (text.length === 0) return;
        const queued = await store.queueContextMessage(route.instance, route.ctxId, text);
        if (queued) setDraft("");
    }

    function exportMarkdown(): void {
        if (route.view !== "thread") return;
        const title = selected?.title ?? route.ctxId;
        downloadMarkdown(
            markdownExportFilename(title, route.instance, route.ctxId),
            buildConversationMarkdown({
                ctxId: route.ctxId,
                entries,
                instance: route.instance,
                title,
            }),
        );
    }

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
                    <h2>{selected?.title ?? (route.view === "thread" ? route.ctxId : "Messages")}</h2>
                    {route.view === "thread" ? <p>{route.instance} · {route.ctxId}</p> : null}
                </div>
                {route.view === "thread" ? <a
                    className="messages-audit-link"
                    href={webRouteHref({
                        page: "audit",
                        view: "timeline",
                        scope: {
                            kind: "context",
                            instance: route.instance,
                            ctxId: route.ctxId,
                        },
                    })}
                >Open in Audit</a> : null}
            </header>
            {route.view === "contexts" ? <div className="messages-placeholder">
                <h3>Messages</h3>
                <p className="empty">Choose a conversation to read its Comment and Report history.</p>
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
                <div aria-hidden="true" className="message-history-end" ref={historyEndRef} />
            </div>}
            {route.view === "thread" ? <form className="messages-composer" onSubmit={(event) => void submit(event)}>
                <label className="sr-only" htmlFor="messages-comment">Comment</label>
                <textarea
                    id="messages-comment"
                    maxLength={20_000}
                    onChange={(event) => {
                        setDrawerOpen(false);
                        setDraft(event.target.value);
                    }}
                    onFocus={() => setDrawerOpen(false)}
                    onKeyDown={(event) => {
                        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                    }}
                    placeholder="Send a Comment"
                    rows={1}
                    value={draft}
                />
                <button
                    aria-label="Export Markdown"
                    className="messages-export"
                    onClick={exportMarkdown}
                    title="Export Markdown"
                    type="button"
                >MD</button>
                <button
                    aria-label="Send Comment"
                    className="primary"
                    disabled={draft.trim().length === 0 || state.operations[`context-message:${route.instance}:${route.ctxId}`] !== undefined}
                    type="submit"
                >{state.operations[`context-message:${route.instance}:${route.ctxId}`] !== undefined ? "…" : "↑"}</button>
            </form> : null}
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

export function buildConversationMarkdown({
    ctxId,
    entries,
    instance,
    title,
}: {
    ctxId: string;
    entries: readonly WebMessageEntry[];
    instance: string;
    title: string;
}): string {
    const lines = [
        `# ${title}`,
        "",
        `- Instance: \`${instance}\``,
        `- Context: \`${ctxId}\``,
    ];

    for (const entry of entries) {
        lines.push(
            "",
            `## ${entry.kind === "comment" ? "You" : "Agent"}`,
            "",
            `_${entry.at}_`,
            "",
            entry.text,
        );
    }

    return `${lines.join("\n")}\n`;
}

function markdownExportFilename(title: string, instance: string, ctxId: string): string {
    const stem = `${title}-${instance}-${ctxId}`
        .replace(/[<>:"/\\|?*]+/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 120);
    return `${stem || "conversation"}.md`;
}

function downloadMarkdown(filename: string, markdown: string): void {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.download = filename;
    link.href = url;
    link.style.display = "none";
    document.body.append(link);
    try {
        link.click();
    } finally {
        link.remove();
        URL.revokeObjectURL(url);
    }
}
