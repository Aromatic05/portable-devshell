import { useEffect, useState } from "react";

const key = "portable-devshell:mcpapp:toolcall-display:v1";
const eventName = "portable-devshell:mcpapp:toolcall-display";
// Show cards the Host has already provided by default. This does not enable
// server-side inlineToolCalls or control Workspace fullscreen presentation.
let fallback = true;

export function readToolCallDisplay(): boolean {
    try {
        const stored = window.localStorage.getItem(key);
        return stored === null ? fallback : stored !== "off";
    } catch {
        return fallback;
    }
}

export function writeToolCallDisplay(enabled: boolean): void {
    fallback = enabled;
    try { window.localStorage.setItem(key, enabled ? "on" : "off"); }
    catch { /* Sandboxed hosts may block persistent storage. */ }
    window.dispatchEvent(new Event(eventName));
}

/** Shares a user's presentation preference across the Workspace and inline cards.
 * This is browser presentation state, never Instance execution policy.
 */
export function useToolCallDisplay(): readonly [boolean, (enabled: boolean) => void] {
    const [enabled, setEnabled] = useState(readToolCallDisplay);
    useEffect(() => {
        const refresh = () => setEnabled(readToolCallDisplay());
        window.addEventListener("storage", refresh);
        window.addEventListener(eventName, refresh);
        return () => {
            window.removeEventListener("storage", refresh);
            window.removeEventListener(eventName, refresh);
        };
    }, []);
    return [enabled, writeToolCallDisplay] as const;
}
