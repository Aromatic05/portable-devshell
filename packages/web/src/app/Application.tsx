import { useEffect, useSyncExternalStore } from "react";

import { PageSwitcher } from "../view/component/Navigation.js";
import { PartialFailures } from "../view/component/Feedback.js";
import { useHashRoute } from "./Route.js";
import { openTodos, pendingApprovals } from "../view/ReadModel.js";
import type { WebStore } from "../state/Store.js";
import { webFailures } from "../state/Model.js";
import type { ApplicationBusy } from "./session/Hook.js";
import { Approvals } from "../view/page/activity/Approvals.js";
import { Audit } from "../view/page/activity/audit/Page.js";
import { Instances } from "../view/page/Instances.js";
import { Messages } from "../view/page/activity/messages/Page.js";
import { Overview } from "../view/page/Overview.js";
import { Todos } from "../view/page/Todos.js";

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
        if ((route.page === "audit" || route.page === "messages") && state.connection === "online") {
            void store.refreshAudit();
        }
    }, [route, state.connection, store]);
    const counts = {
        approvals: pendingApprovals(state),
        instances: state.readModel.instances.length,
        todos: openTodos(state),
    };

    return <div className="app">
        <header className="app-header">
            <strong className="app-name">portable-devshell</strong>
            <PageSwitcher
                active={route}
                applications={state.readModel.webApplications}
                counts={counts}
                navigate={navigate}
            />
            <div className={`connection ${state.connection}`}>
                <span>{connectionLabel(state.connection)}</span>
                {state.connection === "online" ? null : <button
                    disabled={busy !== undefined}
                    onClick={() => void onReconnect()}
                >
                    {busy === "reconnect" ? "Reconnecting…" : "Reconnect"}
                </button>}
                <button disabled={busy !== undefined} onClick={() => void onLogout()}>
                    {busy === "logout" ? "Logging out…" : "Log out"}
                </button>
            </div>
        </header>
        <main className={`page page-${route.page}`}>
            <PartialFailures failures={webFailures(state.readModel)} />
            <div aria-live="polite" className="global-feedback">
                {state.notice === undefined ? null : <div className="feedback-row notice">
                    <p>{state.notice}</p>
                    <button aria-label="Dismiss notice" onClick={() => store.dismissFeedback("notice")} type="button">×</button>
                </div>}
                {state.error === undefined ? null : <div className="feedback-row error" role="alert">
                    <p>{state.error}</p>
                    <button aria-label="Dismiss error" onClick={() => store.dismissFeedback("error")} type="button">×</button>
                </div>}
                {error === undefined ? null : <p className="error" role="alert">{error}</p>}
            </div>
            {route.page === "overview" ? <Overview state={state} /> : null}
            {route.page === "instances" ? <Instances disabled={interactionDisabled} store={store} /> : null}
            {route.page === "approvals" ? <Approvals disabled={interactionDisabled} store={store} /> : null}
            {route.page === "audit" ? <Audit disabled={interactionDisabled} navigate={navigate} route={route} state={state} store={store} /> : null}
            {route.page === "messages" ? <Messages navigate={navigate} route={route} state={state} store={store} /> : null}
            {route.page === "todos" ? <Todos disabled={interactionDisabled} state={state} store={store} /> : null}
        </main>
    </div>;
}

function connectionLabel(connection: "connecting" | "offline" | "online"): string {
    if (connection === "online") return "Online";
    if (connection === "connecting") return "Connecting…";
    return "Offline";
}
