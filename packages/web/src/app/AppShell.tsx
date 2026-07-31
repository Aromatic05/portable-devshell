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
    const lifecycle = useRef(0);
    const loginRequest = useRef<Promise<void>>();
    const logoutRequest = useRef<Promise<void>>();
    const reconnectRequest = useRef<Promise<void>>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState<"login" | "logout" | "reconnect">();
    useEffect(() => {
        let disposed = false;
        const generation = ++lifecycle.current;
        void bootstrap();
        return () => { disposed = true; lifecycle.current += 1; discardStore(); };
        function current(): boolean { return !disposed && lifecycle.current === generation; }
        async function bootstrap(): Promise<void> {
            try {
                const available = (await activeSession.check()) || (await activeSession.establish());
                if (!current()) return;
                if (!available) { setSessionState("login"); return; }
                activateStore(generation);
            } catch { if (current()) { setError("Unable to establish a session."); setSessionState("login"); } }
        }
    }, [activeSession, createClients]);
    function discardStore(): void {
        storeRef.current?.close();
        storeRef.current = undefined;
    }
    function activateStore(generation: number): void {
        if (lifecycle.current !== generation) return;
        discardStore();
        const nextStore = new WebStore(createClients());
        storeRef.current = nextStore;
        setStore(nextStore);
        setSessionState("ready");
        void nextStore.load();
    }
    async function login(token: string): Promise<void> {
        if (loginRequest.current !== undefined) return await loginRequest.current;
        const generation = ++lifecycle.current;
        const request = (async () => {
            setBusy("login");
            try {
                if (!(await activeSession.establish(token))) {
                    if (lifecycle.current === generation) setError("Sign-in was not accepted.");
                    return;
                }
                if (lifecycle.current !== generation) return;
                setError(undefined);
                activateStore(generation);
            } catch {
                if (lifecycle.current === generation) setError("Unable to establish a session.");
            } finally {
                if (lifecycle.current === generation) setBusy(undefined);
            }
        })();
        loginRequest.current = request;
        try { await request; } finally { if (loginRequest.current === request) loginRequest.current = undefined; }
    }
    async function logout(): Promise<void> {
        if (logoutRequest.current !== undefined) return await logoutRequest.current;
        const generation = ++lifecycle.current;
        const request = (async () => {
            setBusy("logout");
            try {
                await activeSession.logout();
                if (lifecycle.current !== generation) return;
                discardStore(); setStore(undefined); setError(undefined); setSessionState("login");
            } catch (logoutError) {
                if (lifecycle.current === generation) setError(logoutError instanceof Error ? logoutError.message : "Unable to log out.");
            } finally {
                if (lifecycle.current === generation) setBusy(undefined);
            }
        })();
        logoutRequest.current = request;
        try { await request; } finally { if (logoutRequest.current === request) logoutRequest.current = undefined; }
    }
    async function reconnect(): Promise<void> {
        if (reconnectRequest.current !== undefined) return await reconnectRequest.current;
        const generation = lifecycle.current;
        const target = storeRef.current;
        if (target === undefined) return;
        const request = (async () => {
            setBusy("reconnect");
            try {
                const available = await activeSession.check();
                if (lifecycle.current !== generation || storeRef.current !== target) return;
                if (!available) {
                    discardStore(); setStore(undefined); setError(undefined); setSessionState("login");
                    return;
                }
                await target.reconnect();
            } catch {
                if (lifecycle.current === generation && storeRef.current === target) setError("Unable to verify the session.");
            } finally {
                if (lifecycle.current === generation) setBusy(undefined);
            }
        })();
        reconnectRequest.current = request;
        try { await request; } finally { if (reconnectRequest.current === request) reconnectRequest.current = undefined; }
    }
    if (sessionState === "checking") return <main className="session"><p aria-live="polite">Checking session…</p></main>;
    if (sessionState === "login" || store === undefined) return <Login error={error} onLogin={login} />;
    return <Application busy={busy} store={store} onLogout={logout} onReconnect={reconnect} />;
}

function Login({ error, onLogin }: { error?: string; onLogin(token: string): Promise<void> }) {
    const [token, setToken] = useState(""); const [submitting, setSubmitting] = useState(false);
    async function submit(event: FormEvent<HTMLFormElement>): Promise<void> { event.preventDefault(); setSubmitting(true); await onLogin(token); setToken(""); setSubmitting(false); }
    return <main className="session"><form onSubmit={(event) => void submit(event)}><h1>portable-devshell</h1><label>Access token<input autoComplete="off" onChange={(event) => setToken(event.target.value)} type="password" value={token} /></label>{error !== undefined ? <p className="error" role="alert">{error}</p> : null}<button disabled={submitting || token.length === 0} type="submit">{submitting ? "Signing in…" : "Sign in"}</button></form></main>;
}

function Application({ busy, store, onLogout, onReconnect }: { busy?: "login" | "logout" | "reconnect"; store: WebStore; onLogout(): Promise<void>; onReconnect(): Promise<void> }) {
    const state = useSyncExternalStore(store.subscribe.bind(store), () => store.state, () => store.state);
    const [route, navigate] = useHashRoute();
    const counts = { approvals: pendingApprovals(state), instances: state.instances.length, todos: openTodos(state) };
    return <div className="app"><aside><h1>portable-devshell</h1><Navigation active={route} counts={counts} navigate={navigate} /></aside><main><header className={`connection ${state.connection}`}><span>{state.connection === "online" ? "Online" : state.connection === "connecting" ? "Connecting…" : "Offline"}</span>{state.connection !== "online" ? <button disabled={busy !== undefined} onClick={() => void onReconnect()}>{busy === "reconnect" ? "Reconnecting…" : "Reconnect"}</button> : null}<button disabled={busy !== undefined} onClick={() => void onLogout()}>{busy === "logout" ? "Logging out…" : "Log out"}</button></header>{Object.keys(state.partialFailures).length > 0 ? <p className="partial" role="status">Some instance data could not be refreshed. Other data remains available.</p> : null}<div aria-live="polite">{state.notice !== undefined ? <p className="notice">{state.notice}</p> : null}{state.error !== undefined ? <p className="error" role="alert">{state.error}</p> : null}</div>{route === "overview" ? <Overview state={state} /> : null}{route === "instances" ? <Instances store={store} /> : null}{route === "approvals" ? <Approvals store={store} /> : null}{route === "activity" ? <Activity state={state} /> : null}{route === "todos" ? <Todos state={state} /> : null}</main><nav aria-label="Primary navigation" className="bottom"><Navigation active={route} counts={counts} navigate={navigate} /></nav></div>;
}
