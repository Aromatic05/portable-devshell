import { useMemo } from "react";

import { createWebClients, type WebClients } from "../client/WebClients.js";
import { Login } from "../session/Login.js";
import { BrowserWebSession, type WebSession } from "../session/WebSession.js";
import { useWebApplicationSession } from "../session/useWebApplicationSession.js";
import { Application } from "./Application.js";

function createBrowserSession(): WebSession {
    return new BrowserWebSession();
}

export interface AppProps {
    createClients?(): WebClients;
    createSession?(): WebSession;
    session?: WebSession;
}

export function App({
    createClients = createWebClients,
    createSession = createBrowserSession,
    session,
}: AppProps) {
    const activeSession = useMemo(
        () => session ?? createSession(),
        [createSession, session],
    );
    const application = useWebApplicationSession(activeSession, createClients);

    if (application.sessionState === "checking") {
        return <main className="session">
            <p aria-live="polite">Checking session…</p>
        </main>;
    }
    if (application.sessionState === "login" || application.store === undefined) {
        return <Login error={application.error} onLogin={application.login} />;
    }
    return <Application
        busy={application.busy}
        error={application.error}
        onLogout={application.logout}
        onReconnect={application.reconnect}
        store={application.store}
    />;
}
