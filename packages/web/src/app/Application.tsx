import { useEffect, useSyncExternalStore } from "react";

import { PageSwitcher } from "../components/PageSwitcher.js";
import { PartialFailures } from "../components/PartialFailures.js";
import { useHashRoute } from "../routing/hashRoute.js";
import { openTodos, pendingApprovals } from "../selectors/readModel.js";
import type { WebStore } from "../state/WebStore.js";
import { webFailures } from "../state/WebState.js";
import type { ApplicationBusy } from "../session/useWebApplicationSession.js";
import { Approvals } from "../views/Approvals.js";
import { Audit } from "../views/Audit.js";
import { Instances } from "../views/Instances.js";
import { Messages } from "../views/Messages.js";
import { Overview } from "../views/Overview.js";
import { Todos } from "../views/Todos.js";

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
            <div aria-live="polite">
                {state.notice === undefined ? null : <p className="notice">{state.notice}</p>}
                {state.error === undefined ? null : <p className="error" role="alert">{state.error}</p>}
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
