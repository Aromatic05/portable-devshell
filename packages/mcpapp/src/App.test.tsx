import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({
    clients: [] as Array<{
        ontoolinput?: (input: { arguments?: Record<string, unknown> }) => void;
        onclose?: () => void;
    }>,
}));

vi.mock("@modelcontextprotocol/ext-apps/app-with-deps", () => ({
    App: class {
        ontoolinput?: (input: { arguments?: Record<string, unknown> }) => void;
        onclose?: () => void;
        constructor() { host.clients.push(this); }
        async connect() {}
        getHostContext() { return { displayMode: "inline" }; }
        setupSizeChangedNotifications() { return () => undefined; }
        async close() {}
    },
    applyDocumentTheme: vi.fn(),
    applyHostFonts: vi.fn(),
    applyHostStyleVariables: vi.fn(),
}));

import { AppView } from "./App.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    container?.remove();
    root = undefined;
    container = undefined;
    host.clients.length = 0;
});

test("connects to the MCP Apps host without manufacturing workspace state", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView />); });

    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("Waiting for workspace");
    expect(container.textContent).not.toContain("Approval required");

    await act(async () => {
        host.clients[0]?.ontoolinput?.({ arguments: { ctxId: "ctx-m1", token: "private-token" } });
    });
    expect(container.textContent).toContain("Context · ctx-m1");
    expect(container.textContent).not.toContain("private-token");

    await act(async () => { host.clients[0]?.onclose?.(); });
    expect(container.textContent).toContain("Disconnected");
});
