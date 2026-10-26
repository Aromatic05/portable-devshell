import { useEffect, useRef, useState } from "react";

import type { WebDomainSession } from "../domain/Session.js";
import { WebStore } from "../../state/Store.js";
import type { WebAuthMode, WebSession } from "./Session.js";

export type ApplicationBusy = "login" | "logout" | "reconnect";
export type SessionState = "checking" | "login" | "ready";

export interface WebApplicationSession {
    authMode?: WebAuthMode;
    busy?: ApplicationBusy;
    error?: string;
    login(token: string): Promise<boolean>;
    logout(): Promise<void>;
    reconnect(): Promise<void>;
    sessionState: SessionState;
    store?: WebStore;
}

export function useWebApplicationSession(
    activeSession: WebSession,
    createDomains: () => WebDomainSession,
): WebApplicationSession {
    const [authMode, setAuthMode] = useState<WebAuthMode>();
    const [sessionState, setSessionState] = useState<SessionState>("checking");
    const [store, setStore] = useState<WebStore>();
    const [storeContext, setStoreContext] = useState<{
        domains: () => WebDomainSession;
        session: WebSession;
    }>();
    const storeRef = useRef<WebStore>();
    const lifecycle = useRef(0);
    const loginRequest = useRef<Promise<boolean>>();
    const logoutRequest = useRef<Promise<void>>();
    const reconnectRequest = useRef<Promise<void>>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState<ApplicationBusy>();

    useEffect(() => {
        let disposed = false;
        const generation = ++lifecycle.current;
        discardStore();
        setStore(undefined);
        setStoreContext(undefined);
        setError(undefined);
        setBusy(undefined);
        setAuthMode(undefined);
        setSessionState("checking");
        void bootstrap();
        return () => {
            disposed = true;
            lifecycle.current += 1;
            discardStore();
        };

        function current(): boolean {
            return !disposed && lifecycle.current === generation;
        }

        async function bootstrap(): Promise<void> {
            try {
                const available = await activeSession.check();
                const mode = await activeSession.authMode();
                if (!current()) return;
                setAuthMode(mode);
                if (available) {
                    if (current()) activateStore(generation);
                    return;
                }
                await authenticate(current, mode);
            } catch {
                if (current()) {
                    setError("Unable to establish a session.");
                    setSessionState("login");
                }
            }
        }
    }, [activeSession, createDomains]);

    async function authenticate(current: () => boolean, knownMode?: WebAuthMode): Promise<void> {
        const generation = lifecycle.current;
        const mode = knownMode ?? await activeSession.authMode();
        if (!current()) return;
        setAuthMode(mode);
        if (mode === "oauth2") {
            activeSession.startOAuth();
            return;
        }
        if (mode === "token") {
            setSessionState("login");
            return;
        }
        if (await activeSession.establish()) {
            if (current()) activateStore(generation);
            return;
        }
        if (current()) setSessionState("login");
    }

    function discardStore(): void {
        storeRef.current?.close();
        storeRef.current = undefined;
    }

    function activateStore(generation: number): void {
        if (lifecycle.current !== generation) return;
        discardStore();
        const nextStore = new WebStore(createDomains());
        storeRef.current = nextStore;
        setStore(nextStore);
        setStoreContext({ domains: createDomains, session: activeSession });
        setSessionState("ready");
        void nextStore.load();
    }

    async function login(token: string): Promise<boolean> {
        if (loginRequest.current !== undefined)
            return await loginRequest.current;
        const generation = ++lifecycle.current;
        const request = (async () => {
            setBusy("login");
            try {
                const mode = authMode ?? await activeSession.authMode();
                if (lifecycle.current !== generation) return false;
                setAuthMode(mode);
                if (mode === "token" && token.length === 0) {
                    setSessionState("login");
                    return false;
                }
                if (mode === "oauth2") {
                    activeSession.startOAuth();
                    return false;
                }
                if (!(await activeSession.establish(mode === "none" ? undefined : token))) {
                    if (lifecycle.current === generation) {
                        setError(mode === "none" ? "Unable to restore the session. Retry reconnecting." : "Sign-in was not accepted.");
                    }
                    return false;
                }
                if (lifecycle.current !== generation) return false;
                setError(undefined);
                activateStore(generation);
                return true;
            } catch {
                if (lifecycle.current === generation) {
                    setError("Unable to establish a session.");
                }
                return false;
            } finally {
                if (lifecycle.current === generation) setBusy(undefined);
            }
        })();
        loginRequest.current = request;
        try {
            return await request;
        } finally {
            if (loginRequest.current === request)
                loginRequest.current = undefined;
        }
    }

    async function logout(): Promise<void> {
        if (logoutRequest.current !== undefined)
            return await logoutRequest.current;
        const generation = ++lifecycle.current;
        const request = (async () => {
            setBusy("logout");
            setError(undefined);
            try {
                await activeSession.logout();
                if (lifecycle.current !== generation) return;
                discardStore();
                setStore(undefined);
                setError(undefined);
                setSessionState("checking");
                const mode = await activeSession.authMode();
                if (lifecycle.current !== generation) return;
                setAuthMode(mode);
                if (mode === "none") await authenticate(() => lifecycle.current === generation, mode);
                else setSessionState("login");
            } catch (logoutError) {
                if (lifecycle.current === generation) {
                    if (storeRef.current === undefined) setSessionState("login");
                    setError(
                        logoutError instanceof Error
                            ? logoutError.message
                            : "Unable to log out.",
                    );
                }
            } finally {
                if (lifecycle.current === generation) setBusy(undefined);
            }
        })();
        logoutRequest.current = request;
        try {
            await request;
        } finally {
            if (logoutRequest.current === request)
                logoutRequest.current = undefined;
        }
    }

    async function reconnect(): Promise<void> {
        if (reconnectRequest.current !== undefined) {
            return await reconnectRequest.current;
        }
        const generation = lifecycle.current;
        const target = storeRef.current;
        if (target === undefined) return;
        const request = (async () => {
            setBusy("reconnect");
            setError(undefined);
            try {
                const available = await activeSession.check();
                if (
                    lifecycle.current !== generation ||
                    storeRef.current !== target
                )
                    return;
                if (!available) {
                    discardStore();
                    setStore(undefined);
                    setSessionState("checking");
                    await authenticate(() => lifecycle.current === generation);
                    return;
                }
                await target.reconnect();
                if (
                    lifecycle.current === generation &&
                    storeRef.current === target
                )
                    setError(undefined);
            } catch {
                if (lifecycle.current === generation) {
                    setError("Unable to verify the session.");
                    if (storeRef.current === undefined) setSessionState("login");
                }
            } finally {
                if (lifecycle.current === generation) setBusy(undefined);
            }
        })();
        reconnectRequest.current = request;
        try {
            await request;
        } finally {
            if (reconnectRequest.current === request) {
                reconnectRequest.current = undefined;
            }
        }
    }

    const contextChanged =
        store !== undefined &&
        (storeContext?.domains !== createDomains ||
            storeContext?.session !== activeSession);

    return {
        authMode,
        busy,
        error,
        login,
        logout,
        reconnect,
        sessionState: contextChanged ? "checking" : sessionState,
        store: contextChanged ? undefined : store,
    };
}
