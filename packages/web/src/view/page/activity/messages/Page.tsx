import { useEffect, useMemo, useRef, useState } from "react";
import type {
    MessagePreferencesPatch,
    MessagePreferencesSnapshot,
} from "@portable-devshell/shared";

import { webRouteHref, type WebRoute } from "../../../../app/Route.js";
import {
    useDomainSnapshot,
    useWebDomains,
} from "../../../../app/domain/Context.js";
import type { WebStore } from "../../../../state/Store.js";
import { MessageComposer } from "./message/Composer.js";
import { MessageHistory } from "./message/History.js";
import { MessageSidebar } from "./message/Sidebar.js";
import {
    applyMessagePreferences,
    messageKey,
    messageOrderPatch,
    ensureMessagePreferenceOrder,
    readLegacyMessagePreferences,
    removeLegacyMessagePreferences,
    selectWebMessageEntries,
    selectWebMessageHistorySessions,
    selectWebMessageSession,
    selectWebMessageSessions,
    type LegacyMessagePreferences,
    type WebMessageProjection,
} from "./Model.js";

const messageActivityRefreshIntervalMs = 20_000;

export function Messages({
    navigate,
    route,
    store,
}: {
    navigate(route: WebRoute): void;
    route: Extract<WebRoute, { page: "messages" }>;
    store: WebStore;
}) {
    const domains = useWebDomains();
    const service = useDomainSnapshot(domains.service);
    const instancesState = useDomainSnapshot(domains.instances);
    const contextState = useDomainSnapshot(domains.context);
    const messageHistoryState = useDomainSnapshot(domains.messageHistory);
    const messagePreferenceState = useDomainSnapshot(
        domains.messagePreferences,
    );
    const messageState = useDomainSnapshot(domains.messages);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [clockNow, setClockNow] = useState(() => Date.now());
    const [preferencesReady, setPreferencesReady] = useState(false);
    const [legacyMessagePreferences] = useState<
        LegacyMessagePreferences | undefined
    >(() => readLegacyMessagePreferences());
    const [legacyMigrationPending, setLegacyMigrationPending] = useState(
        () => legacyMessagePreferences !== undefined,
    );
    const [currentMessageKeys, setCurrentMessageKeys] = useState<
        Set<string>
    >(() => new Set());
    const drawerTriggerRef = useRef<HTMLButtonElement>(null);
    const legacyMigrationStartedRef = useRef(false);
    const preferenceOrderSyncRef = useRef(false);

    const projection = useMemo<WebMessageProjection>(
        () => ({
            contexts: contextState.contexts,
            message: messageHistoryState,
            instances: instancesState.instances,
            messages: messageState,
        }),
        [contextState, messageHistoryState, instancesState, messageState],
    );
    const messagePreferences = messagePreferenceState.preferences;
    const preferenceFailure = messagePreferenceState.failure;
    const preferencesLoaded =
        preferencesReady && preferenceFailure === undefined;
    const activeSessions = useMemo(
        () => selectWebMessageSessions(projection, clockNow),
        [clockNow, projection],
    );
    const inactiveSessions = useMemo(
        () => selectWebMessageHistorySessions(projection, clockNow),
        [clockNow, projection],
    );
    const allBaseSessions = useMemo(
        () => [...activeSessions, ...inactiveSessions],
        [activeSessions, inactiveSessions],
    );
    const selectedBase =
        route.view === "thread"
            ? selectWebMessageSession(projection, route.instance, route.ctxId)
            : undefined;
    const selected =
        selectedBase === undefined
            ? undefined
            : applyMessagePreferences(
                  [selectedBase],
                  messagePreferences,
              )[0];
    const entries =
        route.view === "thread"
            ? selectWebMessageEntries(projection, route.instance, route.ctxId)
            : [];
    const threadKey =
        route.view === "thread"
            ? `${route.instance}\u0000${route.ctxId}`
            : undefined;

    useEffect(() => {
        if (service.status !== "online") return;
        let cancelled = false;
        void store.refreshMessages().finally(() => {
            if (!cancelled) setPreferencesReady(true);
        });
        return () => {
            cancelled = true;
        };
    }, [service.status, store]);

    useEffect(() => {
        let refreshPending = false;
        const refreshActivity = () => {
            if (document.visibilityState === "hidden") return;
            setClockNow(Date.now());
            if (refreshPending) return;
            refreshPending = true;
            void domains.context.refresh().finally(() => {
                refreshPending = false;
            });
        };
        const timer = window.setInterval(
            refreshActivity,
            messageActivityRefreshIntervalMs,
        );
        const visibilityChanged = () => {
            if (document.visibilityState !== "hidden") refreshActivity();
        };
        document.addEventListener("visibilitychange", visibilityChanged);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", visibilityChanged);
        };
    }, [domains]);

    useEffect(() => {
        setCurrentMessageKeys((current) => {
            const next = new Set(current);
            let changed = false;
            for (const session of activeSessions) {
                const key = messageKey(session);
                if (!next.has(key)) {
                    next.add(key);
                    changed = true;
                }
            }
            return changed ? next : current;
        });
    }, [activeSessions]);

    useEffect(() => {
        if (
            !legacyMigrationPending ||
            legacyMessagePreferences === undefined ||
            !preferencesLoaded ||
            legacyMigrationStartedRef.current
        )
            return;
        legacyMigrationStartedRef.current = true;
        const imported = ensureMessagePreferenceOrder(
            legacyMessagePreferences.preferences,
            allBaseSessions,
            legacyMessagePreferences.legacyOrder,
        );
        void store
            .updateMessagePreferences({
                ifMissing: true,
                orderByWorkspace: imported.orderByWorkspace,
                titles: imported.titles,
                workspaceOrder: imported.workspaceOrder,
            })
            .then((succeeded) => {
                if (succeeded) removeLegacyMessagePreferences();
                setLegacyMigrationPending(false);
            });
    }, [
        allBaseSessions,
        legacyMessagePreferences,
        legacyMigrationPending,
        preferencesLoaded,
        store,
    ]);

    useEffect(() => {
        if (
            !preferencesLoaded ||
            legacyMigrationPending ||
            preferenceOrderSyncRef.current
        )
            return;
        const next = ensureMessagePreferenceOrder(
            messagePreferences,
            allBaseSessions,
        );
        if (next === messagePreferences) return;
        const patch = messageOrderPatch(messagePreferences, next);
        if (patch === undefined) return;
        preferenceOrderSyncRef.current = true;
        persistMessagePreferences(
            next,
            { ...patch, ifMissing: true },
            () => {
                preferenceOrderSyncRef.current = false;
            },
        );
    }, [
        allBaseSessions,
        messagePreferences,
        legacyMigrationPending,
        preferencesLoaded,
    ]);

    useEffect(() => {
        setDrawerOpen(false);
    }, [route]);

    function persistMessagePreferences(
        _next: MessagePreferencesSnapshot,
        patch: MessagePreferencesPatch,
        settled?: () => void,
    ): void {
        void store.updateMessagePreferences(patch).finally(() => {
            settled?.();
        });
    }

    return (
        <section className="messages-page">
            <MessageSidebar
                activeSessions={activeSessions}
                allBaseSessions={allBaseSessions}
                messagePreferences={messagePreferences}
                currentMessageKeys={currentMessageKeys}
                navigate={navigate}
                onClose={() => setDrawerOpen(false)}
                open={drawerOpen}
                persistPreferences={persistMessagePreferences}
                preferenceError={preferenceFailure?.message}
                preferencesAvailable={preferencesLoaded}
                route={route}
                setCurrentMessageKeys={setCurrentMessageKeys}
                threadKey={threadKey}
                triggerRef={drawerTriggerRef}
            />
            <div className="messages-content">
                <header className="messages-thread-heading">
                    <button
                        aria-label="Open messages"
                        className="messages-drawer-toggle"
                        onClick={() => setDrawerOpen(true)}
                        ref={drawerTriggerRef}
                        type="button"
                    >
                        <span aria-hidden="true" className="two-line-menu">
                            <i />
                            <i />
                        </span>
                    </button>
                    <div>
                        <h2>
                            {selected?.title ??
                                (route.view === "thread"
                                    ? route.ctxId
                                    : "Messages")}
                        </h2>
                        {route.view === "thread" ? (
                            <p>
                                {route.instance} · {route.ctxId}
                            </p>
                        ) : null}
                    </div>
                    {route.view === "thread" ? (
                        <a
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
                        >
                            Open in Audit
                        </a>
                    ) : null}
                </header>
                {route.view === "contexts" ? (
                    <div className="messages-placeholder">
                        <h3>Messages</h3>
                        <p className="empty">
                            Choose a message to read its Comment and Report
                            history.
                        </p>
                    </div>
                ) : (
                    <>
                        <MessageHistory
                            entries={entries}
                            threadKey={threadKey!}
                        />
                        <MessageComposer
                            entries={entries}
                            key={threadKey}
                            onActivity={() => setDrawerOpen(false)}
                            route={route}
                            store={store}
                            title={selected?.title ?? route.ctxId}
                        />
                    </>
                )}
            </div>
        </section>
    );
}
