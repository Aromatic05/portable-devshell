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
    MessagePreferencesPatch,
    MessagePreferencesSnapshot,
} from "@portable-devshell/shared";

import type { WebRoute } from "../../../../../app/Route.js";
import {
    applyMessagePreferences,
    messageKey,
    filterWebMessageSessions,
    groupMessageSessionsByWorkspace,
    isMessageHidden,
    reorderMessageKeys,
    workspacePreferenceKey,
    type WebMessageSession,
} from "../Model.js";

export function MessageSidebar({
    activeSessions,
    allBaseSessions,
    messagePreferences,
    currentMessageKeys,
    navigate,
    onClose,
    persistPreferences,
    preferenceError,
    preferencesAvailable,
    route,
    setCurrentMessageKeys,
    threadKey,
    triggerRef,
    open,
}: {
    activeSessions: readonly WebMessageSession[];
    allBaseSessions: readonly WebMessageSession[];
    messagePreferences: MessagePreferencesSnapshot;
    currentMessageKeys: Set<string>;
    navigate(route: WebRoute): void;
    onClose(): void;
    persistPreferences(
        next: MessagePreferencesSnapshot,
        patch: MessagePreferencesPatch,
    ): void;
    preferenceError?: string;
    preferencesAvailable: boolean;
    route: Extract<WebRoute, { page: "messages" }>;
    setCurrentMessageKeys: Dispatch<SetStateAction<Set<string>>>;
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
    const [editingMessageKey, setEditingMessageKey] =
        useState<string>();
    const [editingTitle, setEditingTitle] = useState("");
    const [openMenuKey, setOpenMenuKey] = useState<string>();
    const [draggingMessageKey, setDraggingMessageKey] =
        useState<string>();
    const draggingMessageKeyRef = useRef<string>();
    const openMenuKeyRef = useRef<string>();
    const rowMenuRef = useRef<HTMLDivElement>(null);
    const lastMenuTriggerRef = useRef<HTMLButtonElement>();
    const searchRef = useRef<HTMLInputElement>(null);
    const sidebarRef = useRef<HTMLDivElement>(null);

    const currentSessions = useMemo(
        () =>
            allBaseSessions.filter(
                (session) =>
                    !isMessageHidden(messagePreferences, session) &&
                    currentMessageKeys.has(messageKey(session)),
            ),
        [allBaseSessions, messagePreferences, currentMessageKeys],
    );
    const historySessions = useMemo(
        () =>
            allBaseSessions.filter(
                (session) =>
                    !isMessageHidden(messagePreferences, session) &&
                    !currentMessageKeys.has(messageKey(session)),
            ),
        [allBaseSessions, messagePreferences, currentMessageKeys],
    );
    const hiddenSessions = useMemo(
        () =>
            allBaseSessions.filter((session) =>
                isMessageHidden(messagePreferences, session),
            ),
        [allBaseSessions, messagePreferences],
    );
    const sessions = useMemo(
        () =>
            applyMessagePreferences(
                sessionScope === "current"
                    ? currentSessions
                    : sessionScope === "history"
                      ? historySessions
                      : hiddenSessions,
                messagePreferences,
            ),
        [
            messagePreferences,
            currentSessions,
            hiddenSessions,
            historySessions,
            sessionScope,
        ],
    );
    const allSessions = useMemo(
        () =>
            applyMessagePreferences(
                allBaseSessions,
                messagePreferences,
            ),
        [allBaseSessions, messagePreferences],
    );
    const activeMessageKeys = useMemo(
        () => new Set(activeSessions.map(messageKey)),
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
            !activeMessageKeys.has(messageKey(session)) &&
            messageKey(session) !== threadKey,
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
                if (openMenuKeyRef.current !== undefined) return;
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
            const active = document.activeElement;
            if (
                active === document.body ||
                (active instanceof Node &&
                    sidebarRef.current?.contains(active) === true)
            ) {
                (triggerRef.current ?? previous)?.focus();
            }
        };
    }, [onClose, open, triggerRef]);

    useEffect(() => {
        if (openMenuKey === undefined) return;
        const pointerDown = (event: PointerEvent) => {
            if (
                event.target instanceof Node &&
                rowMenuRef.current?.contains(event.target) !== true
            ) {
                closeRowMenu();
            }
        };
        const keyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") closeRowMenu(true);
        };
        document.addEventListener("pointerdown", pointerDown);
        document.addEventListener("keydown", keyDown);
        return () => {
            document.removeEventListener("pointerdown", pointerDown);
            document.removeEventListener("keydown", keyDown);
        };
    }, [openMenuKey]);

    function toggleRowMenu(key: string, trigger: HTMLButtonElement): void {
        const next = openMenuKey === key ? undefined : key;
        openMenuKeyRef.current = next;
        if (next !== undefined) lastMenuTriggerRef.current = trigger;
        setOpenMenuKey(next);
    }

    function closeRowMenu(refocus = false): void {
        openMenuKeyRef.current = undefined;
        setOpenMenuKey(undefined);
        if (refocus) {
            queueMicrotask(() => lastMenuTriggerRef.current?.focus());
        }
    }

    function saveMessageTitle(session: WebMessageSession): void {
        const key = messageKey(session);
        const nextTitle = editingTitle.trim();
        const titles = { ...messagePreferences.titles };
        if (nextTitle.length === 0) delete titles[key];
        else titles[key] = nextTitle;
        persistPreferences(
            { ...messagePreferences, titles },
            { titles: { [key]: nextTitle.length === 0 ? null : nextTitle } },
        );
        setEditingMessageKey(undefined);
        setEditingTitle("");
    }

    function moveMessage(sourceKey: string, targetKey: string): void {
        if (sourceKey === targetKey || !preferencesAvailable) return;
        const source = allSessions.find(
            (session) => messageKey(session) === sourceKey,
        );
        const target = allSessions.find(
            (session) => messageKey(session) === targetKey,
        );
        if (
            source === undefined ||
            target === undefined ||
            workspacePreferenceKey(source) !== workspacePreferenceKey(target)
        )
            return;
        const workspace = workspacePreferenceKey(source);
        const order = reorderMessageKeys(
            allSessions.filter(
                (session) => workspacePreferenceKey(session) === workspace,
            ),
            sourceKey,
            targetKey,
            messagePreferences.orderByWorkspace[workspace] ?? [],
        );
        persistPreferences(
            {
                ...messagePreferences,
                orderByWorkspace: {
                    ...messagePreferences.orderByWorkspace,
                    [workspace]: order,
                },
            },
            { orderByWorkspace: { [workspace]: order } },
        );
    }

    function moveMessageBy(
        session: WebMessageSession,
        direction: -1 | 1,
    ): void {
        if (!preferencesAvailable) return;
        const workspace = workspacePreferenceKey(session);
        const group = allSessions.filter(
            (candidate) => workspacePreferenceKey(candidate) === workspace,
        );
        const index = group.findIndex(
            (candidate) =>
                messageKey(candidate) === messageKey(session),
        );
        const target = group[index + direction];
        if (target === undefined) return;
        moveMessage(messageKey(session), messageKey(target));
    }

    function finishMessageDrag(clientX: number, clientY: number): void {
        const sourceKey = draggingMessageKeyRef.current;
        draggingMessageKeyRef.current = undefined;
        setDraggingMessageKey(undefined);
        if (sourceKey === undefined) return;
        const target = document
            .elementFromPoint(clientX, clientY)
            ?.closest<HTMLElement>(".message-row");
        const targetKey = target?.dataset.messageKey;
        if (targetKey !== undefined) moveMessage(sourceKey, targetKey);
    }

    function archiveIdle(): void {
        setCurrentMessageKeys(
            (current) =>
                new Set(
                    [...current].filter(
                        (key) =>
                            activeMessageKeys.has(key) ||
                            key === threadKey,
                    ),
                ),
        );
    }

    function setContextsHidden(
        ctxIds: readonly string[],
        hidden: boolean,
    ): void {
        closeRowMenu();
        if (!preferencesAvailable) return;
        const uniqueIds = [...new Set(ctxIds)];
        if (uniqueIds.length === 0) return;
        const hiddenContexts = { ...messagePreferences.hiddenContexts };
        const patch: Record<string, true | null> = {};
        for (const ctxId of uniqueIds) {
            if (hidden) hiddenContexts[ctxId] = true;
            else delete hiddenContexts[ctxId];
            patch[ctxId] = hidden ? true : null;
        }
        persistPreferences(
            { ...messagePreferences, hiddenContexts },
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
        const key = messageKey(session);
        const editing = editingMessageKey === key;
        const menuOpen = openMenuKey === key;
        const group = allSessions.filter(
            (candidate) =>
                workspacePreferenceKey(candidate) ===
                workspacePreferenceKey(session),
        );
        const groupIndex = group.findIndex(
            (candidate) => messageKey(candidate) === key,
        );
        const canMoveUp = preferencesAvailable && groupIndex > 0;
        const canMoveDown =
            preferencesAvailable &&
            groupIndex !== -1 &&
            groupIndex < group.length - 1;
        return (
            <div
                className={`message-row${active ? " selected" : ""}${draggingMessageKey === key ? " dragging" : ""}`}
                data-message-key={key}
                key={key}
                ref={menuOpen ? rowMenuRef : undefined}
            >
                <span
                    aria-hidden="true"
                    className="message-drag-handle"
                    onPointerCancel={() => {
                        draggingMessageKeyRef.current = undefined;
                        setDraggingMessageKey(undefined);
                    }}
                    onPointerDown={(event) => {
                        if (
                            editing ||
                            !preferencesAvailable ||
                            event.button !== 0
                        )
                            return;
                        draggingMessageKeyRef.current = key;
                        setDraggingMessageKey(key);
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
                        finishMessageDrag(event.clientX, event.clientY)
                    }
                    title="Drag to reorder"
                >
                    ⋮⋮
                </span>
                {editing ? (
                    <div className="message-rename-editor">
                        <label>
                            <span className="sr-only">Message title</span>
                            <input
                                aria-label="Message title"
                                autoFocus
                                maxLength={120}
                                onChange={(event) =>
                                    setEditingTitle(event.target.value)
                                }
                                onKeyDown={(event) => {
                                    if (event.key === "Escape") {
                                        setEditingMessageKey(undefined);
                                        setEditingTitle("");
                                    } else if (event.key === "Enter") {
                                        event.preventDefault();
                                        saveMessageTitle(session);
                                    }
                                }}
                                value={editingTitle}
                            />
                        </label>
                        <div className="message-rename-actions">
                            <button
                                aria-label="Save title"
                                onClick={() => saveMessageTitle(session)}
                                type="button"
                            >
                                Save
                            </button>
                            <button
                                aria-label="Cancel rename"
                                onClick={() => {
                                    setEditingMessageKey(undefined);
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
                            className="message-open"
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
                                setEditingMessageKey(key);
                                setEditingTitle(session.title);
                            }}
                            type="button"
                        >
                            <strong>{session.title}</strong>
                            <span>
                                {session.instance} ·{" "}
                                {sessionScope === "current"
                                    ? activeMessageKeys.has(key)
                                        ? "active"
                                        : "idle"
                                    : sessionScope === "hidden"
                                      ? "hidden"
                                      : (session.status ?? "history")}
                            </span>
                            <time dateTime={session.latestAt}>
                                {formatMessageDate(session.latestAt)}
                            </time>
                        </button>
                        <div className="message-row-actions">
                            <button
                                aria-label={
                                    sessionScope === "hidden"
                                        ? "Restore message"
                                        : "Hide message"
                                }
                                className="message-visibility-action"
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
                                {sessionScope === "hidden" ? "Restore" : "Hide"}
                            </button>
                            <button
                                aria-expanded={menuOpen}
                                aria-label="Message actions"
                                className="message-menu-trigger"
                                onClick={(event) =>
                                    toggleRowMenu(key, event.currentTarget)
                                }
                                title="Message actions"
                                type="button"
                            >
                                ⋯
                            </button>
                        </div>
                        {menuOpen ? (
                            <div
                                aria-label={`Actions for ${session.title}`}
                                className="message-row-menu"
                            >
                                <button
                                    onClick={() => {
                                        closeRowMenu();
                                        setEditingMessageKey(key);
                                        setEditingTitle(session.title);
                                    }}
                                    type="button"
                                >
                                    Rename
                                </button>
                                <button
                                    disabled={!canMoveUp}
                                    onClick={() => {
                                        closeRowMenu();
                                        moveMessageBy(session, -1);
                                    }}
                                    type="button"
                                >
                                    Move up
                                </button>
                                <button
                                    disabled={!canMoveDown}
                                    onClick={() => {
                                        closeRowMenu();
                                        moveMessageBy(session, 1);
                                    }}
                                    type="button"
                                >
                                    Move down
                                </button>
                                <button
                                    disabled={!preferencesAvailable}
                                    onClick={() =>
                                        setContextsHidden(
                                            [session.ctxId],
                                            sessionScope !== "hidden",
                                        )
                                    }
                                    type="button"
                                >
                                    {sessionScope === "hidden"
                                        ? "Restore"
                                        : "Hide"}
                                </button>
                            </div>
                        ) : null}
                    </>
                )}
            </div>
        );
    }

    return (
        <>
            <button
                aria-label="Close messages"
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
                    <strong>Messages</strong>
                    <div
                        aria-label="Message scope"
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
                        aria-label="Close messages"
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
                        Clear idle from Current
                    </button>
                ) : null}
                {preferenceError === undefined ? null : (
                    <p className="messages-preference-error error" role="alert">
                        Message preferences are not being persisted:{" "}
                        {preferenceError}
                    </p>
                )}
                <label className="messages-search">
                    <span className="sr-only">Search messages</span>
                    <input
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search messages"
                        ref={searchRef}
                        type="search"
                        value={query}
                    />
                </label>
                <nav aria-label="Messages" className="message-list">
                    {visibleSessions.length === 0 ? (
                        <p className="empty">No messages found.</p>
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
                                    className="message-workspace-group"
                                    key={group.key}
                                    role="group"
                                >
                                    <div className="message-workspace-header">
                                        <button
                                            aria-expanded={expanded}
                                            className="message-workspace-heading"
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
                                            className="message-workspace-action"
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
                                                    ? `Restore ${group.label} messages`
                                                    : `Hide ${group.label} messages`
                                            }
                                            type="button"
                                        >
                                            {sessionScope === "hidden"
                                                ? "Restore"
                                                : "Hide"}
                                        </button>
                                    </div>
                                    {expanded ? (
                                        <div className="message-workspace-sessions">
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

function formatMessageDate(value: string, now = new Date()): string {
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
