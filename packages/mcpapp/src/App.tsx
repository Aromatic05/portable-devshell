import {
    App,
    applyDocumentTheme,
    applyHostFonts,
    applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps/app-with-deps";
import { useEffect, useRef, useState } from "react";
import { readMcpAppSnapshot, watchMcpApp, type McpAppItem, type McpAppSnapshot } from "./Connection.js";
import { clearMcpAppSession, readMcpAppSession, restoreMcpAppSession, saveMcpAppSession, type McpAppSession } from "./Session.js";

declare const __MCPAPP_VERSION__: string;

type ConnectionStatus = "connecting" | "connected" | "disconnected";
type ConnectedApp = App & { onclose?: () => void; close(): Promise<void> };

export function AppView() {
    const [status, setStatus] = useState<ConnectionStatus>("connecting");
    const [ctxId, setCtxId] = useState<string>();
    const [displayMode, setDisplayMode] = useState("inline");
    const [session, setSession] = useState<McpAppSession | undefined>(() => restoreMcpAppSession());
    const sessionRef = useRef(session);
    const [snapshot, setSnapshot] = useState<McpAppSnapshot>();
    const [liveError, setLiveError] = useState<string>();
    const [actionError, setActionError] = useState<string>();
    const [pendingAction, setPendingAction] = useState<string>();
    const [busyAction, setBusyAction] = useState<string>();
    const hostRef = useRef<ConnectedApp>();

    useEffect(() => {
        let active = true;
        let stopSize: (() => void) | undefined;
        let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
        let currentApp: ConnectedApp | undefined;
        const retry = () => {
            if (!active || reconnectTimer !== undefined) return;
            setSnapshot(undefined);
            setStatus("disconnected");
            reconnectTimer = setTimeout(() => {
                reconnectTimer = undefined;
                const previous = currentApp;
                currentApp = undefined;
                if (hostRef.current === previous) hostRef.current = undefined;
                stopSize?.();
                stopSize = undefined;
                void previous?.close().catch(() => undefined);
                connect();
            }, 1_000);
        };
        const connect = () => {
            if (!active) return;
            setStatus("connecting");
            const app = new App(
                { name: "portable-devshell-workspace", version: __MCPAPP_VERSION__ },
                { availableDisplayModes: ["inline", "pip", "fullscreen"] },
                { autoResize: true },
            ) as ConnectedApp;
            currentApp = app;
            hostRef.current = app;
            app.onhostcontextchanged = (context) => {
                if (!active || currentApp !== app) return;
                if (context.theme === "light" || context.theme === "dark")
                    applyDocumentTheme(context.theme);
                if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
                if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
                setDisplayMode(context.displayMode ?? "inline");
            };
            app.ontoolinput = (input) => {
                if (!active || currentApp !== app) return;
                const value = input.arguments as Record<string, unknown> | undefined;
                if (typeof value?.ctxId === "string") {
                    if (sessionRef.current && sessionRef.current.ctxId !== value.ctxId) {
                        sessionRef.current = undefined;
                        setSession(undefined);
                        setSnapshot(undefined);
                        clearMcpAppSession();
                    }
                    setCtxId(value.ctxId);
                }
            };
            app.ontoolresult = (result) => {
                if (!active || currentApp !== app) return;
                const nextSession = readMcpAppSession(result);
                if (nextSession) {
                    sessionRef.current = nextSession;
                    setCtxId(nextSession.ctxId);
                    setSession(nextSession);
                    saveMcpAppSession(nextSession);
                    return;
                }
                const content = result.structuredContent as Record<string, unknown> | undefined;
                if (typeof content?.ctxId === "string") {
                    if (sessionRef.current && sessionRef.current.ctxId !== content.ctxId) {
                        sessionRef.current = undefined;
                        setSession(undefined);
                        setSnapshot(undefined);
                        clearMcpAppSession();
                    }
                    setCtxId(content.ctxId);
                }
            };
            app.onclose = () => { if (currentApp === app) retry(); };
            app.onteardown = async () => { if (currentApp === app) retry(); return {}; };
            void app.connect().then(() => {
                if (!active || currentApp !== app) return;
                setDisplayMode(app.getHostContext()?.displayMode ?? "inline");
                setStatus("connected");
                stopSize = app.setupSizeChangedNotifications();
            }).catch(() => { if (currentApp === app) retry(); });
        };
        connect();
        return () => {
            active = false;
            if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
            stopSize?.();
            hostRef.current = undefined;
            void currentApp?.close();
        };
    }, []);

    useEffect(() => {
        if (session === undefined || status !== "connected") return;
        const controller = new AbortController();
        let current = true;
        setSnapshot(undefined);
        setLiveError(undefined);
        void (async () => {
            let cursor = 0;
            let retries = 0;
            while (!controller.signal.aborted && current) {
                try {
                    if (cursor === 0) {
                        const first = await readMcpAppSnapshot(session, controller.signal);
                        if (!current) return;
                        cursor = first.cursor;
                        setSnapshot(first);
                        setLiveError(undefined);
                    }
                    const update = await watchMcpApp(session, cursor, controller.signal);
                    if (!current) return;
                    if (update.snapshot) setSnapshot((previous) =>
                        previous === undefined || update.snapshot!.cursor >= previous.cursor
                            ? update.snapshot : previous,
                    );
                    cursor = Math.max(cursor, update.cursor);
                    retries = 0;
                } catch (error) {
                    if (controller.signal.aborted || !current) return;
                    const message = error instanceof Error ? error.message : "MCP App connection failed";
                    setSnapshot(undefined);
                    setLiveError(message);
                    if (message === "MCP App authorization expired") {
                        sessionRef.current = undefined;
                        setSession(undefined);
                        clearMcpAppSession();
                        return;
                    }
                    cursor = 0;
                    await new Promise<void>((resolve) => {
                        const delay = Math.min(1_000 * 2 ** Math.min(retries++, 4), 15_000);
                        const timer = setTimeout(resolve, delay);
                        controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
                    });
                }
            }
        })();
        return () => { current = false; controller.abort(); };
    }, [session, status]);

    const act = async (item: McpAppItem, action: NonNullable<McpAppItem["actions"]>[number]) => {
        const app = hostRef.current;
        const current = sessionRef.current;
        if (!app || !current || busyAction) return;
        const key = `${item.id}:${action.id}`;
        if (action.confirmation && pendingAction !== key) {
            setPendingAction(key);
            return;
        }
        setPendingAction(undefined);
        setActionError(undefined);
        setBusyAction(key);
        try {
            const result = await app.callServerTool({
                name: "mcpapp_action",
                arguments: {
                    ctxId: current.ctxId,
                    itemId: item.id,
                    actionId: action.id,
                    requestId: crypto.randomUUID(),
                    ...(action.expectedRevision === undefined ? {} : { expectedRevision: action.expectedRevision }),
                },
            });
            if (result.isError) throw new Error("Workspace action was rejected.");
            const value = result.structuredContent as { status?: string } | undefined;
            if (sessionRef.current?.ctxId !== current.ctxId) return;
            const updated = await readMcpAppSnapshot(current, new AbortController().signal);
            if (sessionRef.current?.ctxId === current.ctxId) {
                setSnapshot(updated);
                if (value?.status === "stale")
                    setActionError("The previous action may have changed state; review the latest status before retrying.");
            }
        } catch (error) {
            if (sessionRef.current?.ctxId === current.ctxId)
                setActionError(error instanceof Error ? error.message : "Workspace action failed.");
        } finally {
            setBusyAction(undefined);
        }
    };

    return (
        <main className="workspace" data-status={status}>
            <header className="workspace-head">
                <span className="workspace-name">DevShell <span>Workspace</span></span>
                <span className="workspace-status" role="status">
                    <span className="workspace-indicator" aria-hidden="true" />
                    {status === "connected" ? "Connected" : status === "connecting" ? "Connecting" : "Disconnected"}
                </span>
            </header>
            <section className="workspace-content">
                <div className="workspace-emblem" aria-hidden="true">⌘</div>
                {snapshot ? <>
                    <h1>{snapshot.agentBusy ? "Workspace active" : "Workspace ready"}</h1>
                    <p>{snapshot.instance} · {snapshot.ctxId}</p>
                    <div className="workspace-items">
                        {actionError && <p role="alert">{actionError}</p>}
                        {snapshot.presentation.primary && <WorkspaceItem item={snapshot.presentation.primary} kind="decision" onAction={act} pendingAction={pendingAction} busyAction={busyAction} cancel={() => setPendingAction(undefined)} />}
                        {snapshot.presentation.work.map((item) => <WorkspaceItem key={item.id} item={item} kind="work" onAction={act} pendingAction={pendingAction} busyAction={busyAction} cancel={() => setPendingAction(undefined)} />)}
                        {snapshot.presentation.background.map((item) => <WorkspaceItem key={item.id} item={item} kind="background" />)}
                        {!snapshot.presentation.primary && snapshot.presentation.work.length === 0 && snapshot.presentation.background.length === 0 &&
                            <p>Nothing needs attention right now.</p>}
                    </div>
                </> : <>
                    <h1>{ctxId || session ? "Workspace connected" : "Waiting for workspace"}</h1>
                    <p>{liveError ?? (ctxId || session ? "Waiting for authorized workspace state." : "Connect a DevShell Context to view tasks, approvals, and background activity.")}</p>
                    {(ctxId || session?.ctxId) && <p className="workspace-context">Context · {ctxId ?? session?.ctxId}</p>}
                </>}
            </section>
            <footer className="workspace-foot">
                <span>portable-devshell</span>
                <span>{displayMode}</span>
            </footer>
        </main>
    );
}

function WorkspaceItem({ item, kind, onAction, pendingAction, busyAction, cancel }: {
    item: McpAppItem;
    kind: string;
    onAction?: (item: McpAppItem, action: NonNullable<McpAppItem["actions"]>[number]) => void;
    pendingAction?: string;
    busyAction?: string;
    cancel?: () => void;
}) {
    return <section className="workspace-item" data-kind={kind}>
        <div className="workspace-item-head"><strong>{item.title}</strong>{item.badge && <span>{item.badge}</span>}</div>
        {item.summary && <p>{item.summary}</p>}
        {item.detail && <p>{item.detail}</p>}
        {item.current && <p>{item.current}</p>}
        {item.note && <p>{item.note}</p>}
        {item.progress && <p>{item.progress.current} / {item.progress.total}</p>}
        {item.actions && item.actions.length > 0 && onAction && <div className="workspace-actions">
            {item.actions.map((action) => {
                const key = `${item.id}:${action.id}`;
                return <span key={key}>
                    <button type="button" disabled={busyAction !== undefined} onClick={() => onAction(item, action)}>
                        {pendingAction === key ? `Confirm ${action.label}` : busyAction === key ? "Applying…" : action.label}
                    </button>
                    {pendingAction === key && <button type="button" onClick={cancel}>Back</button>}
                </span>;
            })}
        </div>}
    </section>;
}
