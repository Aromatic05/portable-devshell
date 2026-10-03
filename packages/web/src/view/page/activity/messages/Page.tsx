import { useEffect, useMemo, useRef, useState } from "react";
import type {
    ConversationPreferencesPatch,
    ConversationPreferencesSnapshot,
} from "@portable-devshell/shared";

import { webRouteHref, type WebRoute } from "../../../../app/Route.js";
import {
    useDomainSnapshot,
    useWebDomains,
} from "../../../../app/domain/Context.js";
import type { WebStore } from "../../../../state/Store.js";
import { ConversationComposer } from "./conversation/Composer.js";
import { ConversationHistory } from "./conversation/History.js";
import { ConversationSidebar } from "./conversation/Sidebar.js";
import {
    applyConversationPreferences,
    conversationKey,
    conversationOrderPatch,
    ensureConversationPreferenceOrder,
    readLegacyConversationPreferences,
    removeLegacyConversationPreferences,
    selectWebMessageEntries,
    selectWebMessageHistorySessions,
    selectWebMessageSession,
    selectWebMessageSessions,
    type LegacyConversationPreferences,
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
    const conversationState = useDomainSnapshot(domains.conversation);
    const conversationPreferenceState = useDomainSnapshot(
        domains.conversationPreferences,
    );
    const messageState = useDomainSnapshot(domains.messages);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [clockNow, setClockNow] = useState(() => Date.now());
    const [preferencesReady, setPreferencesReady] = useState(false);
    const [legacyConversationPreferences] = useState<
        LegacyConversationPreferences | undefined
    >(() => readLegacyConversationPreferences());
    const [legacyMigrationPending, setLegacyMigrationPending] = useState(
        () => legacyConversationPreferences !== undefined,
    );
    const [currentConversationKeys, setCurrentConversationKeys] = useState<
        Set<string>
    >(() => new Set());
    const drawerTriggerRef = useRef<HTMLButtonElement>(null);
    const legacyMigrationStartedRef = useRef(false);
    const preferenceOrderSyncRef = useRef(false);

    const projection = useMemo<WebMessageProjection>(
        () => ({
            contexts: contextState.contexts,
            conversation: conversationState,
            instances: instancesState.instances,
            messages: messageState,
        }),
        [contextState, conversationState, instancesState, messageState],
    );
    const conversationPreferences = conversationPreferenceState.preferences;
    const preferenceFailure = conversationPreferenceState.failure;
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
            : applyConversationPreferences(
                  [selectedBase],
                  conversationPreferences,
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
        if (
            !legacyMigrationPending ||
            legacyConversationPreferences === undefined ||
            !preferencesLoaded ||
            legacyMigrationStartedRef.current
        )
            return;
        legacyMigrationStartedRef.current = true;
        const imported = ensureConversationPreferenceOrder(
            legacyConversationPreferences.preferences,
            allBaseSessions,
            legacyConversationPreferences.legacyOrder,
        );
        void store
            .updateConversationPreferences({
                ifMissing: true,
                orderByWorkspace: imported.orderByWorkspace,
                titles: imported.titles,
                workspaceOrder: imported.workspaceOrder,
            })
            .then((succeeded) => {
                if (succeeded) removeLegacyConversationPreferences();
                setLegacyMigrationPending(false);
            });
    }, [
        allBaseSessions,
        legacyConversationPreferences,
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
        const next = ensureConversationPreferenceOrder(
            conversationPreferences,
            allBaseSessions,
        );
        if (next === conversationPreferences) return;
        const patch = conversationOrderPatch(conversationPreferences, next);
        if (patch === undefined) return;
        preferenceOrderSyncRef.current = true;
        persistConversationPreferences(
            next,
            { ...patch, ifMissing: true },
            () => {
                preferenceOrderSyncRef.current = false;
            },
        );
    }, [
        allBaseSessions,
        conversationPreferences,
        legacyMigrationPending,
        preferencesLoaded,
    ]);

    useEffect(() => {
        setDrawerOpen(false);
    }, [route]);

    function persistConversationPreferences(
        _next: ConversationPreferencesSnapshot,
        patch: ConversationPreferencesPatch,
        settled?: () => void,
    ): void {
        void store.updateConversationPreferences(patch).finally(() => {
            settled?.();
        });
    }

    return (
        <section className="messages-page">
            <ConversationSidebar
                activeSessions={activeSessions}
                allBaseSessions={allBaseSessions}
                conversationPreferences={conversationPreferences}
                currentConversationKeys={currentConversationKeys}
                navigate={navigate}
                onClose={() => setDrawerOpen(false)}
                open={drawerOpen}
                persistPreferences={persistConversationPreferences}
                preferenceError={preferenceFailure?.message}
                preferencesAvailable={preferencesLoaded}
                route={route}
                setCurrentConversationKeys={setCurrentConversationKeys}
                threadKey={threadKey}
                triggerRef={drawerTriggerRef}
            />
            <div className="messages-content">
                <header className="messages-thread-heading">
                    <button
                        aria-label="Open conversations"
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
                            Choose a conversation to read its Comment and Report
                            history.
                        </p>
                    </div>
                ) : (
                    <>
                        <ConversationHistory
                            entries={entries}
                            threadKey={threadKey!}
                        />
                        <ConversationComposer
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
