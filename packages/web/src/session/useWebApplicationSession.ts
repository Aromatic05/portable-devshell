import { useEffect, useRef, useState } from "react";

import type { WebClients } from "../client/WebClients.js";
import { WebStore } from "../state/WebStore.js";
import type { WebSession } from "./WebSession.js";

export type ApplicationBusy = "login" | "logout" | "reconnect";
export type SessionState = "checking" | "login" | "ready";

export interface WebApplicationSession {
    busy?: ApplicationBusy;
    error?: string;
    login(token: string): Promise<void>;
    logout(): Promise<void>;
    reconnect(): Promise<void>;
    sessionState: SessionState;
    store?: WebStore;
}

export function useWebApplicationSession(
    activeSession: WebSession,
    createClients: () => WebClients,
): WebApplicationSession {
    const [sessionState, setSessionState] = useState<SessionState>("checking");
    const [store, setStore] = useState<WebStore>();
    const [storeContext, setStoreContext] = useState<{
        clients: () => WebClients;
        session: WebSession;
    }>();
    const storeRef = useRef<WebStore>();
    const lifecycle = useRef(0);
    const loginRequest = useRef<Promise<void>>();
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
                const available =
                    (await activeSession.check()) ||
                    (await activeSession.establish());
                if (!current()) return;
                if (!available) {
                    setSessionState("login");
                    return;
                }
                activateStore(generation);
            } catch {
                if (current()) {
                    setError("Unable to establish a session.");
                    setSessionState("login");
                }
            }
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
        setStoreContext({ clients: createClients, session: activeSession });
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
                    if (lifecycle.current === generation) {
                        setError("Sign-in was not accepted.");
                    }
                    return;
                }
                if (lifecycle.current !== generation) return;
                setError(undefined);
                activateStore(generation);
            } catch {
                if (lifecycle.current === generation) {
                    setError("Unable to establish a session.");
                }
            } finally {
                if (lifecycle.current === generation) setBusy(undefined);
            }
        })();
        loginRequest.current = request;
        try {
            await request;
        } finally {
            if (loginRequest.current === request) loginRequest.current = undefined;
        }
    }

    async function logout(): Promise<void> {
        if (logoutRequest.current !== undefined) return await logoutRequest.current;
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
                setSessionState("login");
            } catch (logoutError) {
                if (lifecycle.current === generation) {
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
            if (logoutRequest.current === request) logoutRequest.current = undefined;
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
                ) return;
                if (!available) {
                    discardStore();
                    setStore(undefined);
                    setSessionState("login");
                    return;
                }
                await target.reconnect();
                if (
                    lifecycle.current === generation &&
                    storeRef.current === target
                ) setError(undefined);
            } catch {
                if (
                    lifecycle.current === generation &&
                    storeRef.current === target
                ) setError("Unable to verify the session.");
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
        (storeContext?.clients !== createClients ||
            storeContext?.session !== activeSession);

    return {
        busy,
        error,
        login,
        logout,
        reconnect,
        sessionState: contextChanged ? "checking" : sessionState,
        store: contextChanged ? undefined : store,
    };
}
