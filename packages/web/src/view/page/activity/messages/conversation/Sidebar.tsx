import {
    type Dispatch,
    type RefObject,
    type SetStateAction,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import type {
    ConversationPreferencesPatch,
    ConversationPreferencesSnapshot,
} from "@portable-devshell/shared/browser";

import type { WebRoute } from "../../../../../app/Route.js";
import {
    applyConversationPreferences,
    conversationKey,
    filterWebMessageSessions,
    groupMessageSessionsByWorkspace,
    isConversationHidden,
    reorderConversationKeys,
    workspacePreferenceKey,
    type WebMessageSession,
} from "../Model.js";

export function ConversationSidebar({
    activeSessions,
    allBaseSessions,
    conversationPreferences,
    currentConversationKeys,
    navigate,
    onClose,
    persistPreferences,
    preferenceError,
    preferencesAvailable,
    route,
    setCurrentConversationKeys,
    threadKey,
    triggerRef,
    open,
}: {
    activeSessions: readonly WebMessageSession[];
    allBaseSessions: readonly WebMessageSession[];
    conversationPreferences: ConversationPreferencesSnapshot;
    currentConversationKeys: Set<string>;
    navigate(route: WebRoute): void;
    onClose(): void;
    persistPreferences(
        next: ConversationPreferencesSnapshot,
        patch: ConversationPreferencesPatch,
    ): void;
    preferenceError?: string;
    preferencesAvailable: boolean;
    route: Extract<WebRoute, { page: "messages" }>;
    setCurrentConversationKeys: Dispatch<SetStateAction<Set<string>>>;
    threadKey?: string;
    triggerRef: RefObject<HTMLButtonElement | null>;
    open: boolean;
}) {
    const [query, setQuery] = useState("");
    const [sessionScope, setSessionScope] = useState<
        "current" | "history" | "hidden"
    >("current");
    const [expandedHistoryGroups, setExpandedHistoryGroups] = useState<
        Set<string>
    >(() => new Set());
    const [editingConversationKey, setEditingConversationKey] =
        useState<string>();
    const [editingTitle, setEditingTitle] = useState("");
    const [draggingConversationKey, setDraggingConversationKey] =
        useState<string>();
    const draggingConversationKeyRef = useRef<string>();
    const searchRef = useRef<HTMLInputElement>(null);
    const sidebarRef = useRef<HTMLDivElement>(null);

    const currentSessions = useMemo(
        () =>
            allBaseSessions.filter(
                (session) =>
                    !isConversationHidden(conversationPreferences, session) &&
                    currentConversationKeys.has(conversationKey(session)),
            ),
        [allBaseSessions, conversationPreferences, currentConversationKeys],
    );
    const historySessions = useMemo(
        () =>
            allBaseSessions.filter(
                (session) =>
                    !isConversationHidden(conversationPreferences, session) &&
                    !currentConversationKeys.has(conversationKey(session)),
            ),
        [allBaseSessions, conversationPreferences, currentConversationKeys],
    );
    const hiddenSessions = useMemo(
        () =>
            allBaseSessions.filter((session) =>
                isConversationHidden(conversationPreferences, session),
            ),
        [allBaseSessions, conversationPreferences],
    );
    const sessions = useMemo(
        () =>
            applyConversationPreferences(
                sessionScope === "current"
                    ? currentSessions
                    : sessionScope === "history"
                      ? historySessions
                      : hiddenSessions,
                conversationPreferences,
            ),
        [
            conversationPreferences,
            currentSessions,
            hiddenSessions,
            historySessions,
            sessionScope,
        ],
    );
    const allSessions = useMemo(
        () =>
            applyConversationPreferences(
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
    const visibleGroups = useMemo(
        () => groupMessageSessionsByWorkspace(visibleSessions),
        [visibleSessions],
    );
    const allGroups = useMemo(
        () => groupMessageSessionsByWorkspace(allSessions),
        [allSessions],
    );
    const idleCurrentCount = currentSessions.filter(
        (session) =>
            !activeConversationKeys.has(conversationKey(session)) &&
            conversationKey(session) !== threadKey,
    ).length;

    useEffect(() => {
        if (!open) return;
        const previous =
            document.activeElement instanceof HTMLElement
                ? document.activeElement
                : undefined;
        searchRef.current?.focus();
        const keyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                triggerRef.current?.focus();
                return;
            }
            if (event.key !== "Tab") return;
            const controls = Array.from(
                sidebarRef.current?.querySelectorAll<HTMLElement>(
                    'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
                ) ?? [],
            ).filter(
                (element) =>
                    element.offsetParent !== null ||
                    element === document.activeElement,
            );
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
    }, [onClose, open, triggerRef]);

    function saveConversationTitle(session: WebMessageSession): void {
        const key = conversationKey(session);
        const nextTitle = editingTitle.trim();
        const titles = { ...conversationPreferences.titles };
        if (nextTitle.length === 0) delete titles[key];
        else titles[key] = nextTitle;
        persistPreferences(
            { ...conversationPreferences, titles },
            { titles: { [key]: nextTitle.length === 0 ? null : nextTitle } },
        );
        setEditingConversationKey(undefined);
        setEditingTitle("");
    }

    function moveConversation(sourceKey: string, targetKey: string): void {
        if (sourceKey === targetKey || !preferencesAvailable) return;
        const source = allSessions.find(
            (session) => conversationKey(session) === sourceKey,
        );
        const target = allSessions.find(
            (session) => conversationKey(session) === targetKey,
        );
        if (
            source === undefined ||
            target === undefined ||
            workspacePreferenceKey(source) !== workspacePreferenceKey(target)
        )
            return;
        const workspace = workspacePreferenceKey(source);
        const order = reorderConversationKeys(
            allSessions.filter(
                (session) => workspacePreferenceKey(session) === workspace,
            ),
            sourceKey,
            targetKey,
            conversationPreferences.orderByWorkspace[workspace] ?? [],
        );
        persistPreferences(
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
        const target = document
            .elementFromPoint(clientX, clientY)
            ?.closest<HTMLElement>(".conversation-row");
        const targetKey = target?.dataset.conversationKey;
        if (targetKey !== undefined) moveConversation(sourceKey, targetKey);
    }

    function archiveIdle(): void {
        setCurrentConversationKeys(
            (current) =>
                new Set(
                    [...current].filter(
                        (key) =>
                            activeConversationKeys.has(key) ||
                            key === threadKey,
                    ),
                ),
        );
    }

    function setContextsHidden(
        ctxIds: readonly string[],
        hidden: boolean,
    ): void {
        if (!preferencesAvailable) return;
        const uniqueIds = [...new Set(ctxIds)];
        if (uniqueIds.length === 0) return;
        const hiddenContexts = { ...conversationPreferences.hiddenContexts };
        const patch: Record<string, true | null> = {};
        for (const ctxId of uniqueIds) {
            if (hidden) hiddenContexts[ctxId] = true;
            else delete hiddenContexts[ctxId];
            patch[ctxId] = hidden ? true : null;
        }
        persistPreferences(
            { ...conversationPreferences, hiddenContexts },
            { hiddenContexts: patch },
        );
        if (
            hidden &&
            route.view === "thread" &&
            uniqueIds.includes(route.ctxId)
        ) {
            navigate({ page: "messages", view: "contexts" });
        }
    }

    function projectContextIds(workspaceKey: string): string[] {
        const group = allGroups.find(
            (candidate) => candidate.key === workspaceKey,
        );
        return [
            ...new Set((group?.sessions ?? []).map((session) => session.ctxId)),
        ];
    }

    function renderSession(session: WebMessageSession) {
        const active =
            route.view === "thread" &&
            route.instance === session.instance &&
            route.ctxId === session.ctxId;
        const key = conversationKey(session);
        const editing = editingConversationKey === key;
        return (
            <div
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
                        if (
                            editing ||
                            !preferencesAvailable ||
                            event.button !== 0
                        )
                            return;
                        draggingConversationKeyRef.current = key;
                        setDraggingConversationKey(key);
                        if (
                            typeof event.currentTarget.setPointerCapture ===
                            "function"
                        ) {
                            event.currentTarget.setPointerCapture(
                                event.pointerId,
                            );
                        }
                        event.preventDefault();
                    }}
                    onPointerUp={(event) =>
                        finishConversationDrag(event.clientX, event.clientY)
                    }
                    title="Drag to reorder"
                >
                    ⋮⋮
                </span>
                {editing ? (
                    <div className="conversation-rename-editor">
                        <label>
                            <span className="sr-only">Conversation title</span>
                            <input
                                aria-label="Conversation title"
                                autoFocus
                                maxLength={120}
                                onChange={(event) =>
                                    setEditingTitle(event.target.value)
                                }
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
                            <button
                                aria-label="Save title"
                                onClick={() => saveConversationTitle(session)}
                                type="button"
                            >
                                Save
                            </button>
                            <button
                                aria-label="Cancel rename"
                                onClick={() => {
                                    setEditingConversationKey(undefined);
                                    setEditingTitle("");
                                }}
                                type="button"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        <button
                            aria-current={active ? "page" : undefined}
                            className="conversation-open"
                            onClick={() => {
                                onClose();
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
                            <span>
                                {session.instance} ·{" "}
                                {sessionScope === "current"
                                    ? activeConversationKeys.has(key)
                                        ? "active"
                                        : "idle"
                                    : sessionScope === "hidden"
                                      ? "hidden"
                                      : (session.status ?? "history")}
                            </span>
                            <time dateTime={session.latestAt}>
                                {formatConversationDate(session.latestAt)}
                            </time>
                        </button>
                        <button
                            aria-label={
                                sessionScope === "hidden"
                                    ? "Restore conversation"
                                    : "Hide conversation"
                            }
                            className="conversation-visibility-action"
                            disabled={!preferencesAvailable}
                            onClick={() =>
                                setContextsHidden(
                                    [session.ctxId],
                                    sessionScope !== "hidden",
                                )
                            }
                            title={
                                sessionScope === "hidden"
                                    ? `Restore ${session.title}`
                                    : `Hide ${session.title}`
                            }
                            type="button"
                        >
                            {sessionScope === "hidden" ? "↩" : "×"}
                        </button>
                    </>
                )}
            </div>
        );
    }

    return (
        <>
            <button
                aria-label="Close conversations"
                className={`messages-backdrop${open ? " open" : ""}`}
                onClick={onClose}
                tabIndex={open ? 0 : -1}
                type="button"
            />
            <div
                className={`messages-sidebar${open ? " open" : ""}`}
                ref={sidebarRef}
            >
                <div className="messages-sidebar-heading">
                    <strong>Conversations</strong>
                    <div
                        aria-label="Conversation scope"
                        className="messages-session-scope"
                        role="group"
                    >
                        <button
                            aria-pressed={sessionScope === "current"}
                            onClick={() => setSessionScope("current")}
                            type="button"
                        >
                            Current
                        </button>
                        <button
                            aria-pressed={sessionScope === "history"}
                            onClick={() => setSessionScope("history")}
                            type="button"
                        >
                            History
                        </button>
                        <button
                            aria-pressed={sessionScope === "hidden"}
                            onClick={() => setSessionScope("hidden")}
                            type="button"
                        >
                            Hidden
                        </button>
                    </div>
                    <button
                        aria-label="Close conversations"
                        className="messages-sidebar-close"
                        onClick={onClose}
                        type="button"
                    >
                        ×
                    </button>
                </div>
                {sessionScope === "current" && idleCurrentCount > 0 ? (
                    <button
                        className="messages-archive-idle"
                        onClick={archiveIdle}
                        type="button"
                    >
                        Archive idle
                    </button>
                ) : null}
                {preferenceError === undefined ? null : (
                    <p className="messages-preference-error error" role="alert">
                        Conversation preferences are not being persisted:{" "}
                        {preferenceError}
                    </p>
                )}
                <label className="messages-search">
                    <span className="sr-only">Search conversations</span>
                    <input
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search conversations"
                        ref={searchRef}
                        type="search"
                        value={query}
                    />
                </label>
                <nav aria-label="Conversations" className="conversation-list">
                    {visibleSessions.length === 0 ? (
                        <p className="empty">No conversations found.</p>
                    ) : (
                        visibleGroups.map((group) => {
                            const containsSelected =
                                route.view === "thread" &&
                                group.sessions.some(
                                    (session) =>
                                        session.instance === route.instance &&
                                        session.ctxId === route.ctxId,
                                );
                            const expanded =
                                sessionScope !== "history" ||
                                query.trim().length > 0 ||
                                containsSelected ||
                                expandedHistoryGroups.has(group.key);
                            return (
                                <section
                                    aria-label={group.label}
                                    className="conversation-workspace-group"
                                    key={group.key}
                                    role="group"
                                >
                                    <div className="conversation-workspace-header">
                                        <button
                                            aria-expanded={expanded}
                                            className="conversation-workspace-heading"
                                            onClick={() =>
                                                setExpandedHistoryGroups(
                                                    (current) => {
                                                        const next = new Set(
                                                            current,
                                                        );
                                                        if (next.has(group.key))
                                                            next.delete(
                                                                group.key,
                                                            );
                                                        else
                                                            next.add(group.key);
                                                        return next;
                                                    },
                                                )
                                            }
                                            title={group.workspace}
                                            type="button"
                                        >
                                            <span>
                                                {expanded ? "▾" : "▸"}{" "}
                                                {group.label}
                                            </span>
                                            <span>{group.sessions.length}</span>
                                        </button>
                                        <button
                                            aria-label={
                                                sessionScope === "hidden"
                                                    ? "Restore project"
                                                    : "Hide project"
                                            }
                                            className="conversation-workspace-action"
                                            disabled={!preferencesAvailable}
                                            onClick={() =>
                                                setContextsHidden(
                                                    sessionScope === "hidden"
                                                        ? group.sessions.map(
                                                              (session) =>
                                                                  session.ctxId,
                                                          )
                                                        : projectContextIds(
                                                              group.key,
                                                          ),
                                                    sessionScope !== "hidden",
                                                )
                                            }
                                            title={
                                                sessionScope === "hidden"
                                                    ? `Restore ${group.label} conversations`
                                                    : `Hide ${group.label} conversations`
                                            }
                                            type="button"
                                        >
                                            {sessionScope === "hidden"
                                                ? "Restore"
                                                : "Hide"}
                                        </button>
                                    </div>
                                    {expanded ? (
                                        <div className="conversation-workspace-sessions">
                                            {group.sessions.map(renderSession)}
                                        </div>
                                    ) : null}
                                </section>
                            );
                        })
                    )}
                </nav>
            </div>
        </>
    );
}

function formatConversationDate(value: string, now = new Date()): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const sameYear = date.getFullYear() === now.getFullYear();
    const sameDay =
        sameYear &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();
    return new Intl.DateTimeFormat(undefined, {
        ...(sameDay
            ? {}
            : {
                  day: "numeric",
                  month: "short",
                  ...(sameYear ? {} : { year: "numeric" as const }),
              }),
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
}
