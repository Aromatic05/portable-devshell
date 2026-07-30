import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";

import { createWebClients, type WebClients } from "../client/WebClients.js";
import { Navigation } from "../components/Navigation.js";
import { useHashRoute } from "../routing/hashRoute.js";
import { BrowserWebSession, type WebSession } from "../session/WebSession.js";
import { openTodos, pendingApprovals } from "../selectors/readModel.js";
import { WebStore } from "../state/WebStore.js";
import { Activity } from "../views/Activity.js";
import { Approvals } from "../views/Approvals.js";
import { Instances } from "../views/Instances.js";
import { Overview } from "../views/Overview.js";
import { Todos } from "../views/Todos.js";

type SessionState = "checking" | "login" | "ready";

function createBrowserSession(): WebSession {
    return new BrowserWebSession();
}

export interface AppProps {
    createClients?(): WebClients;
    createSession?(): WebSession;
    session?: WebSession;
}

export function App({ createClients = createWebClients, createSession = createBrowserSession, session }: AppProps) {
    const activeSession = useMemo(() => session ?? createSession(), [createSession, session]);
    const [sessionState, setSessionState] = useState<SessionState>("checking");
    const [store, setStore] = useState<WebStore>();
    const storeRef = useRef<WebStore>();
    const [error, setError] = useState<string>();
    useEffect(() => {
        let disposed = false;
        void bootstrap();
        return () => { disposed = true; storeRef.current?.close(); };
        async function bootstrap(): Promise<void> {
            try {
                const available = (await activeSession.check()) || (await activeSession.establish());
                if (disposed) return;
                if (!available) { setSessionState("login"); return; }
                const nextStore = new WebStore(createClients());
                storeRef.current = nextStore;
                setStore(nextStore);
                setSessionState("ready");
                void nextStore.load();
            } catch { if (!disposed) { setError("Unable to establish a session."); setSessionState("login"); } }
        }
    }, [activeSession, createClients]);
    async function login(token: string): Promise<void> {
        try {
            if (!(await activeSession.establish(token))) { setError("Sign-in was not accepted."); return; }
            const nextStore = new WebStore(createClients());
            storeRef.current = nextStore;
            setError(undefined); setStore(nextStore); setSessionState("ready"); void nextStore.load();
        } catch { setError("Unable to establish a session."); }
    }
    async function logout(): Promise<void> {
        try { await activeSession.logout(); storeRef.current?.close(); storeRef.current = undefined; setStore(undefined); setError(undefined); setSessionState("login"); }
        catch (logoutError) { setError(logoutError instanceof Error ? logoutError.message : "Unable to log out."); }
    }
    if (sessionState === "checking") return <main className="session"><p aria-live="polite">Checking session…</p></main>;
    if (sessionState === "login" || store === undefined) return <Login error={error} onLogin={login} />;
    return <Application store={store} onLogout={logout} />;
}

function Login({ error, onLogin }: { error?: string; onLogin(token: string): Promise<void> }) {
    const [token, setToken] = useState(""); const [submitting, setSubmitting] = useState(false);
    async function submit(event: FormEvent<HTMLFormElement>): Promise<void> { event.preventDefault(); setSubmitting(true); await onLogin(token); setToken(""); setSubmitting(false); }
    return <main className="session"><form onSubmit={(event) => void submit(event)}><h1>portable-devshell</h1><label>Access token<input autoComplete="off" onChange={(event) => setToken(event.target.value)} type="password" value={token} /></label>{error !== undefined ? <p className="error" role="alert">{error}</p> : null}<button disabled={submitting || token.length === 0} type="submit">{submitting ? "Signing in…" : "Sign in"}</button></form></main>;
}

function Application({ store, onLogout }: { store: WebStore; onLogout(): Promise<void> }) {
    const state = useSyncExternalStore(store.subscribe.bind(store), () => store.state, () => store.state);
    const [route, navigate] = useHashRoute();
    const counts = { approvals: pendingApprovals(state), instances: state.instances.length, todos: openTodos(state) };
    return <div className="app"><aside><h1>portable-devshell</h1><Navigation active={route} counts={counts} navigate={navigate} /></aside><main><header className={`connection ${state.connection}`}><span>{state.connection === "online" ? "Online" : state.connection === "connecting" ? "Connecting…" : "Offline"}</span>{state.connection !== "online" ? <button onClick={() => void store.reconnect()}>Reconnect</button> : null}<button onClick={() => void onLogout()}>Log out</button></header>{Object.keys(state.partialFailures).length > 0 ? <p className="partial" role="status">Some instance data could not be refreshed. Other data remains available.</p> : null}<div aria-live="polite">{state.notice !== undefined ? <p className="notice">{state.notice}</p> : null}{state.error !== undefined ? <p className="error" role="alert">{state.error}</p> : null}</div>{route === "overview" ? <Overview state={state} /> : null}{route === "instances" ? <Instances store={store} /> : null}{route === "approvals" ? <Approvals store={store} /> : null}{route === "activity" ? <Activity state={state} /> : null}{route === "todos" ? <Todos state={state} /> : null}</main><nav aria-label="Primary navigation" className="bottom"><Navigation active={route} counts={counts} navigate={navigate} /></nav></div>;
}
