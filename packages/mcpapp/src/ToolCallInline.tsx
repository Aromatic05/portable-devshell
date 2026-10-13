import { useEffect, useState } from "react";
import { useToolCallDisplay } from "./Preferences.js";
import { ToolCallCard, readToolCallResult, restoreToolCallResult, type ToolCallResult } from "./ToolCall.js";

declare const __MCPAPP_VERSION__: string;

/** A tool result is immutable. It must not subscribe to the Context's live
 * Workspace or render unrelated approvals, waits or task output. */
export function ToolCallInline() {
    const [input, setInput] = useState<unknown>(() => restoreToolInput());
    const [result, setResult] = useState<ToolCallResult | undefined>(restoreToolCallResult);
    const [enabled, setEnabled] = useToolCallDisplay();

    useEffect(() => {
        let active = true;
        let closeSdk: (() => void) | undefined;
        let stopSize: (() => void) | undefined;
        const refresh = () => {
            if (!active) return;
            const restored = restoreToolCallResult();
            if (restored) setResult(restored);
            const restoredInput = restoreToolInput();
            if (restoredInput !== undefined) setInput(restoredInput);
        };
        window.addEventListener("openai:set_globals", refresh);
        // ChatGPT exposes the immutable Tool Result as Widget globals. No
        // MCP SDK, Context bearer or Live HTTP stream is needed to show it.
        const fromHost = (event: MessageEvent) => {
            if (!active || event.source !== window.parent) return;
            const message = record(event.data);
            const params = record(message?.params);
            if (message?.method === "ui/notifications/tool-input" && params)
                setInput(params.arguments);
            if (message?.method === "ui/notifications/tool-result" && params) {
                const next = readToolCallResult(params);
                if (next) setResult(next);
                refresh();
            }
        };
        window.addEventListener("message", fromHost);
        refresh();
        // Other MCP Hosts may omit ChatGPT globals. In that case use the
        // standard protocol, but lazy-load the SDK instead of bundling it with
        // every high-frequency ToolCall card.
        if (!(window as Window & { openai?: unknown }).openai) {
            void import("@modelcontextprotocol/ext-apps/app-with-deps").then((sdk) => {
                if (!active) return;
                const app = new sdk.App(
                    { name: "portable-devshell-toolcall", version: __MCPAPP_VERSION__ },
                    { availableDisplayModes: ["inline"] },
                    { autoResize: false },
                );
                closeSdk = () => { void (app as typeof app & { close(): Promise<void> }).close(); };
                const theme = () => {
                    const context = app.getHostContext();
                    if (context?.theme === "light" || context?.theme === "dark")
                        sdk.applyDocumentTheme(context.theme);
                    if (context?.styles?.variables) sdk.applyHostStyleVariables(context.styles.variables);
                    if (context?.styles?.css?.fonts) sdk.applyHostFonts(context.styles.css.fonts);
                };
                app.onhostcontextchanged = theme;
                app.ontoolinput = (value) => { if (active) setInput(value.arguments); };
                app.ontoolresult = (value) => {
                    if (!active) return;
                    const next = readToolCallResult(value);
                    if (next) setResult(next);
                };
                void app.connect().then(() => {
                    if (!active) return;
                    theme();
                    stopSize = app.setupSizeChangedNotifications();
                }).catch(() => { /* Static result rendering remains available. */ });
            }).catch(() => { /* Do not remount or retry this static result. */ });
        }
        return () => {
            active = false;
            stopSize?.();
            window.removeEventListener("openai:set_globals", refresh);
            window.removeEventListener("message", fromHost);
            closeSdk?.();
        };
    }, []);

    return <ToolCallCard input={input} result={result}
        enabled={enabled} onEnabledChange={setEnabled} />;
}

function restoreToolInput(): unknown {
    const openai = (window as Window & { openai?: { toolInput?: unknown } }).openai;
    return openai?.toolInput;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}
