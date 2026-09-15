import { useEffect, useMemo, useRef, useState } from "react";
import {
    createEmptyConversationPreferences,
    type ConversationPreferencesPatch,
    type ConversationPreferencesSnapshot,
} from "@portable-devshell/shared/browser";

import { webRouteHref, type WebRoute } from "../../../../app/Route.js";
import type { WebState } from "../../../../state/Model.js";
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
} from "./Model.js";

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
    const [conversationPreferences, setConversationPreferences] =
        useState<ConversationPreferencesSnapshot>(
            () =>
                state.conversationPreferences ??
                createEmptyConversationPreferences(),
        );
    const [legacyConversationPreferences] = useState<
        LegacyConversationPreferences | undefined
    >(() => readLegacyConversationPreferences());
    const [legacyMigrationPending, setLegacyMigrationPending] = useState(
        () => legacyConversationPreferences !== undefined,
    );
    const [currentConversationKeys, setCurrentConversationKeys] = useState<
        Set<string>
    >(() => new Set(selectWebMessageSessions(state).map(conversationKey)));
    const drawerTriggerRef = useRef<HTMLButtonElement>(null);
    const legacyMigrationStartedRef = useRef(false);
    const preferenceMutationVersionRef = useRef(0);
    const pendingPreferenceMutationsRef = useRef(0);
    const preferenceOrderSyncRef = useRef(false);

    const activeSessions = useMemo(
        () => selectWebMessageSessions(state),
        [state],
    );
    const inactiveSessions = useMemo(
        () => selectWebMessageHistorySessions(state),
        [state],
    );
    const allBaseSessions = useMemo(
        () => [...activeSessions, ...inactiveSessions],
        [activeSessions, inactiveSessions],
    );
    const selectedBase =
        route.view === "thread"
            ? selectWebMessageSession(state, route.instance, route.ctxId)
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
            ? selectWebMessageEntries(state, route.instance, route.ctxId)
            : [];
    const threadKey =
        route.view === "thread"
            ? `${route.instance}\u0000${route.ctxId}`
            : undefined;

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
            state.conversationPreferences === undefined ||
            pendingPreferenceMutationsRef.current > 0
        )
            return;
        setConversationPreferences(state.conversationPreferences);
    }, [state.conversationPreferences]);

    useEffect(() => {
        if (
            !legacyMigrationPending ||
            legacyConversationPreferences === undefined ||
            state.conversationPreferences === undefined ||
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
                if (succeeded) {
                    removeLegacyConversationPreferences();
                    setConversationPreferences(
                        store.state?.conversationPreferences ?? imported,
                    );
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
        state.conversationPreferences,
    ]);

    useEffect(() => {
        setDrawerOpen(false);
    }, [route]);

    function persistConversationPreferences(
        next: ConversationPreferencesSnapshot,
        patch: ConversationPreferencesPatch,
        settled?: () => void,
    ): void {
        const mutationVersion = ++preferenceMutationVersionRef.current;
        pendingPreferenceMutationsRef.current += 1;
        setConversationPreferences(next);
        void store.updateConversationPreferences(patch).then((succeeded) => {
            pendingPreferenceMutationsRef.current = Math.max(
                0,
                pendingPreferenceMutationsRef.current - 1,
            );
            if (mutationVersion === preferenceMutationVersionRef.current) {
                if (succeeded) {
                    setConversationPreferences(
                        store.state?.conversationPreferences ?? next,
                    );
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
                preferenceError={state.conversationPreferencesError}
                preferencesAvailable={
                    state.conversationPreferences !== undefined
                }
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
                            state={state}
                            store={store}
                            title={selected?.title ?? route.ctxId}
                        />
                    </>
                )}
            </div>
        </section>
    );
}
