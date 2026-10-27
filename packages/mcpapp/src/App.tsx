import {
    App,
    applyDocumentTheme,
    applyHostFonts,
    applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps/app-with-deps";
import { useEffect, useRef, useState } from "react";
import { readMcpAppSnapshot, watchMcpApp, type McpAppItem, type McpAppSnapshot } from "./Connection.js";
import { clearMcpAppSession, hasMcpAppFullscreenClaim, readMcpAppSession, restoreMcpAppSession, saveMcpAppFullscreenClaim, saveMcpAppSession, type McpAppSession } from "./Session.js";
import { ToolCallInline } from "./ToolCallInline.js";
import { useToolCallDisplay } from "./Preferences.js";
import { WorkspaceDashboard } from "./Workspace.js";

declare const __MCPAPP_VERSION__: string;

type ConnectionStatus = "connecting" | "connected" | "disconnected";
type ConnectedApp = App & { onclose?: () => void; close(): Promise<void> };
export type McpAppViewKind = "workspace" | "interaction" | "toolcall";

export function AppView({ view = "workspace" }: { view?: McpAppViewKind } = {}) {
    return view === "toolcall" ? <ToolCallInline /> : <LiveAppView view={view} />;
}

function LiveAppView({ view }: { view: "workspace" | "interaction" }) {
    const [status, setStatus] = useState<ConnectionStatus>("connecting");
    const [ctxId, setCtxId] = useState<string>();
    const [displayMode, setDisplayMode] = useState("inline");
    const [fullscreenAvailable, setFullscreenAvailable] = useState(false);
    const fullscreenAttempted = useRef(new Set<string>());
    const [toolCallEnabled, setToolCallEnabled] = useToolCallDisplay();
    const [session, setSession] = useState<McpAppSession | undefined>(() => restoreMcpAppSession());
    const sessionRef = useRef(session);
    const contextRef = useRef(session?.ctxId);
    const sessionEpoch = useRef(0);
    const [epoch, setEpoch] = useState(0);
    const snapshotRef = useRef<McpAppSnapshot>();
    const revisionRef = useRef(-1);
    const actionRef = useRef<string>();
    const errorOwnerRef = useRef<object | string | symbol>();
    const closeRef = useRef<symbol>();
    const displayRequestRef = useRef<symbol>();
    const [fullscreenPending, setFullscreenPending] = useState(false);
    const [fullscreenError, setFullscreenError] = useState<string>();
    const [snapshot, setSnapshot] = useState<McpAppSnapshot>();
    const [liveError, setLiveError] = useState<string>();
    const [actionError, setActionError] = useState<string>();
    const [recoveryError, setRecoveryError] = useState<string>();
    const [pendingAction, setPendingAction] = useState<string>();
    const [busyAction, setBusyAction] = useState<string>();
    const [closeRequested, setCloseRequested] = useState(false);
    const hostRef = useRef<ConnectedApp>();
    const deliveredRecovery = useRef(new Set<string>());
    const recoveryAttempts = useRef(new Map<string, { epoch: number; cursor: number; active: boolean }>());

    const clearSnapshot = () => {
        snapshotRef.current = undefined;
        setSnapshot(undefined);
        setPendingAction(undefined);
    };
    const invalidateScope = () => {
        sessionEpoch.current++;
        setEpoch(sessionEpoch.current);
        revisionRef.current = -1;
        actionRef.current = undefined;
        errorOwnerRef.current = undefined;
        closeRef.current = undefined;
        displayRequestRef.current = undefined;
        setFullscreenPending(false);
        setFullscreenError(undefined);
        clearSnapshot();
        setBusyAction(undefined);
        setCloseRequested(false);
        setActionError(undefined);
        setRecoveryError(undefined);
        setLiveError(undefined);
    };
    const replaceSession = (next: McpAppSession | undefined, nextContext = next?.ctxId) => {
        const previous = sessionRef.current;
        if (contextRef.current === nextContext && previous?.ctxId === next?.ctxId &&
            previous?.token === next?.token && previous?.liveBaseUrl === next?.liveBaseUrl) return;
        invalidateScope();
        sessionRef.current = next;
        contextRef.current = nextContext;
        setCtxId(nextContext);
        setSession(next);
    };
    const currentScope = (app: ConnectedApp | undefined, capability = session) =>
        epoch === sessionEpoch.current && hostRef.current === app &&
        sessionRef.current === capability && (!capability || contextRef.current === capability.ctxId);
    const publishSnapshot = (app: ConnectedApp, capability: McpAppSession, next: McpAppSnapshot) => {
        if (!currentScope(app, capability) || next.ctxId !== capability.ctxId || next.cursor < revisionRef.current) return;
        if (next.cursor !== revisionRef.current) setPendingAction(undefined);
        revisionRef.current = next.cursor;
        snapshotRef.current = next;
        setSnapshot(next);
        setLiveError(undefined);
    };

    useEffect(() => {
        let active = true;
        const refreshGlobals = () => {
            if (!active) return;
            const found = restoreMcpAppSession();
            if (!found) return;
            replaceSession(found);
        };
        window.addEventListener("openai:set_globals", refreshGlobals);
        refreshGlobals();
        let stopSize: (() => void) | undefined;
        let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
        let currentApp: ConnectedApp | undefined;
        const retry = () => {
            if (!active || reconnectTimer !== undefined) return;
            invalidateScope();
            hostRef.current = undefined;
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
            setEpoch(sessionEpoch.current);
            setStatus("connecting");
            const app = new App(
                { name: "portable-devshell-" + view, version: __MCPAPP_VERSION__ },
                { availableDisplayModes: view === "workspace" ? ["fullscreen"] : ["inline"] },
                { autoResize: false },
            ) as ConnectedApp;
            currentApp = app;
            hostRef.current = app;
            app.onhostcontextchanged = (context) => {
                if (!active || currentApp !== app || hostRef.current !== app) return;
                if (context.theme === "light" || context.theme === "dark")
                    applyDocumentTheme(context.theme);
                if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
                if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
                const hostContext = app.getHostContext();
                setDisplayMode(hostContext?.displayMode ?? "inline");
                setFullscreenAvailable(hostContext?.availableDisplayModes?.includes("fullscreen") === true);
            };
            app.ontoolinput = (input) => {
                if (!active || currentApp !== app || hostRef.current !== app) return;
                const value = input.arguments as Record<string, unknown> | undefined;
                if (typeof value?.ctxId === "string") {
                    if (contextRef.current !== value.ctxId) {
                        replaceSession(undefined, value.ctxId);
                        clearMcpAppSession();
                    }
                    setCtxId(value.ctxId);
                }
            };
            app.ontoolresult = (result) => {
                if (!active || currentApp !== app || hostRef.current !== app) return;
                const nextSession = readMcpAppSession(result);
                if (nextSession) {
                    replaceSession(nextSession);
                    saveMcpAppSession(nextSession);
                    return;
                }
                const content = result.structuredContent as Record<string, unknown> | undefined;
                if (typeof content?.ctxId === "string") {
                    if (contextRef.current !== content.ctxId) {
                        replaceSession(undefined, content.ctxId);
                        clearMcpAppSession();
                    }
                    setCtxId(content.ctxId);
                }
            };
            // Host teardown is final for this view, not a connection error.
            const disconnect = () => {
                if (!active || currentApp !== app || hostRef.current !== app) return;
                invalidateScope();
                hostRef.current = undefined;
                setStatus("disconnected");
            };
            app.onclose = disconnect;
            app.onteardown = async () => { disconnect(); return {}; };
            void app.connect().then(() => {
                if (!active || currentApp !== app || hostRef.current !== app) return;
                const hostContext = app.getHostContext();
                setDisplayMode(hostContext?.displayMode ?? "inline");
                setFullscreenAvailable(hostContext?.availableDisplayModes?.includes("fullscreen") === true);
                refreshGlobals();
                setStatus("connected");
                stopSize = app.setupSizeChangedNotifications();
                // Ask has no result until answered. Only that interactive
                // view may need Host-assisted bootstrap; ordinary ToolCall
                // cards receive their capability in the original tool result.
                if (view === "interaction" && sessionRef.current === undefined) {
                    const bootstrapEpoch = sessionEpoch.current;
                    void app.callServerTool({ name: "mcpapp_open", arguments: {} }).then((result) => {
                        if (!active || currentApp !== app || hostRef.current !== app ||
                            sessionEpoch.current !== bootstrapEpoch) return;
                        if (result.isError) throw new Error("MCP App Context is unavailable.");
                        const capability = readMcpAppSession(result);
                        if (capability === undefined)
                            throw new Error("MCP App bootstrap returned no private Live capability.");
                        replaceSession(capability);
                        saveMcpAppSession(capability);
                    }).catch((error: unknown) => {
                        if (active && currentApp === app && hostRef.current === app &&
                            sessionEpoch.current === bootstrapEpoch)
                            setLiveError(error instanceof Error ? error.message : "MCP App bootstrap failed.");
                    });
                }
            }).catch(() => { if (currentApp === app) retry(); });
        };
        connect();
        return () => {
            active = false;
            sessionEpoch.current++;
            window.removeEventListener("openai:set_globals", refreshGlobals);
            if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
            stopSize?.();
            hostRef.current = undefined;
            void currentApp?.close();
        };
    }, [view]);

    useEffect(() => {
        if (view !== "workspace" || status !== "connected" || session === undefined ||
            !fullscreenAvailable || displayMode === "fullscreen") return;
        const app = hostRef.current;
        if (!app || !currentScope(app) || fullscreenAttempted.current.has(session.ctxId) ||
            hasMcpAppFullscreenClaim(session.ctxId)) return;
        // Only explicitly presented Workspaces may request fullscreen.
        void requestFullscreen();
    }, [view, session, status, epoch, fullscreenAvailable, displayMode]);

    useEffect(() => {
        if (session === undefined || status !== "connected") return;
        const app = hostRef.current;
        if (!app || !currentScope(app)) return;
        const controller = new AbortController();
        const current = () => !controller.signal.aborted && currentScope(app);
        void (async () => {
            let cursor: number | undefined;
            let retries = 0;
            while (current()) {
                try {
                    if (cursor === undefined) {
                        const first = await readMcpAppSnapshot(session, controller.signal);
                        if (!current()) return;
                        publishSnapshot(app, session, first);
                        cursor = Math.max(first.cursor, revisionRef.current);
                    }
                    const update = await watchMcpApp(session, cursor, controller.signal);
                    if (!current()) return;
                    if (update.snapshot) publishSnapshot(app, session, update.snapshot);
                    cursor = Math.max(cursor, update.cursor, revisionRef.current);
                    retries = 0;
                } catch (error) {
                    if (!current()) return;
                    const message = error instanceof Error ? error.message : "MCP App connection failed";
                    if (message === "MCP App authorization expired") {
                        replaceSession(undefined, contextRef.current);
                        clearMcpAppSession();
                        setLiveError(message);
                        return;
                    }
                    // A transient Watch failure is not a Context revocation.
                    // Retain the last snapshot for reading, but fence stale actions.
                    setPendingAction(undefined);
                    setLiveError(message);
                    cursor = undefined;
                    await new Promise<void>((resolve) => {
                        const delay = Math.min(1_000 * 2 ** Math.min(retries++, 4), 15_000);
                        const onAbort = () => { clearTimeout(timer); resolve(); };
                        const timer = setTimeout(() => {
                            controller.signal.removeEventListener("abort", onAbort);
                            resolve();
                        }, delay);
                        controller.signal.addEventListener("abort", onAbort, { once: true });
                    });
                }
            }
        })();
        return () => { controller.abort(); };
    }, [session, status, epoch]);

    // The server chooses recovery eligibility and persists the claim. React
    // only hands that intent to the MCP Host; it does not run a local scheduler.
    useEffect(() => {
        if (view !== "workspace" || status !== "connected" || liveError !== undefined || !snapshot || !session ||
            snapshot !== snapshotRef.current || snapshot.ctxId !== session.ctxId) return;
        const directive = snapshot.reentry?.directives?.find((item) =>
            item.intent === "goal-resume" || item.intent === "goal-retry");
        const schedule = snapshot.reentry?.schedule;
        const recovery = directive ?? (schedule ? {
            kind: "reentry" as const, intent: "automatic" as const,
            sourceId: schedule.sourceId,
        } : undefined);
        if (!recovery?.sourceId) return;
        const identity = recoveryIdentity(snapshot);
        const key = JSON.stringify([session.liveBaseUrl, session.ctxId, identity]);
        const previous = recoveryAttempts.current.get(key);
        if (deliveredRecovery.current.has(key) || (previous?.epoch === epoch &&
            (previous.active || previous.cursor >= snapshot.cursor))) return;
        const app = hostRef.current;
        if (!app || !currentScope(app)) return;
        const operation = { epoch, cursor: snapshot.cursor, active: true };
        recoveryAttempts.current.set(key, operation);
        // Recovery can be derived from Watch while its explicit action is
        // awaiting a refresh. Each operation retains its own error surface.
        const claimId = `mcpapp-${crypto.randomUUID()}`;
        const base = { ctxId: session.ctxId, claimId,
            intent: recovery.intent, sourceId: recovery.sourceId,
            ...(recovery.id === undefined ? {} : { directiveId: recovery.id }) };
        const current = () => currentScope(app) && recoveryAttempts.current.get(key) === operation &&
            recoveryIdentity(snapshotRef.current) === identity;
        const invoke = async (payload: Record<string, unknown>) => {
            const result = await app.callServerTool({ name: "mcpapp_reentry", arguments: { ...base, ...payload } });
            if (result.isError) throw new Error("Workspace recovery was rejected.");
            return (result.structuredContent ?? {}) as Record<string, unknown>;
        };
        void (async () => {
            let claimed = false;
            let attempted = false;
            let attemptUncertain = false;
            let outcome: "accepted" | "rejected" | "uncertain" = "uncertain";
            try {
                const claim = await invoke({ action: "claim", intent: recovery.intent, sourceId: recovery.sourceId });
                if (claim.claimed !== true) return;
                claimed = true;
                if (!current()) return;
                const validated = await invoke({ action: "validate" });
                if (validated.valid !== true || !current()) return;
                const delivery = claim.delivery as { message?: string; modelContext?: unknown } | undefined;
                if (typeof delivery?.message !== "string" || !delivery.modelContext ||
                    typeof delivery.modelContext !== "object")
                    throw new Error("Workspace recovery delivery is unavailable.");
                await app.updateModelContext(delivery.modelContext as Parameters<ConnectedApp["updateModelContext"]>[0]);
                if (!current()) return;
                // Once attempt is requested, an ambiguous transport result must
                // not cause this iframe to replay a potentially delivered intent.
                deliveredRecovery.current.add(key);
                attemptUncertain = true;
                const attempt = await invoke({ action: "attempt" });
                attemptUncertain = false;
                attempted = attempt.attempted === true;
                if (!attempted && attempt.duplicate !== true) deliveredRecovery.current.delete(key);
                if (!attempted || !current()) return;
                const sent = await app.sendMessage({
                    role: "user", content: [{ type: "text", text: delivery.message }],
                });
                outcome = sent?.isError ? "rejected" : "accepted";
                if (sent?.isError && current())
                    setRecoveryError("The Goal is active, but the Host rejected the continuation message. This message will not be sent again automatically. Continue the Goal from the conversation.");
                else if (current()) setRecoveryError(undefined);
            } catch (error) {
                if (current())
                    setRecoveryError(error instanceof Error ? error.message : "Workspace recovery failed.");
            } finally {
                if (claimed) {
                    try {
                        if (attempted || attemptUncertain) await invoke({ action: "report", outcome });
                        else await invoke({ action: "release" });
                    } catch {
                        // An uncertain send cannot be replayed blindly.
                    }
                }
                operation.active = false;
                if (currentScope(app) && recoveryAttempts.current.get(key) === operation) {
                    try {
                        const updated = await readMcpAppSnapshot(session, new AbortController().signal);
                        if (recoveryAttempts.current.get(key) === operation) publishSnapshot(app, session, updated);
                    } catch { /* Watch reconnects from authoritative state. */ }
                }
            }
        })();
    }, [snapshot, session, status, view, epoch, liveError]);

    const act = async (item: McpAppItem, action: NonNullable<McpAppItem["actions"]>[number]) => {
        const app = hostRef.current;
        if (!app || !session || !currentScope(app) || liveError !== undefined || !snapshot ||
            snapshot !== snapshotRef.current || actionRef.current) return;
        const key = actionKey(epoch, snapshot.cursor, item, action);
        if (action.confirmation && pendingAction !== key) {
            setPendingAction(key);
            return;
        }
        const operation = crypto.randomUUID();
        const current = () => currentScope(app) && actionRef.current === operation;
        actionRef.current = operation;
        errorOwnerRef.current = operation;
        setPendingAction(undefined);
        setActionError(undefined);
        setBusyAction(key);
        try {
            const result = await app.callServerTool({
                name: "mcpapp_action",
                arguments: {
                    ctxId: session.ctxId,
                    itemId: item.id,
                    actionId: action.id,
                    requestId: operation,
                    ...(action.expectedRevision === undefined ? {} : { expectedRevision: action.expectedRevision }),
                },
            });
            if (!current()) return;
            if (result.isError) throw new Error("Workspace action was rejected.");
            const value = result.structuredContent as { status?: string } | undefined;
            const updated = await readMcpAppSnapshot(session, new AbortController().signal);
            if (!current()) return;
            publishSnapshot(app, session, updated);
            if (value?.status === "stale" && errorOwnerRef.current === operation)
                setActionError("The previous action may have changed state; review the latest status before retrying.");
        } catch (error) {
            if (current() && errorOwnerRef.current === operation)
                setActionError(error instanceof Error ? error.message : "Workspace action failed.");
        } finally {
            if (current()) {
                actionRef.current = undefined;
                setBusyAction(undefined);
            }
        }
    };

    const requestFullscreen = async () => {
        const app = hostRef.current;
        if (view !== "workspace" || status !== "connected" || !app || !currentScope(app) ||
            !fullscreenAvailable || displayMode === "fullscreen" || displayRequestRef.current) return;
        const operation = Symbol();
        displayRequestRef.current = operation;
        setFullscreenPending(true);
        setFullscreenError(undefined);
        if (session) {
            fullscreenAttempted.current.add(session.ctxId);
            saveMcpAppFullscreenClaim(session.ctxId);
        }
        try {
            const result = await app.requestDisplayMode({ mode: "fullscreen" }, { timeout: 12_000 });
            if (!currentScope(app) || displayRequestRef.current !== operation) return;
            if (result?.mode === "fullscreen") setDisplayMode("fullscreen");
            else setFullscreenError("The Host declined fullscreen. You can try again.");
        } catch (error) {
            if (currentScope(app) && displayRequestRef.current === operation)
                setFullscreenError(error instanceof Error ? `Could not open fullscreen: ${error.message}` : "Could not open fullscreen. Try again.");
        } finally {
            if (currentScope(app) && displayRequestRef.current === operation) {
                displayRequestRef.current = undefined;
                setFullscreenPending(false);
            }
        }
    };

    const closeWorkspace = async () => {
        const app = hostRef.current;
        if (view !== "workspace" || !app || !currentScope(app) || closeRef.current) return;
        const operation = Symbol();
        closeRef.current = operation;
        errorOwnerRef.current = operation;
        if (session) saveMcpAppFullscreenClaim(session.ctxId);
        setCloseRequested(true);
        setActionError(undefined);
        try {
            // App.close() only closes the transport. The Host owns the window.
            await app.requestTeardown();
        } catch (error) {
            if (!currentScope(app) || closeRef.current !== operation) return;
            closeRef.current = undefined;
            setCloseRequested(false);
            if (errorOwnerRef.current === operation)
                setActionError(error instanceof Error ? error.message : "Could not close Workspace.");
        }
    };

    const authorizationExpired = liveError === "MCP App authorization expired";
    return (
        <main className="workspace" data-status={authorizationExpired ? "disconnected" : status} data-view={view} data-display-mode={displayMode}>
            <header className="workspace-head">
                <span className="workspace-name">DevShell <span>{view === "workspace" ? "Workspace" : view === "interaction" ? "Interaction" : "ToolCall"}</span></span>
                <span className="workspace-toolbar">
                    {view === "workspace" && <label className="workspace-setting" title="Only changes the display of cards already provided by the Host. Does not enable server Inline ToolCalls or change fullscreen.">
                        <input type="checkbox" checked={toolCallEnabled}
                            onChange={(event) => setToolCallEnabled(event.target.checked)} />
                        Show provided ToolCall cards
                    </label>}
                    {view === "workspace" && status === "connected" && fullscreenAvailable &&
                        displayMode !== "fullscreen" &&
                        <button type="button" disabled={fullscreenPending} onClick={() => { void requestFullscreen(); }}>
                            {fullscreenPending ? "Opening fullscreen…" : "Open fullscreen"}
                        </button>}
                    {view === "workspace" && <button type="button" aria-label="Close workspace"
                        disabled={closeRequested} onClick={() => { void closeWorkspace(); }}>
                        {closeRequested ? "Closing…" : "Close"}
                    </button>}
                    <span className="workspace-status" role="status">
                        <span className="workspace-indicator" aria-hidden="true" />
                        {authorizationExpired ? "Authorization expired" : status === "connected" && liveError !== undefined ? "Live reconnecting"
                            : status === "connected" ? "Connected" : status === "connecting" ? "Connecting" : "Disconnected"}
                    </span>
                </span>
            </header>
            <section className="workspace-content">
                {fullscreenError && <p className="workspace-notice" role="alert">{fullscreenError}</p>}
                {liveError !== undefined && snapshot && <p className="workspace-notice" role="status">
                    Live updates interrupted: {liveError}. Showing last known state; actions are paused until reconnect.
                </p>}
                {view === "interaction" ? <>
                    {snapshot ? <div className="workspace-items">
                        {actionError && <p role="alert">{actionError}</p>}
                        {recoveryError && <p role="alert">{recoveryError}</p>}
                        {snapshot.presentation.pendingApprovals !== undefined &&
                            snapshot.presentation.pendingApprovals > 1 &&
                            <p className="workspace-notice">Approval 1 of {snapshot.presentation.pendingApprovals}</p>}
                        {snapshot.presentation.primary && <WorkspaceItem item={snapshot.presentation.primary} kind="decision"
                            onAction={liveError === undefined && status === "connected" ? act : undefined}
                            epoch={epoch} cursor={snapshot.cursor} pendingAction={pendingAction} busyAction={busyAction}
                            cancel={() => setPendingAction(undefined)} />}
                        {snapshot.presentation.background.map((item) => <WorkspaceItem key={item.id} item={item} kind="background" />)}
                        {!snapshot.presentation.primary && snapshot.presentation.background.length === 0 &&
                            <p>No pending approval or wait.</p>}
                    </div> : <p>{liveError ?? "Waiting for interaction state…"}</p>}
                </> : snapshot ? <>
                    {actionError && <p role="alert">{actionError}</p>}
                    {recoveryError && <p role="alert">{recoveryError}</p>}
                    <WorkspaceDashboard key={snapshot.ctxId} snapshot={snapshot} session={session}
                        renderItem={(item, kind) => <WorkspaceItem item={item} kind={kind}
                            onAction={kind === "background" || liveError !== undefined || status !== "connected" ? undefined : act}
                            epoch={epoch} cursor={snapshot.cursor} pendingAction={pendingAction} busyAction={busyAction}
                            cancel={() => setPendingAction(undefined)} />} />
                </> : <div className="workspace-landing">
                    <h1>{authorizationExpired ? "Workspace authorization expired" : ctxId || session ? "Workspace connected" : "Waiting for workspace"}</h1>
                    <p>{authorizationExpired ? "MCP App authorization expired. Reopen Workspace from the active DevShell Context to obtain fresh authorization." : liveError ?? (ctxId || session ? "Waiting for authorized workspace state." : "Open an active DevShell Context to inspect its Tasks, Goals and background activity.")}</p>
                    {(ctxId || session?.ctxId) && <p className="workspace-context">Context · {ctxId ?? session?.ctxId}</p>}
                </div>}
            </section>
            {view === "workspace" && <footer className="workspace-foot">
                <span>portable-devshell</span>
                <span>{displayMode}</span>
            </footer>}
        </main>
    );
}

function WorkspaceItem({ item, kind, onAction, epoch = 0, cursor = 0, pendingAction, busyAction, cancel }: {
    item: McpAppItem;
    kind: string;
    epoch?: number;
    cursor?: number;
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
                const key = actionKey(epoch, cursor, item, action);
                // Snapshot changes revoke confirmation without replacing the
                // focused action's DOM node.
                return <span key={JSON.stringify([item.id, action.id])}>
                    <button type="button" disabled={busyAction !== undefined} onClick={() => onAction(item, action)}>
                        {pendingAction === key ? `Confirm ${action.label}` : busyAction === key ? "Applying…" : action.label}
                    </button>
                    {pendingAction === key && <button type="button" onClick={cancel}>Back</button>}
                </span>;
            })}
        </div>}
    </section>;
}

function actionKey(epoch: number, cursor: number, item: McpAppItem, action: NonNullable<McpAppItem["actions"]>[number]) {
    return JSON.stringify([epoch, cursor, item.id, action]);
}

function recoveryIdentity(snapshot: McpAppSnapshot | undefined) {
    const directive = snapshot?.reentry?.directives?.find((item) =>
        item.intent === "goal-resume" || item.intent === "goal-retry");
    const schedule = snapshot?.reentry?.schedule;
    if (directive) return JSON.stringify([directive.id, directive.intent, directive.sourceId]);
    if (schedule) return JSON.stringify([undefined, "automatic", schedule.sourceId, schedule.readyAt]);
    return undefined;
}
