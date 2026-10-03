import { useEffect, useSyncExternalStore } from "react";

import {
    WebDomainProvider,
    useDomainSnapshot,
    useWebDomains,
} from "./domain/Context.js";
import { PageSwitcher } from "../view/component/Navigation.js";
import { PartialFailures } from "../view/component/Feedback.js";
import { useHashRoute, type WebRoute } from "./Route.js";
import type { WebStore } from "../state/Store.js";
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
    return (
        <WebDomainProvider domains={store.domains}>
            <ApplicationBody
                busy={busy}
                error={error}
                onLogout={onLogout}
                onReconnect={onReconnect}
                store={store}
            />
        </WebDomainProvider>
    );
}

function ApplicationBody({
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
    const domains = useWebDomains();
    const service = useDomainSnapshot(domains.service);
    const overviewState = useDomainSnapshot(domains.overview);
    const extension = useDomainSnapshot(domains.extension);
    const config = useDomainSnapshot(domains.config);
    const mcp = useDomainSnapshot(domains.mcp);
    const artifact = useDomainSnapshot(domains.artifact);
    const context = useDomainSnapshot(domains.context);
    const [route, navigate] = useHashRoute();
    const interactionDisabled = busy !== undefined;

    useEffect(() => {
        store.setOverviewActive(route.page === "overview");
        return () => store.setOverviewActive(false);
    }, [route.page, store]);

    useEffect(() => {
        if (service.status !== "online") return;
        if (route.page === "audit") void store.refreshAudit();
        else if (route.page === "messages") void store.refreshMessages();
    }, [route.page, service.status, store]);

    useEffect(() => {
        if (state.notice === undefined) return;
        const timer = setTimeout(() => store.dismissFeedback("notice"), 5_000);
        return () => clearTimeout(timer);
    }, [state.notice, store]);

    const routeContext = routeSubtitle(extension.webPages, route);
    useEffect(() => {
        document.title = pageTitle(route, routeContext);
    }, [route, routeContext]);

    const overview = overviewState.overview;
    const counts = {
        instances:
            overview === undefined
                ? 0
                : overview.counts.instancesAttention +
                  overview.counts.instancesCritical,
        todos: overview?.counts.activeTodos ?? 0,
    };
    const failures: Record<string, string> = {};
    if (config.failure !== undefined) failures.config = config.failure.message;
    if (overviewState.failure !== undefined)
        failures.overview = overviewState.failure.message;
    if (mcp.failure !== undefined) failures.mcp = mcp.failure.message;
    if (artifact.failure !== undefined)
        failures.artifact = artifact.failure.message;
    if (context.failure !== undefined)
        failures.context = context.failure.message;

    return (
        <div className="app">
            <header className="app-header">
                <strong className="app-name">portable-devshell</strong>
                <PageSwitcher
                    active={route}
                    applications={extension.webApplications}
                    extensionPages={extension.webPages}
                    counts={counts}
                    navigate={navigate}
                />
                <div className={`connection ${service.status}`}>
                    <span>{connectionLabel(service.status)}</span>
                    {service.status === "online" ? null : (
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
                <PartialFailures failures={failures} />
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
                {route.page === "overview" ? <Overview /> : null}
                {route.page === "extension" ? (
                    <ExtensionPage
                        descriptor={extension.webPages.find(
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
                        store={store}
                    />
                ) : null}
                {route.page === "messages" ? (
                    <Messages
                        navigate={navigate}
                        route={route}
                        store={store}
                    />
                ) : null}
                {route.page === "todos" ? (
                    <Todos
                        disabled={interactionDisabled}
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

function routeSubtitle(
    webPages: readonly { id: string; title: string }[],
    route: WebRoute,
): string | undefined {
    if (route.page === "messages" && route.view === "thread")
        return route.instance;
    if (route.page === "extension")
        return webPages.find((page) => page.id === route.id)?.title;
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
