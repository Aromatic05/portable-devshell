import { useEffect, useSyncExternalStore } from "react";

import { PageSwitcher } from "../view/component/Navigation.js";
import { PartialFailures } from "../view/component/Feedback.js";
import { useHashRoute, type WebRoute } from "./Route.js";
import { openTodos } from "../view/ReadModel.js";
import { selectWebMessageSession } from "../view/page/activity/messages/Model.js";
import type { WebState, WebStore } from "../state/Store.js";
import { webFailures } from "../state/Model.js";
import type { ApplicationBusy } from "./session/Hook.js";
import { Audit } from "../view/page/activity/audit/Page.js";
import { Instances } from "../view/page/Instances.js";
import { Messages } from "../view/page/activity/messages/Page.js";
import { Overview } from "../view/page/Overview.js";
import { Todos } from "../view/page/Todos.js";
import { ExtensionPage } from "../view/page/Extension.js";

export function Application({
    busy,
    error,
    store,
    onLogout,
    onReconnect,
}: {
    busy?: ApplicationBusy;
    error?: string;
    store: WebStore;
    onLogout(): Promise<void>;
    onReconnect(): Promise<void>;
}) {
    const state = useSyncExternalStore(
        store.subscribe,
        () => store.state,
        () => store.state,
    );
    const [route, navigate] = useHashRoute();
    const interactionDisabled = busy !== undefined;
    useEffect(() => {
        store.setOverviewActive(route.page === "overview");
        return () => store.setOverviewActive(false);
    }, [route.page, store]);
    useEffect(() => {
        if (state.connection !== "online") return;
        if (route.page === "audit") void store.refreshAudit();
        else if (route.page === "messages") void store.refreshMessages();
    }, [route.page, state.connection, store]);
    useEffect(() => {
        if (state.notice === undefined) return;
        const timer = setTimeout(() => store.dismissFeedback("notice"), 5_000);
        return () => clearTimeout(timer);
    }, [state.notice, store]);
    const routeContext = routeSubtitle(state, route);
    useEffect(() => {
        document.title = pageTitle(route, routeContext);
    }, [route, routeContext]);
    const overview = state.readModel.overview;
    const counts = {
        instances:
            overview === undefined
                ? 0
                : overview.counts.instancesAttention +
                  overview.counts.instancesCritical,
        todos: openTodos(state),
    };

    return (
        <div className="app">
            <header className="app-header">
                <strong className="app-name">portable-devshell</strong>
                <PageSwitcher
                    active={route}
                    applications={state.readModel.webApplications}
                    extensionPages={state.readModel.webPages}
                    counts={counts}
                    navigate={navigate}
                />
                <div className={`connection ${state.connection}`}>
                    <span>{connectionLabel(state.connection)}</span>
                    {state.connection === "online" ? null : (
                        <button
                            disabled={busy !== undefined}
                            onClick={() => void onReconnect()}
                        >
                            {busy === "reconnect"
                                ? "Reconnecting…"
                                : "Reconnect"}
                        </button>
                    )}
                </div>
                <button
                    className="header-logout"
                    disabled={busy !== undefined}
                    onClick={() => void onLogout()}
                >
                    {busy === "logout" ? "Logging out…" : "Log out"}
                </button>
            </header>
            <main className={`page page-${route.page}`}>
                <PartialFailures failures={webFailures(state.readModel)} />
                <div aria-live="polite" className="global-feedback">
                    {state.notice === undefined ? null : (
                        <div className="feedback-row notice">
                            <p>{state.notice}</p>
                            <button
                                aria-label="Dismiss notice"
                                onClick={() => store.dismissFeedback("notice")}
                                type="button"
                            >
                                ×
                            </button>
                        </div>
                    )}
                    {state.error === undefined ? null : (
                        <div className="feedback-row error" role="alert">
                            <p>{state.error}</p>
                            <button
                                aria-label="Dismiss error"
                                onClick={() => store.dismissFeedback("error")}
                                type="button"
                            >
                                ×
                            </button>
                        </div>
                    )}
                    {error === undefined ? null : (
                        <p className="error" role="alert">
                            {error}
                        </p>
                    )}
                </div>
                {route.page === "overview" ? <Overview state={state} /> : null}
                {route.page === "extension" ? (
                    <ExtensionPage
                        descriptor={state.readModel.webPages.find(
                            (page) => page.id === route.id,
                        )}
                        store={store}
                    />
                ) : null}
                {route.page === "instances" ? (
                    <Instances
                        disabled={interactionDisabled}
                        navigate={navigate}
                        route={route}
                        store={store}
                    />
                ) : null}
                {route.page === "audit" ? (
                    <Audit
                        disabled={interactionDisabled}
                        navigate={navigate}
                        route={route}
                        state={state}
                        store={store}
                    />
                ) : null}
                {route.page === "messages" ? (
                    <Messages
                        navigate={navigate}
                        route={route}
                        state={state}
                        store={store}
                    />
                ) : null}
                {route.page === "todos" ? (
                    <Todos
                        disabled={interactionDisabled}
                        state={state}
                        store={store}
                    />
                ) : null}
            </main>
        </div>
    );
}

function connectionLabel(
    connection: "connecting" | "offline" | "online",
): string {
    if (connection === "online") return "Online";
    if (connection === "connecting") return "Connecting…";
    return "Offline";
}

const pageLabels: Record<WebRoute["page"], string> = {
    audit: "Audit",
    extension: "Extension",
    instances: "Instances",
    messages: "Messages",
    overview: "Overview",
    todos: "Todos",
};

function routeSubtitle(state: WebState, route: WebRoute): string | undefined {
    if (route.page === "messages" && route.view === "thread")
        return (
            selectWebMessageSession(state, route.instance, route.ctxId)
                ?.title ?? route.instance
        );
    if (route.page === "extension")
        return state.readModel.webPages.find((page) => page.id === route.id)
            ?.title;
    if (route.page === "instances") return route.instance;
    return undefined;
}

function pageTitle(route: WebRoute, context?: string): string {
    const heading =
        route.page === "extension" && context !== undefined
            ? context
            : pageLabels[route.page];
    const suffix =
        context === undefined || route.page === "extension"
            ? ""
            : ` · ${context}`;
    return `${heading}${suffix} — portable-devshell`;
}
