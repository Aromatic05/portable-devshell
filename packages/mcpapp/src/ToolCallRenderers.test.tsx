import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { ToolCallCard, readToolCallResult, restoreToolCallResult } from "./ToolCall.js";
import type { ToolCallResult } from "./ToolCallModel.js";
import { WorkspaceDashboard } from "./Workspace.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement | undefined;
const originalFetch = globalThis.fetch;

async function display(result: ToolCallResult, input?: unknown) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<ToolCallCard input={input} result={result} />); });
    const summary = container.querySelector<HTMLButtonElement>(".toolcall-compact");
    expect(summary?.getAttribute("aria-expanded")).toBe("false");
    expect(summary?.children).toHaveLength(2);
    expect(container.querySelector(".toolcall-expanded")).toBeNull();
    await act(async () => { summary?.click(); });
    expect(summary?.getAttribute("aria-expanded")).toBe("true");
    return container;
}

afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    container?.remove();
    root = undefined;
    container = undefined;
    globalThis.fetch = originalFetch;
});

test("bash_run expands as a real terminal with exit code, ANSI colors and distinct stderr", async () => {
    const view = await display({ name: "bash_run", isError: false, output: {
        exitCode: 0, durationMs: 15, stdout: "\u001b[32mready\u001b[0m\n", stderr: "warning\n",
    } }, { command: "git status --short", cwd: "./src" });
    expect(view.querySelectorAll(".tc-terminal")).toHaveLength(2);
    expect(view.querySelector(".tc-command")?.textContent).toContain("git status --short");
    expect(view.querySelector(".tc-stats")?.textContent).toContain("Exit0");
    expect(view.querySelector('[data-ansi="32"]')?.textContent).toBe("ready");
    expect(view.querySelectorAll(".tc-terminal-heading")[1]?.textContent).toBe("stderr");
    expect(view.querySelector(".toolcall-result-text")).toBeNull();
});

test("Activity displays every loaded terminal character while ordinary Inline remains compact", async () => {
    const fullOutput = "BEGIN\n" + "x".repeat(25_000) + "\nEND";
    let view = await display({ name: "bash_run", isError: false,
        output: { stdout: fullOutput, activityRetained: true } });
    expect(view.querySelector(".tc-terminal pre")?.textContent).toBe(fullOutput);
    expect(view.textContent).not.toContain("Showing recent output only");
    await act(async () => { root?.unmount(); root = undefined; });
    container?.remove();
    view = await display({ name: "bash_run", isError: false, output: { stdout: fullOutput } });
    expect(view.querySelector(".tc-terminal pre")?.textContent).not.toContain("BEGIN");
    expect(view.querySelector(".tc-terminal pre")?.textContent).toContain("END");
    expect(view.textContent).toContain("Showing recent output only");
});

test("file_read displays numbered code, supports metadata, and does not JSON-escape content", async () => {
    const view = await display({ name: "file_read", isError: false, output: {
        files: [{ path: "./src/App.ts", view: "content", content: "9:const state = true;\n10:export default state;" },
            { path: "./missing.txt", view: "metadata", metadata: { exists: false } }],
    } }, { files: [{ path: "./src/App.ts" }, { path: "./missing.txt" }] });
    expect(view.querySelectorAll(".tc-file")).toHaveLength(2);
    expect(view.querySelectorAll(".tc-gutter")[0]?.textContent).toBe("9");
    expect(view.querySelector(".tc-syntax-keyword")?.textContent).toBe("const");
    expect(view.querySelector(".tc-fields")?.textContent).toContain("existsfalse");
    expect(view.textContent).not.toContain('"files":');
});

test("file_grep highlights matching lines while file_glob creates a navigable file tree", async () => {
    let view = await display({ name: "file_grep", isError: false, output: {
        files: [{ path: "./src/app.ts", content: "*14:needle here\n 15:context", truncated: true, nextLine: 18 }],
        nextCursor: "opaque-pagination-cursor",
    } }, { pattern: "needle", paths: ["./src"], syntax: "literal" });
    expect(view.querySelector(".tc-code-line[data-match='true'] mark")?.textContent).toBe("needle");
    expect(view.textContent).toContain("More matches after line 18");
    await act(async () => { root?.unmount(); root = undefined; });
    container?.remove();
    view = await display({ name: "file_glob", isError: false, output: {
        entries: [{ path: "./src/app.ts", type: "file" },
            { path: "./src/utils.ts", type: "file" },
            { path: "./docs", type: "directory" }],
    } }, { patterns: ["src/**/*.ts"] });
    expect(view.querySelector(".tc-tree summary")?.textContent).toContain("src");
    expect(view.querySelector(".tc-tree-file")?.textContent).toContain("app.ts");
    expect(view.querySelectorAll(".tc-tree li").length).toBeGreaterThanOrEqual(3);
});

test("file_edit shows actual diff lines and partial-failure status without manufacturing missing diffs", async () => {
    const view = await display({ name: "file_edit", isError: false, output: {
        operations: [{ action: "patch", path: "./src/app.ts", status: "applied",
            addedLines: 1, removedLines: 1, diff: "@@\n-old\n+new\n" },
        { action: "move", path: "./src/other.ts", status: "failed",
            error: { code: "file.revisionMismatch", message: "File changed since read" } }],
    } });
    expect(view.querySelector(".toolcall-line")?.textContent).toContain("Partial failure");
    expect(view.querySelector(".tc-diff-line[data-kind='added']")?.textContent).toContain("+new");
    expect(view.querySelector(".tc-diff-line[data-kind='removed']")?.textContent).toContain("-old");
    expect(view.textContent).toContain("File changed since read");
    expect(view.querySelectorAll(".tc-edit-operation")).toHaveLength(2);
});

test("tmux_run and tmux_inspect use tasks, panes, transcript and wait semantics", async () => {
    let view = await display({ name: "tmux_run", isError: false, output: {
        task: { id: "task-17", status: "running" }, pane: { id: "pane-1", name: "build" },
        output: ["building...\n"], timedOut: true,
    } }, { command: "pnpm build", wait: "block" });
    expect(view.querySelector(".toolcall-line")?.textContent).toContain("Running");
    expect(view.querySelector(".tc-terminal pre")?.textContent).toContain("building...");
    expect(view.textContent).toContain("wait timed out");
    await act(async () => { root?.unmount(); root = undefined; });
    container?.remove();
    view = await display({ name: "tmux_inspect", isError: false, output: {
        panes: [{ id: "pane-1", name: "editor", status: "ready", cwd: "/repo",
            lines: ["$ vim main.rs", "-- INSERT --"] }],
    } });
    expect(view.querySelector(".tc-pane .tc-terminal pre")?.textContent).toContain("INSERT");
    expect(view.textContent).toContain("/repo");
});

test("todo_write presents progress, actionable task states and Checkpoint", async () => {
    const view = await display({ name: "todo_write", isError: false, output: {
        title: "MCP App renderer", revision: 2, summary: { completed: 1, total: 3 },
        items: [{ id: "a", content: "Inspect source", status: "completed" },
            { id: "b", content: "Implement viewer", status: "in_progress" },
            { id: "c", content: "Run testspace", status: "pending" }],
        checkpoint: { summary: "Core UI is built", next: "Test each tool" },
    } });
    expect(view.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("1");
    expect(view.querySelectorAll(".tc-todo-list li")).toHaveLength(3);
    expect(view.querySelector('.tc-todo-list li[data-state="in_progress"]')?.textContent)
        .toContain("Implement viewer");
    expect(view.textContent).toContain("Core UI is built");
});

test("artifact_viewImage renders the standard MCP mimeType image without copying it into widget metadata", async () => {
    const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+uCPEAAAAASUVORK5CYII=";
    const widget = { schema: "portable-devshell.toolcall.v1", toolName: "artifact_viewImage",
        isError: false, output: { name: "icon.png", mediaType: "image/png", bytes: 68 } };
    const native = {
        _meta: { "portable-devshell/toolcall": { name: "artifact_viewImage" },
            "portable-devshell/widgetPayload": widget },
        structuredContent: { name: "icon.png", mediaType: "image/png", bytes: 68 },
        content: [{ type: "image", mimeType: "image/png", data: imageData }],
    };
    const result = readToolCallResult(native);
    expect(result?.image?.src).toContain("data:image/png;base64,");
    expect(restoreToolCallResult({ toolResponseMetadata: {
        ...native._meta, mcp_tool_result: native,
    } })?.image?.src).toContain(imageData);
    const view = await display(result!);
    expect(view.querySelector("img")?.getAttribute("src")).toContain(imageData);
    expect(view.querySelector("figcaption")?.textContent).toBe("icon.png");
});

test("Activity fetches an audited image only after expanding its card", async () => {
    const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+uCPEAAAAASUVORK5CYII=";
    const fetchImage = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://devshell.example/api/live/demo/workspace/image?callId=image-a&ctxId=ctx-a");
        expect(init.headers).toEqual({ Authorization: "Bearer private-image-lease" });
        return { ok: true, json: async () => ({
            imageRef: "stored.png", mediaType: "image/png", encoding: "base64",
            bytes: 68, content: imageData,
        }) } as Response;
    });
    globalThis.fetch = fetchImage as unknown as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<WorkspaceDashboard
        renderItem={() => null}
        session={{ ctxId: "ctx-a", token: "private-image-lease",
            liveBaseUrl: "https://devshell.example/api/live/demo/workspace" }}
        snapshot={{
            ctxId: "ctx-a", instance: "demo", cursor: 1, agentBusy: false,
            presentation: { work: [], background: [] },
            activity: [{ callId: "image-a", name: "artifact_viewImage", state: "completed",
                at: "2026-10-14T07:08:36Z",
                output: { imageRef: "stored.png", name: "map-marker-pending.png",
                    mediaType: "image/png", bytes: 68 } }],
        }}
    />); });
    await act(async () => { Array.from(container!.querySelectorAll(".dashboard-tabs button"))
        .find((entry) => entry.textContent === "Activity")?.dispatchEvent(
            new MouseEvent("click", { bubbles: true })); });
    expect(fetchImage).not.toHaveBeenCalled();
    await act(async () => {
        container!.querySelector<HTMLButtonElement>(".dashboard-timeline .toolcall-compact")?.click();
        await Promise.resolve();
    });
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLImageElement>(".tc-image img")?.src)
        .toBe(`data:image/png;base64,${imageData}`);
    expect(container.textContent).not.toContain("This audit view retains metadata");
});

test("unknown tools show human-readable fields; the optional raw view also redacts secrets", async () => {
    const view = await display({ name: "custom_plugin", isError: false, output: {
        completed: true, result: { apiKey: "very-private-token", label: "scan complete" },
    } });
    expect(view.querySelector(".tc-fields")?.textContent).toContain("scan complete");
    expect(view.querySelector(".tc-technical summary")?.textContent).toContain("debugging only");
    expect(view.textContent).not.toContain("very-private-token");
    expect(view.querySelector(".tc-technical pre")?.textContent).toContain("[redacted]");
});

test("Workspace shows only the latest plan per Task, while preserving older audited revisions on demand", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<WorkspaceDashboard renderItem={() => null} snapshot={{
        ctxId: "ctx-a", instance: "demo", cursor: 10, agentBusy: false,
        presentation: { work: [], background: [] },
        activity: [
            { callId: "new", name: "todo_write", taskId: "plan-1", state: "completed",
                at: "2026-10-13T12:03:00Z", output: { taskId: "plan-1", title: "Build UI",
                    items: [{ content: "Build UI", status: "completed" }],
                    summary: { completed: 1, total: 1 } } },
            { callId: "old", name: "todo_write", taskId: "plan-1", state: "completed",
                at: "2026-10-13T12:01:00Z", output: { taskId: "plan-1", title: "Build UI",
                    items: [{ content: "Build UI", status: "in_progress" }],
                    summary: { completed: 0, total: 1 } } },
            { callId: "other", name: "todo_write", taskId: "plan-2", state: "completed",
                at: "2026-10-13T12:00:00Z", output: { taskId: "plan-2", title: "Run tests",
                    items: [], summary: { completed: 0, total: 0 } } },
        ],
    }} />); });
    await act(async () => { Array.from(container!.querySelectorAll(".dashboard-tabs button"))
        .find((button) => button.textContent === "Activity")?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.querySelectorAll(".dashboard-timeline > li")).toHaveLength(2);
    const entries = container.querySelectorAll<HTMLButtonElement>(".dashboard-timeline .toolcall-compact");
    await act(async () => { entries[0]?.click(); });
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("1");
    const internal = Array.from(container.querySelectorAll(".workspace-setting"))
        .find((node) => node.textContent?.includes("Include polling"))?.querySelector<HTMLInputElement>("input");
    await act(async () => { internal?.click(); });
    expect(container.querySelectorAll(".dashboard-timeline > li")).toHaveLength(3);
});
