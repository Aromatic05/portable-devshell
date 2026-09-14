import {
    type FormEvent,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    createEmptyConversationPreferences,
    parseContextMessageDirective,
    type ContextMessageDirective,
    type ConversationPreferencesPatch,
    type ConversationPreferencesSnapshot,
    workspaceFolderName,
} from "@portable-devshell/shared/browser";

import { webRouteHref, type WebRoute } from "../routing/hashRoute.js";
import {
    filterWebMessageSessions,
    selectWebMessageEntries,
    selectWebMessageHistorySessions,
    selectWebMessageSession,
    selectWebMessageSessions,
    type WebMessageEntry,
    type WebMessageSession,
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
    const [messageDirective, setMessageDirective] = useState<ContextMessageDirective>();
    const [controlMenuOpen, setControlMenuOpen] = useState(false);
    const [composerFeedback, setComposerFeedback] = useState<{
        kind: "error" | "success";
        text: string;
    }>();
    const [query, setQuery] = useState("");
    const [sessionScope, setSessionScope] = useState<"current" | "history">("current");
    const [conversationPreferences, setConversationPreferences] = useState<ConversationPreferencesSnapshot>(
        () => state.conversationPreferences ?? createEmptyConversationPreferences(),
    );
    const [legacyConversationPreferences] = useState<LegacyConversationPreferences | undefined>(
        () => readLegacyConversationPreferences(),
    );
    const [legacyMigrationPending, setLegacyMigrationPending] = useState(
        () => legacyConversationPreferences !== undefined,
    );
    const [currentConversationKeys, setCurrentConversationKeys] = useState<Set<string>>(
        () => new Set(selectWebMessageSessions(state).map(conversationKey)),
    );
    const [expandedHistoryGroups, setExpandedHistoryGroups] = useState<Set<string>>(() => new Set());
    const [editingConversationKey, setEditingConversationKey] = useState<string>();
    const [editingTitle, setEditingTitle] = useState("");
    const [draggingConversationKey, setDraggingConversationKey] = useState<string>();
    const draggingConversationKeyRef = useRef<string>();
    const controlMenuRef = useRef<HTMLDivElement>(null);
    const conversationSearchRef = useRef<HTMLInputElement>(null);
    const drawerTriggerRef = useRef<HTMLButtonElement>(null);
    const historyEndRef = useRef<HTMLDivElement>(null);
    const followBottomRef = useRef(true);
    const previousThreadKeyRef = useRef<string>();
    const sidebarRef = useRef<HTMLDivElement>(null);
    const legacyMigrationStartedRef = useRef(false);
    const preferenceMutationVersionRef = useRef(0);
    const pendingPreferenceMutationsRef = useRef(0);
    const preferenceOrderSyncRef = useRef(false);
    const activeSessions = useMemo(() => selectWebMessageSessions(state), [state]);
    const inactiveSessions = useMemo(() => selectWebMessageHistorySessions(state), [state]);
    const allBaseSessions = useMemo(
        () => [...activeSessions, ...inactiveSessions],
        [activeSessions, inactiveSessions],
    );
    const currentSessions = useMemo(
        () => allBaseSessions.filter((session) => currentConversationKeys.has(conversationKey(session))),
        [allBaseSessions, currentConversationKeys],
    );
    const historySessions = useMemo(
        () => allBaseSessions.filter((session) => !currentConversationKeys.has(conversationKey(session))),
        [allBaseSessions, currentConversationKeys],
    );
    const sessions = useMemo(
        () => applyConversationPreferences(
            sessionScope === "current" ? currentSessions : historySessions,
            conversationPreferences,
        ),
        [conversationPreferences, currentSessions, historySessions, sessionScope],
    );
    const allSessions = useMemo(
        () => applyConversationPreferences(
            allBaseSessions,
            conversationPreferences,
        ),
        [allBaseSessions, conversationPreferences],
    );
    const activeConversationKeys = useMemo(
        () => new Set(activeSessions.map(conversationKey)),
        [activeSessions],
    );
    const visibleSessions = useMemo(
        () => filterWebMessageSessions(sessions, query),
        [query, sessions],
    );
    const historyGroups = useMemo(
        () => groupHistorySessionsByWorkspace(visibleSessions),
        [visibleSessions],
    );
    const selectedBase = route.view === "thread"
        ? selectWebMessageSession(state, route.instance, route.ctxId)
        : undefined;
    const selected = selectedBase === undefined
        ? undefined
        : applyConversationPreferences([selectedBase], conversationPreferences)[0];
    const entries = route.view === "thread"
        ? selectWebMessageEntries(state, route.instance, route.ctxId)
        : [];
    const threadKey = route.view === "thread"
        ? `${route.instance}\u0000${route.ctxId}`
        : undefined;
    const latestEntryId = entries.at(-1)?.id;
    const sidebarOpen = drawerOpen;
    const idleCurrentCount = currentSessions.filter((session) =>
        !activeConversationKeys.has(conversationKey(session)) && conversationKey(session) !== threadKey
    ).length;

    useEffect(() => {
        setCurrentConversationKeys((current) => {
            const next = new Set(current);
            let changed = false;
            for (const session of activeSessions) {
                const key = conversationKey(session);
                if (!next.has(key)) {
                    next.add(key);
                    changed = true;
                }
            }
            return changed ? next : current;
        });
    }, [activeSessions]);

    useEffect(() => {
        if (state.conversationPreferences === undefined || pendingPreferenceMutationsRef.current > 0) return;
        setConversationPreferences(state.conversationPreferences);
    }, [state.conversationPreferences]);

    useEffect(() => {
        if (
            !legacyMigrationPending ||
            legacyConversationPreferences === undefined ||
            state.conversationPreferences === undefined ||
            legacyMigrationStartedRef.current
        ) return;
        legacyMigrationStartedRef.current = true;
        const imported = ensureConversationPreferenceOrder(
            legacyConversationPreferences.preferences,
            allBaseSessions,
            legacyConversationPreferences.legacyOrder,
        );
        void store.updateConversationPreferences({
            ifMissing: true,
            orderByWorkspace: imported.orderByWorkspace,
            titles: imported.titles,
            workspaceOrder: imported.workspaceOrder,
        }).then((succeeded) => {
            if (succeeded) {
                removeLegacyConversationPreferences();
                setConversationPreferences(store.state?.conversationPreferences ?? imported);
            }
            setLegacyMigrationPending(false);
        });
    }, [
        allBaseSessions,
        legacyConversationPreferences,
        legacyMigrationPending,
        state.conversationPreferences,
        store,
    ]);

    useEffect(() => {
        if (
            state.conversationPreferences === undefined ||
            legacyMigrationPending ||
            preferenceOrderSyncRef.current
        ) return;
        const next = ensureConversationPreferenceOrder(conversationPreferences, allBaseSessions);
        if (next === conversationPreferences) return;
        const patch = conversationOrderPatch(conversationPreferences, next);
        if (patch === undefined) return;
        preferenceOrderSyncRef.current = true;
        persistConversationPreferences(next, { ...patch, ifMissing: true }, () => {
            preferenceOrderSyncRef.current = false;
        });
    }, [
        allBaseSessions,
        conversationPreferences,
        legacyMigrationPending,
        state.conversationPreferences,
    ]);

    useEffect(() => {
        setDrawerOpen(false);
        setDraft("");
        setMessageDirective(undefined);
        setControlMenuOpen(false);
        setComposerFeedback(undefined);
        setEditingConversationKey(undefined);
        setEditingTitle("");
    }, [route]);

    useEffect(() => {
        if (!controlMenuOpen) return;
        const pointerDown = (event: PointerEvent) => {
            if (event.target instanceof Node && controlMenuRef.current?.contains(event.target) !== true) {
                setControlMenuOpen(false);
            }
        };
        const keyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") setControlMenuOpen(false);
        };
        document.addEventListener("pointerdown", pointerDown);
        document.addEventListener("keydown", keyDown);
        return () => {
            document.removeEventListener("pointerdown", pointerDown);
            document.removeEventListener("keydown", keyDown);
        };
    }, [controlMenuOpen]);

    useEffect(() => {
        if (!drawerOpen) return;
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        conversationSearchRef.current?.focus();
        const keyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                setDrawerOpen(false);
                drawerTriggerRef.current?.focus();
                return;
            }
            if (event.key !== "Tab") return;
            const controls = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
            ) ?? []).filter((element) => element.offsetParent !== null || element === document.activeElement);
            if (controls.length === 0) return;
            const first = controls[0]!;
            const last = controls.at(-1)!;
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener("keydown", keyDown);
        return () => {
            document.removeEventListener("keydown", keyDown);
            if (document.activeElement === document.body) previous?.focus();
        };
    }, [drawerOpen]);

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
        const text = composeMessageText(messageDirective, draft);
        if (text.length === 0) return;
        setComposerFeedback(undefined);
        const queued = await store.queueContextMessage(route.instance, route.ctxId, text);
        if (queued) {
            setDraft("");
            setMessageDirective(undefined);
            setControlMenuOpen(false);
            setComposerFeedback({ kind: "success", text: "Message queued." });
        } else {
            setComposerFeedback({
                kind: "error",
                text: store.state.error ?? "Message could not be queued.",
            });
        }
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

    function persistConversationPreferences(
        next: ConversationPreferencesSnapshot,
        patch: ConversationPreferencesPatch,
        settled?: () => void,
    ): void {
        const mutationVersion = ++preferenceMutationVersionRef.current;
        pendingPreferenceMutationsRef.current += 1;
        setConversationPreferences(next);
        void store.updateConversationPreferences(patch).then((succeeded) => {
            pendingPreferenceMutationsRef.current = Math.max(0, pendingPreferenceMutationsRef.current - 1);
            if (mutationVersion === preferenceMutationVersionRef.current) {
                if (succeeded) {
                    setConversationPreferences(store.state?.conversationPreferences ?? next);
                } else {
                    setConversationPreferences(
                        store.state?.conversationPreferences ??
                        state.conversationPreferences ??
                        createEmptyConversationPreferences(),
                    );
                }
            }
            settled?.();
        });
    }

    function saveConversationTitle(session: WebMessageSession): void {
        const key = conversationKey(session);
        const nextTitle = editingTitle.trim();
        const titles = { ...conversationPreferences.titles };
        if (nextTitle.length === 0) delete titles[key];
        else titles[key] = nextTitle;
        persistConversationPreferences(
            { ...conversationPreferences, titles },
            { titles: { [key]: nextTitle.length === 0 ? null : nextTitle } },
        );
        setEditingConversationKey(undefined);
        setEditingTitle("");
    }

    function moveConversation(sourceKey: string, targetKey: string): void {
        if (sourceKey === targetKey || state.conversationPreferences === undefined) return;
        const source = allSessions.find((session) => conversationKey(session) === sourceKey);
        const target = allSessions.find((session) => conversationKey(session) === targetKey);
        if (
            source === undefined ||
            target === undefined ||
            workspacePreferenceKey(source) !== workspacePreferenceKey(target)
        ) return;
        const workspace = workspacePreferenceKey(source);
        const order = reorderConversationKeys(
            allSessions.filter((session) => workspacePreferenceKey(session) === workspace),
            sourceKey,
            targetKey,
            conversationPreferences.orderByWorkspace[workspace] ?? [],
        );
        persistConversationPreferences(
            {
                ...conversationPreferences,
                orderByWorkspace: {
                    ...conversationPreferences.orderByWorkspace,
                    [workspace]: order,
                },
            },
            { orderByWorkspace: { [workspace]: order } },
        );
    }

    function finishConversationDrag(clientX: number, clientY: number): void {
        const sourceKey = draggingConversationKeyRef.current;
        draggingConversationKeyRef.current = undefined;
        setDraggingConversationKey(undefined);
        if (sourceKey === undefined) return;
        const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".conversation-row");
        const targetKey = target?.dataset.conversationKey;
        if (targetKey !== undefined) moveConversation(sourceKey, targetKey);
    }

    function archiveIdle(): void {
        setCurrentConversationKeys((current) => new Set([...current].filter((key) =>
            activeConversationKeys.has(key) || key === threadKey
        )));
    }

    function renderSession(session: WebMessageSession) {
        const active = route.view === "thread" &&
            route.instance === session.instance &&
            route.ctxId === session.ctxId;
        const key = conversationKey(session);
        const editing = editingConversationKey === key;
        return <div
            className={`conversation-row${active ? " selected" : ""}${draggingConversationKey === key ? " dragging" : ""}`}
            data-conversation-key={key}
            key={key}
        >
            <span
                aria-hidden="true"
                className="conversation-drag-handle"
                onPointerCancel={() => {
                    draggingConversationKeyRef.current = undefined;
                    setDraggingConversationKey(undefined);
                }}
                onPointerDown={(event) => {
                    if (editing || state.conversationPreferences === undefined || event.button !== 0) return;
                    draggingConversationKeyRef.current = key;
                    setDraggingConversationKey(key);
                    if (typeof event.currentTarget.setPointerCapture === "function") {
                        event.currentTarget.setPointerCapture(event.pointerId);
                    }
                    event.preventDefault();
                }}
                onPointerUp={(event) => finishConversationDrag(event.clientX, event.clientY)}
                title="Drag to reorder"
            >⋮⋮</span>
            {editing ? <div className="conversation-rename-editor">
                <label>
                    <span className="sr-only">Conversation title</span>
                    <input
                        aria-label="Conversation title"
                        autoFocus
                        maxLength={120}
                        onChange={(event) => setEditingTitle(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                setEditingConversationKey(undefined);
                                setEditingTitle("");
                            } else if (event.key === "Enter") {
                                event.preventDefault();
                                saveConversationTitle(session);
                            }
                        }}
                        value={editingTitle}
                    />
                </label>
                <div className="conversation-rename-actions">
                    <button aria-label="Save title" onClick={() => saveConversationTitle(session)} type="button">Save</button>
                    <button
                        aria-label="Cancel rename"
                        onClick={() => {
                            setEditingConversationKey(undefined);
                            setEditingTitle("");
                        }}
                        type="button"
                    >Cancel</button>
                </div>
            </div> : <>
                <button
                    aria-current={active ? "page" : undefined}
                    className="conversation-open"
                    onClick={() => {
                        setDrawerOpen(false);
                        navigate({
                            page: "messages",
                            view: "thread",
                            instance: session.instance,
                            ctxId: session.ctxId,
                        });
                    }}
                    onDoubleClick={(event) => {
                        event.preventDefault();
                        setEditingConversationKey(key);
                        setEditingTitle(session.title);
                    }}
                    type="button"
                >
                    <strong>{session.title}</strong>
                    <span>{session.instance} · {sessionScope === "current"
                        ? (activeConversationKeys.has(key) ? "active" : "idle")
                        : (session.status ?? "history")}</span>
                    <time dateTime={session.latestAt}>{formatConversationDate(session.latestAt)}</time>
                </button>
            </>}
        </div>;
    }

    return <section className="messages-page">
        <button
            aria-label="Close conversations"
            className={`messages-backdrop${sidebarOpen ? " open" : ""}`}
            onClick={() => setDrawerOpen(false)}
            tabIndex={sidebarOpen ? 0 : -1}
            type="button"
        />
        <div className={`messages-sidebar${sidebarOpen ? " open" : ""}`} ref={sidebarRef}>
            <div className="messages-sidebar-heading">
                <strong>Conversations</strong>
                <div aria-label="Conversation scope" className="messages-session-scope" role="group">
                    <button
                        aria-pressed={sessionScope === "current"}
                        onClick={() => setSessionScope("current")}
                        type="button"
                    >Current</button>
                    <button
                        aria-pressed={sessionScope === "history"}
                        onClick={() => setSessionScope("history")}
                        type="button"
                    >History</button>
                </div>
                <button
                    aria-label="Close conversations"
                    className="messages-sidebar-close"
                    onClick={() => setDrawerOpen(false)}
                    type="button"
                >×</button>
            </div>
            {sessionScope === "current" && idleCurrentCount > 0 ? <button
                className="messages-archive-idle"
                onClick={archiveIdle}
                type="button"
            >Archive idle</button> : null}
            {state.conversationPreferencesError === undefined ? null : <p
                className="messages-preference-error error"
                role="alert"
            >Conversation preferences are not being persisted: {state.conversationPreferencesError}</p>}
            <label className="messages-search">
                <span className="sr-only">Search conversations</span>
                <input
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search conversations"
                    ref={conversationSearchRef}
                    type="search"
                    value={query}
                />
            </label>
            <nav aria-label="Conversations" className="conversation-list">
                {visibleSessions.length === 0
                    ? <p className="empty">No conversations found.</p>
                    : sessionScope === "current"
                        ? visibleSessions.map((session) => renderSession(session))
                        : historyGroups.map((group) => <section
                            aria-label={group.label}
                            className="conversation-workspace-group"
                            key={group.key}
                            role="group"
                        >
                            {(() => {
                                const containsSelected = route.view === "thread" && group.sessions.some((session) =>
                                    session.instance === route.instance && session.ctxId === route.ctxId
                                );
                                const expanded = query.trim().length > 0 ||
                                    containsSelected ||
                                    expandedHistoryGroups.has(group.key);
                                return <>
                                    <button
                                        aria-expanded={expanded}
                                        className="conversation-workspace-heading"
                                        onClick={() => setExpandedHistoryGroups((current) => {
                                            const next = new Set(current);
                                            if (next.has(group.key)) next.delete(group.key);
                                            else next.add(group.key);
                                            return next;
                                        })}
                                        title={group.workspace}
                                        type="button"
                                    >
                                        <span>{expanded ? "▾" : "▸"} {group.label}</span>
                                        <span>{group.sessions.length}</span>
                                    </button>
                                    {expanded ? <div className="conversation-workspace-sessions">
                                        {group.sessions.map((session) => renderSession(session))}
                                    </div> : null}
                                </>;
                            })()}
                        </section>)}
            </nav>
        </div>
        <div className="messages-content">
            <header className="messages-thread-heading">
                <button
                    aria-label="Open conversations"
                    className="messages-drawer-toggle"
                    onClick={() => setDrawerOpen(true)}
                    ref={drawerTriggerRef}
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
                {entries.length === 0 ? <p className="empty">No Comments or Reports yet.</p> : entries.map((entry) => {
                    const parsed = entry.kind === "comment"
                        ? parseContextMessageDirective(entry.text)
                        : { body: entry.text };
                    return <article className={`message-entry ${entry.kind}`} key={entry.id}>
                        <div className="message-meta">
                            <strong>{entry.kind === "comment" ? "You" : "Agent"}</strong>
                            <time dateTime={entry.at}>{formatMessageDate(entry.at)}</time>
                            {parsed.directive === undefined ? null
                                : <span className="message-control-chip">#{parsed.directive}</span>}
                            {entry.kind === "comment" && entry.status !== "delivered"
                                ? <span className="result pending">{entry.status}</span>
                                : null}
                        </div>
                        {parsed.body.length === 0 ? null : <p>{parsed.body}</p>}
                    </article>;
                })}
                <div aria-hidden="true" className="message-history-end" ref={historyEndRef} />
            </div>}
            {route.view === "thread" ? <form className="messages-composer" onSubmit={(event) => void submit(event)}>
                {messageDirective === undefined ? null : <div className="messages-composer-controls">
                    <span className="message-control-card">
                        <strong>#{messageDirective}</strong>
                        <button aria-label="Remove message control" onClick={() => setMessageDirective(undefined)} type="button">×</button>
                    </span>
                </div>}
                <div className="messages-control-picker" ref={controlMenuRef}>
                    <button
                        aria-expanded={controlMenuOpen}
                        aria-haspopup="menu"
                        aria-label="Add message control"
                        onClick={() => setControlMenuOpen((open) => !open)}
                        type="button"
                    >+</button>
                    {controlMenuOpen ? <div aria-label="Message controls" className="messages-control-menu" role="menu">
                        {messageControlOptions.map((option) => <button
                            key={option.directive}
                            onClick={() => {
                                setMessageDirective(option.directive);
                                setControlMenuOpen(false);
                            }}
                            role="menuitem"
                            type="button"
                        >
                            <strong>{option.label}</strong>
                            <span>{option.description}</span>
                        </button>)}
                    </div> : null}
                </div>
                <label className="sr-only" htmlFor="messages-comment">Comment</label>
                <textarea
                    id="messages-comment"
                    maxLength={20_000}
                    onChange={(event) => {
                        setDrawerOpen(false);
                        setComposerFeedback(undefined);
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
                    disabled={(draft.trim().length === 0 && messageDirective === undefined) || state.operations[`context-message:${route.instance}:${route.ctxId}`] !== undefined}
                    type="submit"
                >{state.operations[`context-message:${route.instance}:${route.ctxId}`] !== undefined ? "…" : "↑"}</button>
                {composerFeedback === undefined ? null : <p
                    className={`messages-composer-feedback ${composerFeedback.kind === "error" ? "error" : "notice"}`}
                    role={composerFeedback.kind === "error" ? "alert" : "status"}
                >{composerFeedback.text}</p>}
            </form> : null}
        </div>
    </section>;
}

const messageControlOptions: ReadonlyArray<{
    description: string;
    directive: ContextMessageDirective;
    label: string;
}> = [
    { description: "Require a reply within five tool calls.", directive: "push", label: "Push" },
    { description: "Stop model tool calls until resumed.", directive: "stop", label: "Stop" },
    { description: "Release a previous Stop.", directive: "resume", label: "Resume" },
];

function composeMessageText(directive: ContextMessageDirective | undefined, draft: string): string {
    const text = draft.trim();
    if (directive === undefined) return text;
    const parsed = parseContextMessageDirective(text);
    const body = parsed.directive === undefined ? text : parsed.body;
    return body.length === 0 ? `#${directive}` : `#${directive} ${body}`;
}

function formatMessageDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}

function formatConversationDate(value: string, now = new Date()): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const sameYear = date.getFullYear() === now.getFullYear();
    const sameDay = sameYear && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    return new Intl.DateTimeFormat(undefined, {
        ...(sameDay ? {} : {
            day: "numeric",
            month: "short",
            ...(sameYear ? {} : { year: "numeric" as const }),
        }),
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
}

function groupHistorySessionsByWorkspace(sessions: readonly WebMessageSession[]): Array<{
    key: string;
    label: string;
    sessions: WebMessageSession[];
    workspace?: string;
}> {
    const groups = new Map<string, {
        key: string;
        label: string;
        sessions: WebMessageSession[];
        workspace?: string;
    }>();
    for (const session of sessions) {
        const key = session.workspace ?? "\u0000other";
        const group = groups.get(key) ?? {
            key,
            label: session.workspace === undefined ? "Other" : workspaceFolderName(session.workspace),
            sessions: [],
            ...(session.workspace === undefined ? {} : { workspace: session.workspace }),
        };
        group.sessions.push(session);
        groups.set(key, group);
    }
    return [...groups.values()];
}

interface LegacyConversationPreferences {
    legacyOrder: string[];
    preferences: ConversationPreferencesSnapshot;
}

const conversationPreferencesStorageKey = "portable-devshell:web:conversation-preferences:v1";

function conversationKey(session: Pick<WebMessageSession, "ctxId" | "instance">): string {
    return `${session.instance}\u0000${session.ctxId}`;
}

function workspacePreferenceKey(session: Pick<WebMessageSession, "instance" | "workspace">): string {
    return session.workspace ?? `\u0000${session.instance}`;
}

function readLegacyConversationPreferences(): LegacyConversationPreferences | undefined {
    if (typeof window === "undefined") return undefined;
    try {
        const raw = window.localStorage.getItem(conversationPreferencesStorageKey);
        if (raw === null) return undefined;
        const parsed = JSON.parse(raw) as {
            order?: unknown;
            orderByWorkspace?: unknown;
            titles?: unknown;
            workspaceOrder?: unknown;
        };
        const legacyOrder = Array.isArray(parsed.order)
            ? parsed.order.filter((value): value is string => typeof value === "string")
            : [];
        const orderByWorkspace = typeof parsed.orderByWorkspace === "object" &&
            parsed.orderByWorkspace !== null &&
            !Array.isArray(parsed.orderByWorkspace)
            ? Object.fromEntries(Object.entries(parsed.orderByWorkspace).flatMap(([workspace, value]) =>
                Array.isArray(value)
                    ? [[workspace, value.filter((item): item is string => typeof item === "string")]]
                    : []
            ))
            : {};
        const titles = typeof parsed.titles === "object" && parsed.titles !== null && !Array.isArray(parsed.titles)
            ? Object.fromEntries(Object.entries(parsed.titles).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
            ))
            : {};
        const workspaceOrder = Array.isArray(parsed.workspaceOrder)
            ? parsed.workspaceOrder.filter((value): value is string => typeof value === "string")
            : [];
        return {
            legacyOrder,
            preferences: { orderByWorkspace, titles, version: 1, workspaceOrder },
        };
    } catch {
        return undefined;
    }
}

function removeLegacyConversationPreferences(): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.removeItem(conversationPreferencesStorageKey);
    } catch {
        // Migration cleanup is best-effort after the server has accepted the preferences.
    }
}

function applyConversationPreferences(
    sessions: readonly WebMessageSession[],
    preferences: ConversationPreferencesSnapshot,
): WebMessageSession[] {
    const workspaceRank = new Map(preferences.workspaceOrder.map((key, index) => [key, index]));
    return sessions
        .map((session) => ({
            ...session,
            title: preferences.titles[conversationKey(session)] ?? session.title,
        }))
        .sort((left, right) => {
            const leftWorkspace = workspacePreferenceKey(left);
            const rightWorkspace = workspacePreferenceKey(right);
            if (leftWorkspace !== rightWorkspace) {
                const leftWorkspaceRank = workspaceRank.get(leftWorkspace);
                const rightWorkspaceRank = workspaceRank.get(rightWorkspace);
                if (leftWorkspaceRank !== undefined || rightWorkspaceRank !== undefined) {
                    if (leftWorkspaceRank === undefined) return 1;
                    if (rightWorkspaceRank === undefined) return -1;
                    return leftWorkspaceRank - rightWorkspaceRank;
                }
                return leftWorkspace.localeCompare(rightWorkspace);
            }
            const rank = new Map((preferences.orderByWorkspace[leftWorkspace] ?? [])
                .map((key, index) => [key, index]));
            const leftRank = rank.get(conversationKey(left));
            const rightRank = rank.get(conversationKey(right));
            if (leftRank === undefined && rightRank === undefined) return right.startedAt.localeCompare(left.startedAt) || left.ctxId.localeCompare(right.ctxId);
            if (leftRank === undefined) return -1;
            if (rightRank === undefined) return 1;
            return leftRank - rightRank;
        });
}

function ensureConversationPreferenceOrder(
    preferences: ConversationPreferencesSnapshot,
    sessions: readonly WebMessageSession[],
    legacyOrder: readonly string[] = [],
): ConversationPreferencesSnapshot {
    const workspaceSessions = new Map<string, WebMessageSession[]>();
    for (const session of sessions) {
        const workspace = workspacePreferenceKey(session);
        const current = workspaceSessions.get(workspace) ?? [];
        current.push(session);
        workspaceSessions.set(workspace, current);
    }
    const loadedWorkspaces = [...workspaceSessions.keys()];
    const workspaceOrder = [
        ...preferences.workspaceOrder,
        ...loadedWorkspaces.filter((workspace) => !preferences.workspaceOrder.includes(workspace)),
    ];
    const orderByWorkspace = { ...preferences.orderByWorkspace };
    let changed = workspaceOrder.length !== preferences.workspaceOrder.length ||
        workspaceOrder.some((workspace, index) => workspace !== preferences.workspaceOrder[index]);
    for (const [workspace, values] of workspaceSessions) {
        const loadedKeys = values.map(conversationKey);
        const previous = orderByWorkspace[workspace] ?? legacyOrder.filter((key) => loadedKeys.includes(key));
        const missing = loadedKeys.filter((key) => !previous.includes(key));
        const next = [...missing, ...previous];
        if (
            orderByWorkspace[workspace] === undefined ||
            next.length !== orderByWorkspace[workspace]!.length ||
            next.some((key, index) => key !== orderByWorkspace[workspace]![index])
        ) {
            orderByWorkspace[workspace] = next;
            changed = true;
        }
    }
    if (!changed) return preferences;
    return { ...preferences, orderByWorkspace, workspaceOrder };
}

function conversationOrderPatch(
    current: ConversationPreferencesSnapshot,
    next: ConversationPreferencesSnapshot,
): ConversationPreferencesPatch | undefined {
    const orderByWorkspace = Object.fromEntries(Object.entries(next.orderByWorkspace).filter(([workspace, order]) => {
        const previous = current.orderByWorkspace[workspace];
        return previous === undefined ||
            previous.length !== order.length ||
            order.some((key, index) => key !== previous[index]);
    }));
    const workspaceOrderChanged = current.workspaceOrder.length !== next.workspaceOrder.length ||
        next.workspaceOrder.some((workspace, index) => workspace !== current.workspaceOrder[index]);
    if (Object.keys(orderByWorkspace).length === 0 && !workspaceOrderChanged) return undefined;
    return {
        ...(Object.keys(orderByWorkspace).length === 0 ? {} : { orderByWorkspace }),
        ...(workspaceOrderChanged ? { workspaceOrder: next.workspaceOrder } : {}),
    };
}

function reorderConversationKeys(
    sessions: readonly WebMessageSession[],
    sourceKey: string,
    targetKey: string,
    previousOrder: readonly string[],
): string[] {
    const keys = sessions.map(conversationKey);
    const sourceIndex = keys.indexOf(sourceKey);
    const targetIndex = keys.indexOf(targetKey);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return [...previousOrder];
    const [moved] = keys.splice(sourceIndex, 1);
    if (moved === undefined) return [...previousOrder];
    keys.splice(targetIndex, 0, moved);
    const loaded = new Set(keys);
    return [...keys, ...previousOrder.filter((key) => !loaded.has(key))];
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
