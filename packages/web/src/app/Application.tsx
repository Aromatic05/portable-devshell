import { useSyncExternalStore } from "react";

import { Navigation } from "../components/Navigation.js";
import { PartialFailures } from "../components/PartialFailures.js";
import { useHashRoute } from "../routing/hashRoute.js";
import { openTodos, pendingApprovals } from "../selectors/readModel.js";
import type { WebStore } from "../state/WebStore.js";
import { webFailures } from "../state/WebState.js";
import type { ApplicationBusy } from "../session/useWebApplicationSession.js";
import { Approvals } from "../views/Approvals.js";
import { Instances } from "../views/Instances.js";
import { Overview } from "../views/Overview.js";
import { Todos } from "../views/Todos.js";
import { ToolCalls } from "../views/ToolCalls.js";

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
    const counts = {
        approvals: pendingApprovals(state),
        instances: state.readModel.instances.length,
        todos: openTodos(state),
    };

    return <div className="app">
        <aside>
            <h1>portable-devshell</h1>
            <Navigation active={route} counts={counts} navigate={navigate} />
        </aside>
        <main>
            <header className={`connection ${state.connection}`}>
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
            </header>
            <PartialFailures failures={webFailures(state.readModel)} />
            <div aria-live="polite">
                {state.notice === undefined ? null : <p className="notice">{state.notice}</p>}
                {state.error === undefined ? null : <p className="error" role="alert">{state.error}</p>}
                {error === undefined ? null : <p className="error" role="alert">{error}</p>}
            </div>
            {route === "overview" ? <Overview state={state} /> : null}
            {route === "instances" ? <Instances disabled={interactionDisabled} store={store} /> : null}
            {route === "approvals" ? <Approvals disabled={interactionDisabled} store={store} /> : null}
            {route === "activity" ? <ToolCalls disabled={interactionDisabled} state={state} store={store} /> : null}
            {route === "todos" ? <Todos disabled={interactionDisabled} state={state} store={store} /> : null}
        </main>
        <nav aria-label="Primary navigation" className="bottom">
            <Navigation active={route} counts={counts} navigate={navigate} />
        </nav>
    </div>;
}

function connectionLabel(connection: "connecting" | "offline" | "online"): string {
    if (connection === "online") return "Online";
    if (connection === "connecting") return "Connecting…";
    return "Offline";
}
