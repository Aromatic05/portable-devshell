import {
    App,
    applyDocumentTheme,
    applyHostFonts,
    applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps/app-with-deps";
import { useEffect, useState } from "react";

declare const __MCPAPP_VERSION__: string;

type ConnectionStatus = "connecting" | "connected" | "disconnected";
type ConnectedApp = App & { onclose?: () => void; close(): Promise<void> };

export function AppView() {
    const [status, setStatus] = useState<ConnectionStatus>("connecting");
    const [ctxId, setCtxId] = useState<string>();
    const [displayMode, setDisplayMode] = useState("inline");

    useEffect(() => {
        const app = new App(
            { name: "portable-devshell-workspace", version: __MCPAPP_VERSION__ },
            { availableDisplayModes: ["inline", "pip", "fullscreen"] },
            { autoResize: true },
        ) as ConnectedApp;
        let active = true;
        let stopSize: (() => void) | undefined;
        app.onhostcontextchanged = (context) => {
            if (!active) return;
            if (context.theme === "light" || context.theme === "dark")
                applyDocumentTheme(context.theme);
            if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
            if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
            setDisplayMode(context.displayMode ?? "inline");
        };
        app.ontoolinput = (input) => {
            if (!active) return;
            const value = input.arguments as Record<string, unknown> | undefined;
            if (typeof value?.ctxId === "string") setCtxId(value.ctxId);
        };
        app.ontoolresult = (result) => {
            if (!active) return;
            const content = result.structuredContent as Record<string, unknown> | undefined;
            if (typeof content?.ctxId === "string") setCtxId(content.ctxId);
        };
        app.onclose = () => { if (active) setStatus("disconnected"); };
        app.onteardown = async () => { if (active) setStatus("disconnected"); return {}; };
        void app.connect().then(() => {
            if (!active) return;
            setDisplayMode(app.getHostContext()?.displayMode ?? "inline");
            setStatus("connected");
            stopSize = app.setupSizeChangedNotifications();
        }).catch(() => { if (active) setStatus("disconnected"); });
        return () => {
            active = false;
            stopSize?.();
            void app.close();
        };
    }, []);

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
                <h1>{ctxId ? "Workspace connected" : "Waiting for workspace"}</h1>
                <p>{ctxId ? "The MCP host has provided a Context. Workspace activity will appear here when the live state service is connected." : "The interface is available. Connect a DevShell Context to view tasks, approvals, and background activity."}</p>
                {ctxId && <p className="workspace-context" title={ctxId}>Context · {ctxId}</p>}
            </section>
            <footer className="workspace-foot">
                <span>portable-devshell</span>
                <span>{displayMode}</span>
            </footer>
        </main>
    );
}
