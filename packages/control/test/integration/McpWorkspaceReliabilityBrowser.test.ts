import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { chromium, type Browser } from "playwright";

import { workspaceAppHtml } from "@portable-devshell/mcp/testing";
import { chromiumTestOptions } from "../../../../test/TestPlatformSupport.ts";

const CHROMIUM_EXECUTABLE = resolveChromiumExecutable();
const BROWSER_TEST_OPTIONS = chromiumTestOptions(CHROMIUM_EXECUTABLE);

test("Live Workspace requests PiP and uses direct state transport before MCP fallbacks", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    await page.evaluate(LIVE_TRANSPORT_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html.replace("<script>", `<script>
            window.__liveFetchCalls = [];
            window.__liveWatchReplied = false;
            window.fetch = function (url, options) {
                window.__liveFetchCalls.push({
                    authorization: options && options.headers && options.headers.Authorization,
                    url: String(url)
                });
                var snapshot = {
                    approvals: [], background: [], ctxId: "ctx-live-direct", currentEvent: null,
                    cursor: 7, goal: null, instance: "browser-instance", questions: [], tasks: []
                };
                if (String(url).indexOf("/snapshot") >= 0) {
                    return Promise.resolve(new Response(JSON.stringify(snapshot), {
                        headers: { "content-type": "application/json" }, status: 200
                    }));
                }
                if (!window.__liveWatchReplied) {
                    window.__liveWatchReplied = true;
                    return Promise.resolve(new Response(JSON.stringify({
                        changed: false, cursor: 7, snapshot: snapshot
                    }), { headers: { "content-type": "application/json" }, status: 200 }));
                }
                return new Promise(function (_resolve, reject) {
                    if (options && options.signal) {
                        options.signal.addEventListener("abort", function () {
                            reject(new DOMException("Aborted", "AbortError"));
                        }, { once: true });
                    }
                });
            };
        <\/script><script>`);
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__liveDisplayModeRequests || []).length === 1");
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (frame === undefined) throw new Error("Workspace frame is missing.");
    await frame.waitForFunction("(window.__liveFetchCalls || []).some(call => call.url.includes('/snapshot'))");
    await frame.waitForFunction("(window.__liveFetchCalls || []).some(call => call.url.includes('/watch'))");

    assert.deepEqual(await page.evaluate("window.__liveDisplayModeRequests"), [{ mode: "pip" }]);
    const fetchCalls = await frame.evaluate("window.__liveFetchCalls") as Array<{ authorization?: string; url: string }>;
    assert.equal(fetchCalls.every((call) => call.authorization === "Bearer live-direct-token"), true);
    assert.equal(fetchCalls.some((call) => call.url.includes("ctxId=ctx-live-direct")), true);
    assert.equal(
        await page.evaluate("(window.__liveToolCalls || []).some(call => call.name === 'workspace_snapshot' || call.name === 'workspace_watch' || call.name === 'workspace_reconnect')"),
        false,
    );
    await frame.evaluate(() => {
        window.dispatchEvent(new CustomEvent("openai:set_globals", {
            detail: {
                globals: {
                    toolOutput: { ctxId: "ctx-stale", instance: "browser-instance" },
                    toolResponseMetadata: {
                        mcp_tool_result: {
                            _meta: { "portable-devshell/workspace": {
                                liveBaseUrl: "https://stale.example/api/live/demo/workspace",
                                token: "stale-token",
                            } },
                            structuredContent: { ctxId: "ctx-stale", instance: "browser-instance" },
                        },
                    },
                },
            },
        }));
    });
    await page.waitForTimeout(100);
    const afterStaleResult = await frame.evaluate("window.__liveFetchCalls") as Array<{ authorization?: string; url: string }>;
    assert.equal(afterStaleResult.some((call) => call.url.includes("ctxId=ctx-stale")), false);
    assert.equal(afterStaleResult.some((call) => call.authorization === "Bearer stale-token"), false);
});

test("Live Workspace reclaims PiP presentation after its iframe is refreshed", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    const bridge = LIVE_TRANSPORT_BRIDGE_SCRIPT
        .replace(
            "window.__liveDisplayModeRequests = [];",
            'window.__liveDisplayModeRequests = []; window.__liveHostDisplayMode = "inline";',
        )
        .replace('displayMode: "inline"', "displayMode: window.__liveHostDisplayMode")
        .replace(
            "window.__liveDisplayModeRequests.push(message.params);",
            'window.__liveDisplayModeRequests.push(message.params); window.__liveHostDisplayMode = "pip";',
        );
    await page.evaluate(bridge);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__liveDisplayModeRequests || []).length === 1");
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (frame === undefined) throw new Error("Workspace frame is missing.");
    await frame.evaluate(() => window.location.reload());

    await page.waitForFunction("(window.__liveDisplayModeRequests || []).length === 2");
    assert.equal(await page.evaluate("window.__liveHostDisplayMode"), "pip");
});

test("Live Workspace completes its initial PiP claim when Host capabilities arrive late", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    const bridge = LIVE_TRANSPORT_BRIDGE_SCRIPT.replace(
        'hostContext: { availableDisplayModes: ["inline", "pip"], displayMode: "inline" },',
        'hostContext: { displayMode: "inline" },',
    );
    await page.evaluate(bridge);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await page.waitForTimeout(100);
    assert.equal(await page.evaluate("(window.__liveDisplayModeRequests || []).length"), 0);
    await page.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe?.contentWindow === null || iframe?.contentWindow === undefined) throw new Error("Workspace frame is missing.");
        iframe.contentWindow.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/host-context-changed",
            params: { availableDisplayModes: ["inline", "pip"] },
        }, "*");
    });
    await page.waitForFunction("(window.__liveDisplayModeRequests || []).length === 1");
});

test("Live Workspace retries a temporary inline result during the initial PiP claim", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    const bridge = LIVE_TRANSPORT_BRIDGE_SCRIPT.replace(
        'reply({ mode: "pip" });',
        'window.__displayClaimAttempt = (window.__displayClaimAttempt || 0) + 1; reply({ mode: window.__displayClaimAttempt === 1 ? "inline" : "pip" });',
    );
    await page.evaluate(bridge);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html.replace("var DISPLAY_MODE_RETRY_MS = 750;", "var DISPLAY_MODE_RETRY_MS = 20;");
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__liveDisplayModeRequests || []).length >= 2");
});

test("Live Workspace leaves later Host display-mode changes under user control", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    const bridge = LIVE_TRANSPORT_BRIDGE_SCRIPT.replace(
        'reply({ mode: "pip" });',
        'reply({ mode: "pip" }); source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: "pip" } }, "*");',
    );
    await page.evaluate(bridge);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__liveDisplayModeRequests || []).length === 1");
    await page.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe?.contentWindow === null || iframe?.contentWindow === undefined) throw new Error("Workspace frame is missing.");
        iframe.contentWindow.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/host-context-changed",
            params: { displayMode: "inline" },
        }, "*");
    });
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate("(window.__liveDisplayModeRequests || []).length"), 1);
});

test("Live Workspace initialization does not depend on a display-mode response", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    const bridge = LIVE_TRANSPORT_BRIDGE_SCRIPT
        .replace('reply({ mode: "pip" });', "return;")
        .replace('liveBaseUrl: "https://live.example/api/live/demo/workspace",', "");
    await page.evaluate(bridge);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__liveDisplayModeRequests || []).length === 1");
    await page.waitForFunction("(window.__liveToolCalls || []).some(call => call.name === 'workspace_snapshot')");
});

test("Live Workspace retries a transient Host initialization failure", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    const bridge = LIVE_TRANSPORT_BRIDGE_SCRIPT.replace(
        'if (message.method === "ui/initialize") {',
        'if (message.method === "ui/initialize") { window.__liveInitializeCount = (window.__liveInitializeCount || 0) + 1; if (window.__liveInitializeCount === 1) return;',
    );
    await page.evaluate(bridge);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html
            .replace("var HOST_CONNECT_TIMEOUT_MS = 3000;", "var HOST_CONNECT_TIMEOUT_MS = 50;")
            .replace("var LIVE_START_RETRY_MS = 1000;", "var LIVE_START_RETRY_MS = 50;");
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__liveInitializeCount || 0) >= 2");
    await page.waitForFunction("(window.__liveDisplayModeRequests || []).length >= 1");
});

test("Live Workspace retries a transient initial snapshot failure", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    const bridge = LIVE_TRANSPORT_BRIDGE_SCRIPT
        .replace('liveBaseUrl: "https://live.example/api/live/demo/workspace",', "")
        .replace(
            "window.__liveToolCalls.push(message.params || {});",
            'window.__liveToolCalls.push(message.params || {}); if (message.params && message.params.name === "workspace_snapshot") { window.__liveSnapshotCallCount = (window.__liveSnapshotCallCount || 0) + 1; if (window.__liveSnapshotCallCount === 1) { source.postMessage({ id: message.id, jsonrpc: "2.0", error: { code: -32603, message: "transient snapshot failure" } }, "*"); return; } }',
        );
    await page.evaluate(bridge);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html.replace("var LIVE_START_RETRY_MS = 1000;", "var LIVE_START_RETRY_MS = 50;");
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__liveSnapshotCallCount || 0) >= 2");
});

test("Live Workspace re-handshakes after an established Host bridge stops answering", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    const bridge = LIVE_TRANSPORT_BRIDGE_SCRIPT
        .replace('liveBaseUrl: "https://live.example/api/live/demo/workspace",', "")
        .replace(
            'if (message.method === "ui/initialize") {',
            'if (message.method === "ui/initialize") { window.__bridgeInitializeCount = (window.__bridgeInitializeCount || 0) + 1;',
        )
        .replace(
            "window.__liveToolCalls.push(message.params || {});",
            'window.__liveToolCalls.push(message.params || {}); if (message.params && message.params.name === "workspace_watch") { window.__bridgeWatchCount = (window.__bridgeWatchCount || 0) + 1; if (window.__bridgeWatchCount === 1) return; }',
        );
    await page.evaluate(bridge);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html
            .replace("var APP_TOOL_TIMEOUT_MS = 30000;", "var APP_TOOL_TIMEOUT_MS = 50;")
            .replace("var LIVE_START_RETRY_MS = 1000;", "var LIVE_START_RETRY_MS = 50;");
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__bridgeWatchCount || 0) >= 1");
    await page.waitForFunction("(window.__bridgeInitializeCount || 0) >= 2");
    await page.waitForFunction("(window.__liveToolCalls || []).some(call => call.name === 'workspace_reconnect')");
});

test("Live Workspace re-handshakes when Host model-context delivery stalls", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    const bridge = LIVE_TRANSPORT_BRIDGE_SCRIPT
        .replace('liveBaseUrl: "https://live.example/api/live/demo/workspace",', "")
        .replace(
            'if (message.method === "ui/initialize") {',
            'if (message.method === "ui/initialize") { window.__contextBridgeInitializeCount = (window.__contextBridgeInitializeCount || 0) + 1;',
        )
        .replace(
            'if (message.method === "ui/update-model-context") { reply({}); return; }',
            'if (message.method === "ui/update-model-context") { window.__contextUpdateCount = (window.__contextUpdateCount || 0) + 1; if (window.__contextUpdateCount === 1) return; reply({}); return; }',
        );
    await page.evaluate(bridge);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html
            .replace("var HOST_REQUEST_TIMEOUT_MS = 5000;", "var HOST_REQUEST_TIMEOUT_MS = 50;")
            .replace("var LIVE_START_RETRY_MS = 1000;", "var LIVE_START_RETRY_MS = 50;");
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__contextUpdateCount || 0) >= 1");
    await page.waitForFunction("(window.__contextBridgeInitializeCount || 0) >= 2");
    await page.waitForFunction("(window.__contextUpdateCount || 0) >= 2");
});

test("Workspace does not let an older concurrent snapshot overwrite a newer action refresh", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    await page.evaluate(ORDERING_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    await app.locator('[data-task-control="pause"][data-task-id="task-order-1"]').waitFor({ state: "visible" });
    await app.locator('[data-task-control="pause"][data-task-id="task-order-2"]').waitFor({ state: "visible" });

    await app.locator('[data-task-control="pause"][data-task-id="task-order-1"]').click();
    await page.waitForFunction("(window.__orderingSnapshotCount || 0) >= 2");
    await app.locator('[data-task-control="pause"][data-task-id="task-order-2"]').click();
    await page.waitForFunction("(window.__orderingSnapshotCount || 0) >= 3");
    await page.waitForTimeout(250);

    assert.equal(await app.locator('[data-task-control="pause"][data-task-id="task-order-1"]').count(), 0);
    assert.equal(await app.locator('[data-task-control="pause"][data-task-id="task-order-2"]').count(), 0);
});

const ORDERING_BRIDGE_SCRIPT = String.raw`
window.__orderingSnapshotCount = 0;
window.__orderingTasks = {
    "task-order-1": { revision: 1, status: "in_progress" },
    "task-order-2": { revision: 1, status: "in_progress" }
};
function orderingTask(id) {
    var state = window.__orderingTasks[id];
    return {
        checkpoint: null,
        completed: 0,
        currentItem: "work",
        revision: state.revision,
        status: state.status,
        taskId: id,
        title: id,
        total: 1,
        updatedAt: "2026-08-31T10:00:00.000Z"
    };
}
function orderingSnapshot() {
    return {
        agentBusy: false,
        activity: [],
        approvals: [],
        background: [],
        contextSelector: { requiresExplicitContextId: true },
        ctxId: "ctx-ordering",
        currentEvent: null,
        cursor: 10,
        goal: null,
        instance: "browser-instance",
        questions: [],
        tasks: [orderingTask("task-order-1"), orderingTask("task-order-2")]
    };
}
window.addEventListener("message", function (event) {
    if (event.source === window || !event.data || event.data.jsonrpc !== "2.0") return;
    var source = event.source;
    var message = event.data;
    function reply(result) {
        if (message.id === undefined) return;
        source.postMessage({ id: message.id, jsonrpc: "2.0", result: result }, "*");
    }
    if (message.method === "ui/initialize") {
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: { ctxId: "ctx-ordering" } }
        }, "*");
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
                _meta: { "portable-devshell/workspace": { token: "ordering-token" } },
                content: [],
                structuredContent: { ctxId: "ctx-ordering", instance: "browser-instance" }
            }
        }, "*");
        reply({
            hostCapabilities: {},
            hostContext: { availableDisplayModes: ["inline"], displayMode: "inline" },
            hostInfo: { name: "test-host", version: "1.0.0" },
            protocolVersion: "2026-01-26"
        });
        return;
    }
    if (message.method === "ui/update-model-context") { reply({}); return; }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    if (call.name === "workspace_snapshot") {
        window.__orderingSnapshotCount += 1;
        var captured = orderingSnapshot();
        if (window.__orderingSnapshotCount === 2) {
            setTimeout(function () { reply({ structuredContent: captured }); }, 180);
        } else {
            reply({ structuredContent: captured });
        }
        return;
    }
    if (call.name === "workspace_watch") return;
    if (call.name === "workspace_task_control") {
        var taskId = String(call.arguments.taskId);
        var task = window.__orderingTasks[taskId];
        task.status = call.arguments.action === "pause" ? "paused" : task.status;
        task.revision += 1;
        reply({ structuredContent: {
            items: [],
            revision: task.revision,
            summary: { completed: 0, total: 1 },
            taskId: taskId,
            title: taskId
        } });
        return;
    }
    reply({ structuredContent: {} });
});
`;

const LIVE_TRANSPORT_BRIDGE_SCRIPT = String.raw`
window.__liveDisplayModeRequests = [];
window.__liveToolCalls = [];
window.addEventListener("message", function (event) {
    if (event.source === window || !event.data || event.data.jsonrpc !== "2.0") return;
    var source = event.source;
    var message = event.data;
    function reply(result) {
        if (message.id === undefined) return;
        source.postMessage({ id: message.id, jsonrpc: "2.0", result: result }, "*");
    }
    if (message.method === "ui/initialize") {
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: { ctxId: "ctx-live-direct" } }
        }, "*");
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
                _meta: { "portable-devshell/workspace": {
                    liveBaseUrl: "https://live.example/api/live/demo/workspace",
                    token: "live-direct-token"
                } },
                content: [{ type: "text", text: "portable-devshell Live Workspace opened." }],
                structuredContent: { ctxId: "ctx-live-direct", instance: "browser-instance" }
            }
        }, "*");
        reply({
            hostCapabilities: {},
            hostContext: { availableDisplayModes: ["inline", "pip"], displayMode: "inline" },
            hostInfo: { name: "test-host", version: "1.0.0" },
            protocolVersion: "2026-01-26"
        });
        return;
    }
    if (message.method === "ui/request-display-mode") {
        window.__liveDisplayModeRequests.push(message.params);
        reply({ mode: "pip" });
        return;
    }
    if (message.method === "ui/update-model-context") { reply({}); return; }
    if (message.method === "tools/call") {
        window.__liveToolCalls.push(message.params || {});
        reply({ structuredContent: {} });
    }
});
`;

test("Live Workspace times out stalled direct transport and falls back to MCP", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    await page.evaluate(STALLED_LIVE_TRANSPORT_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html
            .replace("var LIVE_SNAPSHOT_TIMEOUT_MS = 5000;", "var LIVE_SNAPSHOT_TIMEOUT_MS = 50;")
            .replace("var LIVE_WATCH_TIMEOUT_MS = 30000;", "var LIVE_WATCH_TIMEOUT_MS = 50;")
            .replace("<script>", `<script>
                window.__stalledLiveFetchCalls = [];
                window.openai = {
                    widgetState: {
                        modelContent: null,
                        privateContent: { portableDevshellWorkspace: {
                            ctxId: "ctx-stalled-live",
                            token: "stalled-live-token",
                            liveBaseUrl: "https://stalled.example/api/live/demo/workspace"
                        } },
                        imageIds: []
                    },
                    setWidgetState: function (state) { this.widgetState = state; }
                };
                window.fetch = function (url, options) {
                    window.__stalledLiveFetchCalls.push(String(url));
                    return new Promise(function (_resolve, reject) {
                        if (options && options.signal) {
                            options.signal.addEventListener("abort", function () {
                                reject(new DOMException("Aborted", "AbortError"));
                            }, { once: true });
                        }
                    });
                };
            <\/script><script>`);
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__stalledLiveToolCalls || []).some(call => call.name === 'workspace_snapshot')");
    await page.waitForFunction("(window.__stalledLiveToolCalls || []).some(call => call.name === 'workspace_watch')");
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (frame === undefined) throw new Error("Workspace frame is missing.");
    const directCalls = await frame.evaluate("window.__stalledLiveFetchCalls || []") as string[];
    assert.equal(directCalls.some((url) => url.includes("/snapshot")), true);
    assert.equal(directCalls.some((url) => url.includes("/watch")), false);
    assert.equal(
        await frame.evaluate("window.openai.widgetState.privateContent.portableDevshellWorkspace.liveBaseUrl || null"),
        null,
    );
    await frame.evaluate(() => {
        window.dispatchEvent(new CustomEvent("openai:set_globals", { detail: { globals: {
            widgetState: {
                modelContent: null,
                privateContent: { portableDevshellWorkspace: {
                    ctxId: "ctx-stalled-live",
                    token: "stalled-live-token",
                    liveBaseUrl: "https://stalled.example/api/live/demo/workspace",
                } },
                imageIds: [],
            },
        } } }));
    });
    await page.waitForTimeout(50);
    assert.equal(
        await frame.evaluate("window.openai.widgetState.privateContent.portableDevshellWorkspace.liveBaseUrl || null"),
        null,
    );
    const toolCalls = await page.evaluate("window.__stalledLiveToolCalls || []") as Array<{ name?: string }>;
    assert.equal(toolCalls.some((call) => call.name === "workspace_snapshot"), true);
    assert.equal(toolCalls.some((call) => call.name === "workspace_watch"), true);
});

test("Live Workspace backs off a direct endpoint that authoritative metadata keeps advertising", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    await page.evaluate(STALLED_LIVE_TRANSPORT_BRIDGE_SCRIPT.replace(
        '_meta: { "portable-devshell/workspace": { token: "stalled-live-token" } },',
        '_meta: { "portable-devshell/workspace": { token: "stalled-live-token", liveBaseUrl: "https://stalled.example/api/live/demo/workspace" } },',
    ));
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html
            .replace("var LIVE_SNAPSHOT_TIMEOUT_MS = 5000;", "var LIVE_SNAPSHOT_TIMEOUT_MS = 50;")
            .replace("var LIVE_WATCH_TIMEOUT_MS = 30000;", "var LIVE_WATCH_TIMEOUT_MS = 50;")
            .replace("var LIVE_TRANSPORT_BACKOFF_MS = 30000;", "var LIVE_TRANSPORT_BACKOFF_MS = 5000;")
            .replace("<script>", `<script>
                window.__stalledLiveFetchCalls = [];
                window.fetch = function (url, options) {
                    window.__stalledLiveFetchCalls.push(String(url));
                    return new Promise(function (_resolve, reject) {
                        if (options && options.signal) {
                            options.signal.addEventListener("abort", function () {
                                reject(new DOMException("Aborted", "AbortError"));
                            }, { once: true });
                        }
                    });
                };
            <\/script><script>`);
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__stalledLiveToolCalls || []).some(call => call.name === 'workspace_snapshot')");
    await page.waitForFunction("(window.__stalledLiveToolCalls || []).some(call => call.name === 'workspace_watch')");
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (frame === undefined) throw new Error("Workspace frame is missing.");
    const directCalls = await frame.evaluate("window.__stalledLiveFetchCalls || []") as string[];
    assert.equal(directCalls.filter((url) => url.includes("/snapshot")).length, 1);
    assert.equal(directCalls.some((url) => url.includes("/watch")), false);
});

test("Live Workspace verifies a generic direct authorization failure through MCP before giving up", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    await page.evaluate(STALLED_LIVE_TRANSPORT_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html.replace("<script>", `<script>
            window.__directAuthFetchCalls = [];
            window.fetch = function (url) {
                window.__directAuthFetchCalls.push(String(url));
                return Promise.resolve(new Response(JSON.stringify({ error: "unauthorized" }), {
                    headers: { "content-type": "application/json" },
                    status: 401
                }));
            };
        <\/script><script>`);
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__stalledLiveToolCalls || []).some(call => call.name === 'workspace_snapshot')");
    await page.waitForFunction("(window.__stalledLiveToolCalls || []).some(call => call.name === 'workspace_watch')");
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (frame === undefined) throw new Error("Workspace frame is missing.");
    const directCalls = await frame.evaluate("window.__directAuthFetchCalls || []") as string[];
    assert.equal(directCalls.filter((url) => url.includes("/snapshot")).length, 1);
    assert.equal(directCalls.some((url) => url.includes("/watch")), false);
});

const STALLED_LIVE_TRANSPORT_BRIDGE_SCRIPT = String.raw`
window.__stalledLiveToolCalls = [];
window.__stalledLiveWatchReplied = false;
function stalledLiveSnapshot() {
    return {
        approvals: [], background: [], ctxId: "ctx-stalled-live", currentEvent: null,
        cursor: 3, goal: null, instance: "browser-instance", questions: [], tasks: []
    };
}
window.addEventListener("message", function (event) {
    if (event.source === window || !event.data || event.data.jsonrpc !== "2.0") return;
    var source = event.source;
    var message = event.data;
    function reply(result) {
        if (message.id === undefined) return;
        source.postMessage({ id: message.id, jsonrpc: "2.0", result: result }, "*");
    }
    if (message.method === "ui/initialize") {
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: { ctxId: "ctx-stalled-live" } }
        }, "*");
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
                _meta: { "portable-devshell/workspace": {
                    liveBaseUrl: "https://stalled.example/api/live/demo/workspace",
                    token: "stalled-live-token"
                } },
                structuredContent: { ctxId: "ctx-stalled-live", instance: "browser-instance" }
            }
        }, "*");
        reply({
            hostCapabilities: {}, hostContext: {},
            hostInfo: { name: "test-host", version: "1.0.0" }, protocolVersion: "2026-01-26"
        });
        return;
    }
    if (message.method === "ui/update-model-context") { reply({}); return; }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    window.__stalledLiveToolCalls.push(call);
    if (call.name === "workspace_snapshot" || call.name === "workspace_reconnect") {
        reply({
            _meta: { "portable-devshell/workspace": { token: "stalled-live-token" } },
            structuredContent: stalledLiveSnapshot()
        });
        return;
    }
    if (call.name === "workspace_watch" && !window.__stalledLiveWatchReplied) {
        window.__stalledLiveWatchReplied = true;
        reply({ structuredContent: { changed: false, cursor: 3, snapshot: stalledLiveSnapshot() } });
    }
});
`;

test("Workspace ignores an old direct response after the host switches Context", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    await page.evaluate(SWITCHED_CONTEXT_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html.replace("<script>", `<script>
            window.__oldSnapshotResolve = null;
            window.fetch = function (url, options) {
                var text = String(url);
                if (text.indexOf("ctxId=ctx-old-direct") >= 0 && text.indexOf("/snapshot") >= 0) {
                    return new Promise(function (resolve, reject) {
                        window.__oldSnapshotResolve = function () {
                            resolve(new Response(JSON.stringify({
                                approvals: [], background: [], ctxId: "ctx-old-direct", currentEvent: null,
                                cursor: 1, goal: null, instance: "browser-instance", questions: [], tasks: []
                            }), { headers: { "content-type": "application/json" }, status: 200 }));
                        };
                        if (options && options.signal) options.signal.addEventListener("abort", function () {
                            reject(new DOMException("Aborted", "AbortError"));
                        }, { once: true });
                    });
                }
                var next = {
                    approvals: [], background: [], ctxId: "ctx-new-direct", currentEvent: null,
                    cursor: 2, goal: null, instance: "browser-instance", questions: [], tasks: []
                };
                if (text.indexOf("/snapshot") >= 0) {
                    return Promise.resolve(new Response(JSON.stringify(next), {
                        headers: { "content-type": "application/json" }, status: 200
                    }));
                }
                return new Promise(function (_resolve, reject) {
                    if (options && options.signal) options.signal.addEventListener("abort", function () {
                        reject(new DOMException("Aborted", "AbortError"));
                    }, { once: true });
                });
            };
        <\/script><script>`);
    }, workspaceAppHtml);

    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (frame === undefined) throw new Error("Workspace frame is missing.");
    await frame.waitForFunction("typeof window.__oldSnapshotResolve === 'function'");
    await frame.evaluate(() => {
        window.dispatchEvent(new CustomEvent("openai:set_globals", {
            detail: { globals: {
                toolOutput: { ctxId: "ctx-new-direct", instance: "browser-instance" },
                toolResponseMetadata: { mcp_tool_result: {
                    _meta: { "portable-devshell/workspace": {
                        liveBaseUrl: "https://new.example/api/live/demo/workspace",
                        token: "new-direct-token"
                    } },
                    structuredContent: { ctxId: "ctx-new-direct", instance: "browser-instance" }
                } }
            } }
        }));
    });
    await page.waitForFunction("(window.__switchedContextModelUpdates || []).some(update => update && update.portableDevshellWorkspace && update.portableDevshellWorkspace.ctxId === 'ctx-new-direct')");
    assert.equal(await frame.evaluate("window.__oldSnapshotResolve() || true"), true);
    await page.waitForTimeout(100);
    const updates = await page.evaluate("window.__switchedContextModelUpdates || []") as Array<{
        portableDevshellWorkspace?: { ctxId?: string };
    }>;
    assert.equal(updates.at(-1)?.portableDevshellWorkspace?.ctxId, "ctx-new-direct");
});

const SWITCHED_CONTEXT_BRIDGE_SCRIPT = String.raw`
window.__switchedContextModelUpdates = [];
window.addEventListener("message", function (event) {
    if (event.source === window || !event.data || event.data.jsonrpc !== "2.0") return;
    var source = event.source;
    var message = event.data;
    function reply(result) {
        if (message.id === undefined) return;
        source.postMessage({ id: message.id, jsonrpc: "2.0", result: result }, "*");
    }
    if (message.method === "ui/initialize") {
        source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: {
            arguments: { ctxId: "ctx-old-direct" }
        } }, "*");
        source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
            _meta: { "portable-devshell/workspace": {
                liveBaseUrl: "https://old.example/api/live/demo/workspace",
                token: "old-direct-token"
            } },
            structuredContent: { ctxId: "ctx-old-direct", instance: "browser-instance" }
        } }, "*");
        reply({ hostCapabilities: {}, hostContext: {}, hostInfo: { name: "test-host", version: "1.0.0" }, protocolVersion: "2026-01-26" });
        return;
    }
    if (message.method === "ui/update-model-context") {
        window.__switchedContextModelUpdates.push(message.params && message.params.structuredContent);
        reply({});
        return;
    }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    if (call.name === "workspace_snapshot") {
        reply({ _meta: { "portable-devshell/workspace": {
            liveBaseUrl: "https://new.example/api/live/demo/workspace", token: "new-direct-token"
        } }, structuredContent: {
            approvals: [], background: [], ctxId: "ctx-new-direct", currentEvent: null,
            cursor: 2, goal: null, instance: "browser-instance", questions: [], tasks: []
        } });
        return;
    }
    if (call.name === "workspace_watch") return;
});
`;

test("Workspace refreshes authoritative state after a stale Goal action is fenced", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    await page.evaluate(STALE_GOAL_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    await app.getByText("Goal A", { exact: true }).waitFor({ state: "visible" });
    await app.getByRole("button", { name: "Stop Goal", exact: true }).click();
    await app.getByText("Goal B", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("State changed; review and retry", { exact: true }).waitFor({ state: "visible" });
    const calls = await page.evaluate("window.__staleGoalCalls || []") as Array<{
        arguments?: Record<string, unknown>;
        name?: string;
    }>;
    const stop = calls.find((call) => call.name === "workspace_goal_stop");
    assert.equal(stop?.arguments?.goalId, "goal-A");
    assert.equal(stop?.arguments?.revision, 1);
    assert.equal(stop?.arguments?.token, "stale-goal-token");
    assert.equal(calls.filter((call) => call.name === "workspace_goal_stop").length, 1);
});

test("Workspace clears task cancel confirmation when the authoritative task revision changes", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    await page.evaluate(STALE_TASK_CONFIRM_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    await app.getByRole("button", { name: "Cancel task", exact: true }).click();
    await app.getByRole("button", { name: "Confirm cancel", exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.evaluate("window.__advanceTaskConfirmRevision()"), true);
    await app.getByText("Task · Updated work", { exact: true }).waitFor({ state: "visible" });
    await app.getByRole("button", { name: "Cancel task", exact: true }).waitFor({ state: "visible" });
    assert.equal(await app.getByRole("button", { name: "Confirm cancel", exact: true }).count(), 0);
    assert.equal(await page.evaluate("(window.__staleTaskConfirmCalls || []).some(call => call.name === 'workspace_task_control')"), false);
});

const STALE_TASK_CONFIRM_BRIDGE_SCRIPT = String.raw`
window.__staleTaskConfirmCalls = [];
window.__staleTaskConfirmRevision = 1;
window.__staleTaskConfirmWatch = null;
function staleTaskConfirmSnapshot() {
    var updated = window.__staleTaskConfirmRevision === 2;
    return {
        approvals: [], background: [], ctxId: "ctx-stale-task", currentEvent: null,
        cursor: window.__staleTaskConfirmRevision,
        goal: null,
        instance: "browser-instance",
        questions: [],
        tasks: [{
            completed: 0,
            currentItem: updated ? "Review new work" : "Review work",
            revision: window.__staleTaskConfirmRevision,
            status: "in_progress",
            taskId: "task-stale-confirm",
            title: updated ? "Updated work" : "Original work",
            total: 1,
            updatedAt: updated ? "2026-08-30T00:01:00.000Z" : "2026-08-30T00:00:00.000Z"
        }]
    };
}
window.__advanceTaskConfirmRevision = function () {
    var pending = window.__staleTaskConfirmWatch;
    if (!pending) return false;
    window.__staleTaskConfirmRevision = 2;
    window.__staleTaskConfirmWatch = null;
    pending.source.postMessage({
        id: pending.id,
        jsonrpc: "2.0",
        result: { structuredContent: { changed: true, cursor: 2, snapshot: staleTaskConfirmSnapshot() } }
    }, "*");
    return true;
};
window.addEventListener("message", function (event) {
    if (event.source === window || !event.data || event.data.jsonrpc !== "2.0") return;
    var source = event.source;
    var message = event.data;
    function reply(result) {
        if (message.id === undefined) return;
        source.postMessage({ id: message.id, jsonrpc: "2.0", result: result }, "*");
    }
    if (message.method === "ui/initialize") {
        source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { ctxId: "ctx-stale-task" } } }, "*");
        source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
            _meta: { "portable-devshell/workspace": { token: "stale-task-token" } },
            structuredContent: { ctxId: "ctx-stale-task", instance: "browser-instance" }
        } }, "*");
        reply({ hostCapabilities: {}, hostContext: {}, hostInfo: { name: "test-host", version: "1.0.0" }, protocolVersion: "2026-01-26" });
        return;
    }
    if (message.method === "ui/update-model-context") { reply({}); return; }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    window.__staleTaskConfirmCalls.push(call);
    if (call.name === "workspace_snapshot" || call.name === "workspace_reconnect") {
        reply({ _meta: { "portable-devshell/workspace": { token: "stale-task-token" } }, structuredContent: staleTaskConfirmSnapshot() });
        return;
    }
    if (call.name === "workspace_watch") {
        window.__staleTaskConfirmWatch = { id: message.id, source: source };
        return;
    }
    if (call.name === "workspace_task_control") {
        reply({ structuredContent: { taskId: call.arguments.taskId } });
    }
});
`;

const STALE_GOAL_BRIDGE_SCRIPT = String.raw`
window.__staleGoalCalls = [];
window.__staleGoalVersion = 1;
function staleGoalSnapshot() {
    var second = window.__staleGoalVersion === 2;
    return {
        approvals: [], background: [], ctxId: "ctx-stale-goal", currentEvent: null, cursor: second ? 2 : 1,
        goal: {
            autoContinueExhausted: false,
            continuationCount: 0,
            continuationDue: false,
            continuationDueAt: "2099-01-01T00:00:00.000Z",
            continuationPending: false,
            continuationUncertain: false,
            createdAt: "2026-08-29T12:00:00.000Z",
            goalId: second ? "goal-B" : "goal-A",
            lastAgentActivityAt: "2026-08-29T12:00:00.000Z",
            maxContinuations: 10,
            objective: second ? "Goal B" : "Goal A",
            revision: second ? 2 : 1,
            status: "active",
            steps: [{ id: "work", status: "active", text: second ? "New work" : "Old work" }],
            updatedAt: "2026-08-29T12:00:00.000Z"
        },
        instance: "browser-instance", questions: [], tasks: []
    };
}
window.addEventListener("message", function (event) {
    if (event.source === window || !event.data || event.data.jsonrpc !== "2.0") return;
    var source = event.source;
    var message = event.data;
    function reply(result) {
        if (message.id === undefined) return;
        source.postMessage({ id: message.id, jsonrpc: "2.0", result: result }, "*");
    }
    function reject(messageText) {
        if (message.id === undefined) return;
        source.postMessage({ error: { code: -32003, message: messageText }, id: message.id, jsonrpc: "2.0" }, "*");
    }
    if (message.method === "ui/initialize") {
        source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { ctxId: "ctx-stale-goal" } } }, "*");
        source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
            _meta: { "portable-devshell/workspace": { token: "stale-goal-token" } },
            structuredContent: { ctxId: "ctx-stale-goal", instance: "browser-instance" }
        } }, "*");
        reply({ hostCapabilities: {}, hostContext: {}, hostInfo: { name: "test-host", version: "1.0.0" }, protocolVersion: "2026-01-26" });
        return;
    }
    if (message.method === "ui/update-model-context") { reply({}); return; }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    window.__staleGoalCalls.push(call);
    if (call.name === "workspace_reconnect" || call.name === "workspace_snapshot") {
        reply({ _meta: { "portable-devshell/workspace": { token: "stale-goal-token" } }, structuredContent: staleGoalSnapshot() });
        return;
    }
    if (call.name === "workspace_watch") return;
    if (call.name === "workspace_goal_stop") {
        window.__staleGoalVersion = 2;
        reject("Workspace Goal changed from goal-A to goal-B; refresh before retrying.");
    }
});
`;

test("Workspace fences an ambiguous detached-wait resume instead of replaying it", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:420px"></iframe>');
    await page.evaluate(WAIT_AMBIGUOUS_BRIDGE_SCRIPT);
    const mount = async () => await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await mount();
    const app = page.frameLocator("#workspace");
    await app.getByText("Delivery uncertain", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Automatic retry stopped to avoid duplicate agent execution.", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.evaluate("(window.__waitAmbiguousMessages || []).length"), 1);

    await mount();
    await app.getByText("Delivery uncertain", { exact: true }).waitFor({ state: "visible" });
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate("(window.__waitAmbiguousMessages || []).length"), 1);
    const beforeDismiss = await page.evaluate(
        "(window.__waitAmbiguousCalls || []).filter(call => call.name === 'workspace_wait_recover').map(call => call.arguments.action)",
    );
    assert.deepEqual(beforeDismiss, ["claim", "attempt"]);

    await app.getByRole("button", { name: "Dismiss automatic resume", exact: true }).click();
    await page.waitForFunction("window.__waitAmbiguousDismissed === true");
    await app.getByText("Delivery uncertain", { exact: true }).waitFor({ state: "detached" });
    const actions = await page.evaluate(
        "(window.__waitAmbiguousCalls || []).filter(call => call.name === 'workspace_wait_recover').map(call => call.arguments.action)",
    );
    assert.deepEqual(actions, ["claim", "attempt", "dismiss"]);
    assert.equal(await page.evaluate("(window.__waitAmbiguousMessages || []).length"), 1);
});

test("Workspace fences an ambiguous Goal continuation instead of replaying it", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:420px"></iframe>');
    await page.evaluate(GOAL_AMBIGUOUS_BRIDGE_SCRIPT);
    const mount = async () => await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await mount();
    const app = page.frameLocator("#workspace");
    await app.getByText("Delivery uncertain", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Continuation delivery uncertain", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.evaluate("(window.__goalAmbiguousMessages || []).length"), 1);
    assert.deepEqual(
        await page.evaluate("(window.__goalAmbiguousCalls || []).filter(call => call.name === 'workspace_goal_continue').map(call => call.arguments.action)"),
        ["claim", "validate", "attempt"],
    );

    await mount();
    await app.getByText("Delivery uncertain", { exact: true }).waitFor({ state: "visible" });
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate("(window.__goalAmbiguousMessages || []).length"), 1);
    assert.deepEqual(
        await page.evaluate("(window.__goalAmbiguousCalls || []).filter(call => call.name === 'workspace_goal_continue').map(call => call.arguments.action)"),
        ["claim", "validate", "attempt"],
    );
});

const WAIT_AMBIGUOUS_BRIDGE_SCRIPT = String.raw`
window.__waitAmbiguousReentryClaimId = "";
window.__waitAmbiguousCalls = [];
window.__waitAmbiguousMessages = [];
window.__waitAmbiguousAttempted = false;
window.__waitAmbiguousDismissed = false;
window.__waitAmbiguousPendingWatch = null;
window.__waitAmbiguousSnapshotDelivered = false;

function waitAmbiguousSnapshot() {
    return {
        approvals: [],
        background: window.__waitAmbiguousDismissed ? [] : [{
            detachedAt: "2026-08-29T12:00:00.000Z",
            recoveryMessageAttemptedAt: window.__waitAmbiguousAttempted ? "2026-08-29T12:00:01.000Z" : undefined,
            recoveryMessageId: window.__waitAmbiguousAttempted ? "resume-message-ambiguous" : undefined,
            status: "resolved",
            taskId: "task-ambiguous",
            tmuxTaskId: "tmux-ambiguous",
            updatedAt: "2026-08-29T12:00:01.000Z",
            waitId: "wait-ambiguous"
        }],
        ctxId: "ctx-wait-ambiguous",
        currentEvent: null,
        cursor: window.__waitAmbiguousAttempted ? 2 : 1,
        goal: null,
        instance: "browser-instance",
        questions: [],
        tasks: [{
            completed: 1,
            currentItem: "Continue work manually",
            revision: 1,
            status: "in_progress",
            taskId: "task-ambiguous",
            title: "Ambiguous recovery",
            total: 2,
            updatedAt: "2026-08-29T12:00:00.000Z"
        }]
    };
}

window.addEventListener("message", function (event) {
    if (event.source === window || !event.data || event.data.jsonrpc !== "2.0") return;
    var source = event.source;
    var message = event.data;
    function reply(result) {
        if (message.id === undefined) return;
        source.postMessage({ id: message.id, jsonrpc: "2.0", result: result }, "*");
    }
    function reject(messageText) {
        if (message.id === undefined) return;
        source.postMessage({ error: { code: -32001, message: messageText }, id: message.id, jsonrpc: "2.0" }, "*");
    }
    if (message.method === "ui/initialize") {
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: { ctxId: "ctx-wait-ambiguous" } }
        }, "*");
        source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
            _meta: { "portable-devshell/workspace": { token: "wait-ambiguous-token" } },
            structuredContent: { ctxId: "ctx-wait-ambiguous", instance: "browser-instance" }
        } }, "*");
        reply({ hostCapabilities: {}, hostContext: {}, hostInfo: { name: "test-host", version: "1.0.0" }, protocolVersion: "2026-01-26" });
        return;
    }
    if (message.method === "ui/update-model-context") { reply({}); return; }
    if (message.method === "ui/message") {
        window.__waitAmbiguousMessages.push(message.params || {});
        reject("host accepted state is unknown");
        return;
    }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    window.__waitAmbiguousCalls.push(call);
    if (call.name === "workspace_reconnect" || call.name === "workspace_snapshot") {
        reply({ _meta: { "portable-devshell/workspace": { token: "wait-ambiguous-token" } }, structuredContent: waitAmbiguousSnapshot() });
        return;
    }
    if (call.name === "workspace_watch") {
        window.__waitAmbiguousPendingWatch = { id: message.id, source: source };
        return;
    }
    if (call.name === "workspace_reentry_control") {
        if (call.arguments.action === "claim") {
            window.__waitAmbiguousReentryClaimId = call.arguments.claimId;
            reply({ structuredContent: { claimId: window.__waitAmbiguousReentryClaimId, claimed: true, epoch: 0, pending: true } });
            return;
        }
        if (call.arguments.action === "validate") {
            reply({ structuredContent: { claimId: window.__waitAmbiguousReentryClaimId, epoch: 0, pending: true, valid: window.__waitAmbiguousReentryClaimId === call.arguments.claimId } });
            return;
        }
        if (call.arguments.action === "release") {
            window.__waitAmbiguousReentryClaimId = "";
            reply({ structuredContent: { epoch: 0, pending: false, released: true } });
            return;
        }
        reply({ structuredContent: { epoch: 0, pending: !!window.__waitAmbiguousReentryClaimId } });
        return;
    }
    if (call.name === "workspace_wait_recover") {
        if (call.arguments.action === "claim") {
            reply({ structuredContent: {
                claimId: "wait-ambiguous-claim",
                kind: "tmux",
                recoveryMessageId: "resume-message-ambiguous",
                result: { task: { status: "0" } },
                taskId: "task-ambiguous",
                targetId: "tmux-ambiguous",
                waitId: "wait-ambiguous"
            } });
            return;
        }
        if (call.arguments.action === "attempt") {
            window.__waitAmbiguousAttempted = true;
            reply({ structuredContent: {
                attempted: true,
                recoveryMessageAttemptedAt: "2026-08-29T12:00:01.000Z",
                recoveryMessageId: "resume-message-ambiguous",
                waitId: "wait-ambiguous"
            } });
            var pending = window.__waitAmbiguousPendingWatch;
            if (pending && !window.__waitAmbiguousSnapshotDelivered) {
                window.__waitAmbiguousPendingWatch = null;
                window.__waitAmbiguousSnapshotDelivered = true;
                pending.source.postMessage({
                    id: pending.id,
                    jsonrpc: "2.0",
                    result: { structuredContent: { changed: true, cursor: 2, snapshot: waitAmbiguousSnapshot() } }
                }, "*");
            }
            return;
        }
        if (call.arguments.action === "dismiss") {
            window.__waitAmbiguousDismissed = true;
            reply({ structuredContent: { dismissed: true, kind: "tmux", targetId: "tmux-ambiguous", waitId: "wait-ambiguous" } });
            return;
        }
        reject("unsafe recovery action after ambiguous delivery: " + call.arguments.action);
    }
});
`;

const GOAL_AMBIGUOUS_BRIDGE_SCRIPT = String.raw`
window.__goalAmbiguousReentryClaimId = "";
window.__goalAmbiguousCalls = [];
window.__goalAmbiguousMessages = [];
window.__goalAmbiguousAttempted = false;

function goalAmbiguousGoal() {
    return {
        autoContinueExhausted: false,
        continuationAttemptedAt: window.__goalAmbiguousAttempted ? "2026-08-29T12:00:01.000Z" : undefined,
        continuationCount: 0,
        continuationDue: !window.__goalAmbiguousAttempted,
        continuationDueAt: "2000-01-01T00:00:00.000Z",
        continuationMessageId: window.__goalAmbiguousAttempted ? "goal-message-ambiguous" : undefined,
        continuationPending: window.__goalAmbiguousAttempted,
        continuationUncertain: window.__goalAmbiguousAttempted,
        createdAt: "2026-08-29T12:00:00.000Z",
        goalId: "goal-ambiguous",
        lastAgentActivityAt: "2026-08-29T12:00:00.000Z",
        maxContinuations: 10,
        objective: "Continue without duplicate dispatch",
        revision: 1,
        status: "active",
        steps: [{ id: "work", status: "active", text: "Continue work" }],
        updatedAt: "2026-08-29T12:00:00.000Z"
    };
}
function goalAmbiguousSnapshot() {
    return {
        approvals: [], background: [], ctxId: "ctx-goal-ambiguous", currentEvent: null,
        cursor: 1, goal: goalAmbiguousGoal(), instance: "browser-instance", questions: [], tasks: []
    };
}
window.addEventListener("message", function (event) {
    if (event.source === window || !event.data || event.data.jsonrpc !== "2.0") return;
    var source = event.source;
    var message = event.data;
    function reply(result) {
        if (message.id === undefined) return;
        source.postMessage({ id: message.id, jsonrpc: "2.0", result: result }, "*");
    }
    function reject(messageText) {
        if (message.id === undefined) return;
        source.postMessage({ error: { code: -32002, message: messageText }, id: message.id, jsonrpc: "2.0" }, "*");
    }
    if (message.method === "ui/initialize") {
        source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { ctxId: "ctx-goal-ambiguous" } } }, "*");
        source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
            _meta: { "portable-devshell/workspace": { token: "goal-ambiguous-token" } },
            structuredContent: { ctxId: "ctx-goal-ambiguous", instance: "browser-instance" }
        } }, "*");
        reply({ hostCapabilities: {}, hostContext: {}, hostInfo: { name: "test-host", version: "1.0.0" }, protocolVersion: "2026-01-26" });
        return;
    }
    if (message.method === "ui/update-model-context") { reply({}); return; }
    if (message.method === "ui/message") {
        window.__goalAmbiguousMessages.push(message.params || {});
        reject("host accepted state is unknown");
        return;
    }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    window.__goalAmbiguousCalls.push(call);
    if (call.name === "workspace_reconnect" || call.name === "workspace_snapshot") {
        reply({ _meta: { "portable-devshell/workspace": { token: "goal-ambiguous-token" } }, structuredContent: goalAmbiguousSnapshot() });
        return;
    }
    if (call.name === "workspace_watch") {
        window.__goalAmbiguousPendingWatch = { id: message.id, source: source };
        return;
    }
    if (call.name === "workspace_reentry_control") {
        if (call.arguments.action === "claim") {
            window.__goalAmbiguousReentryClaimId = call.arguments.claimId;
            reply({ structuredContent: { claimId: window.__goalAmbiguousReentryClaimId, claimed: true, epoch: 0, pending: true } });
            return;
        }
        if (call.arguments.action === "validate") {
            reply({ structuredContent: { claimId: window.__goalAmbiguousReentryClaimId, epoch: 0, pending: true, valid: window.__goalAmbiguousReentryClaimId === call.arguments.claimId } });
            return;
        }
        if (call.arguments.action === "release") {
            window.__goalAmbiguousReentryClaimId = "";
            reply({ structuredContent: { epoch: 0, pending: false, released: true } });
            return;
        }
        reply({ structuredContent: { epoch: 0, pending: !!window.__goalAmbiguousReentryClaimId } });
        return;
    }
    if (call.name === "workspace_goal_continue") {
        if (call.arguments.action === "claim") {
            reply({ structuredContent: {
                claimed: true, claimId: call.arguments.claimId, continuationCount: 1,
                goal: Object.assign({}, goalAmbiguousGoal(), { continuationDue: false, continuationMessageId: "goal-message-ambiguous", continuationPending: true })
            } });
            return;
        }
        if (call.arguments.action === "validate") {
            reply({ structuredContent: { valid: true, goal: Object.assign({}, goalAmbiguousGoal(), { continuationDue: false, continuationMessageId: "goal-message-ambiguous", continuationPending: true }) } });
            return;
        }
        if (call.arguments.action === "attempt") {
            window.__goalAmbiguousAttempted = true;
            reply({ structuredContent: { attempted: true, messageId: "goal-message-ambiguous", goal: goalAmbiguousGoal() } });
            return;
        }
        reject("unsafe goal continuation replay: " + call.arguments.action);
    }
});
`;

test("Workspace does not dispatch automatic recovery when model context injection fails", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    const pageFailures: string[] = [];
    page.on("pageerror", (error) => pageFailures.push(error.message));
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    await page.evaluate(MODEL_CONTEXT_FAILURE_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    await app.getByText("Resume after answer?", { exact: true }).waitFor({ state: "visible" });
    await app.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForFunction("(window.__modelContextFailureActions || []).length >= 3");
    assert.deepEqual(
        await page.evaluate("window.__modelContextFailureActions || []"),
        ["claim", "attempt", "reject"],
    );
    assert.equal(await page.evaluate("(window.__modelContextFailureMessages || []).length"), 0);
    await page.waitForTimeout(250);
    assert.deepEqual(
        await page.evaluate("window.__modelContextFailureActions || []"),
        ["claim", "attempt", "reject"],
    );
    assert.deepEqual(pageFailures, []);
});

test("Workspace records a safe recovery rejection before resetting a timed-out Host bridge", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    const pageFailures: string[] = [];
    page.on("pageerror", (error) => pageFailures.push(error.message));
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    const bridge = MODEL_CONTEXT_FAILURE_BRIDGE_SCRIPT.replace(
        'reject("model context unavailable");',
        'if ((window.__modelContextFailureActions || []).includes("attempt") && !window.__modelContextTransportFailed) { window.__modelContextTransportFailed = true; source.postMessage({ error: { code: -32001, message: "model context timed out" }, id: message.id, jsonrpc: "2.0" }, "*"); } else { reply({}); }',
    );
    await page.evaluate(bridge);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html.replace("var LIVE_START_RETRY_MS = 1000;", "var LIVE_START_RETRY_MS = 50;");
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    await app.getByText("Resume after answer?", { exact: true }).waitFor({ state: "visible" });
    await app.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForFunction("(window.__modelContextFailureActions || []).includes('reject')");
    await page.waitForFunction("(window.__modelContextFailureInitializeCount || 0) >= 2");
    await page.waitForFunction("(window.__modelContextFailureActions || []).includes('complete')");
    assert.deepEqual(
        await page.evaluate("window.__modelContextFailureActions || []"),
        ["claim", "attempt", "reject", "claim", "attempt", "sent", "complete"],
    );
    assert.equal(await page.evaluate("(window.__modelContextFailureMessages || []).length"), 1);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate("(window.__modelContextFailureMessages || []).length"), 1);
    assert.deepEqual(pageFailures, []);
});

const MODEL_CONTEXT_FAILURE_BRIDGE_SCRIPT = String.raw`
window.__modelContextFailureReentryClaimId = "";
window.__modelContextFailureActions = [];
window.__modelContextFailureMessages = [];
window.__modelContextFailureAnswered = false;
window.__modelContextFailureInitializeCount = 0;
function modelContextFailureSnapshot() {
    var question = {
        detachedAt: "2026-08-30T00:00:00.000Z",
        eventName: "user.answer",
        kind: "question",
        name: "workspace_ask",
        payload: { allowText: false, choices: ["Continue"], question: "Resume after answer?" },
        status: "detached",
        targetId: "question-model-context",
        updatedAt: "2026-08-30T00:00:01.000Z",
        waitId: "wait-model-context"
    };
    return {
        approvals: [],
        background: window.__modelContextFailureAnswered ? [{
            detachedAt: question.detachedAt,
            kind: "question",
            status: "resolved",
            updatedAt: "2026-08-30T00:00:02.000Z",
            waitId: question.waitId
        }] : [],
        ctxId: "ctx-model-context",
        currentEvent: window.__modelContextFailureAnswered ? null : question,
        cursor: 1,
        goal: null,
        instance: "browser-instance",
        questions: window.__modelContextFailureAnswered ? [] : [question],
        tasks: []
    };
}
window.addEventListener("message", function (event) {
    if (event.source === window || !event.data || event.data.jsonrpc !== "2.0") return;
    var source = event.source;
    var message = event.data;
    function reply(result) {
        if (message.id === undefined) return;
        source.postMessage({ id: message.id, jsonrpc: "2.0", result: result }, "*");
    }
    function reject(text) {
        if (message.id === undefined) return;
        source.postMessage({ error: { code: -32010, message: text }, id: message.id, jsonrpc: "2.0" }, "*");
    }
    if (message.method === "ui/initialize") {
        window.__modelContextFailureInitializeCount += 1;
        source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { ctxId: "ctx-model-context" } } }, "*");
        source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
            _meta: { "portable-devshell/workspace": { token: "model-context-token" } },
            structuredContent: { ctxId: "ctx-model-context", instance: "browser-instance" }
        } }, "*");
        reply({ hostCapabilities: {}, hostContext: {}, hostInfo: { name: "test-host", version: "1.0.0" }, protocolVersion: "2026-01-26" });
        return;
    }
    if (message.method === "ui/update-model-context") {
        reject("model context unavailable");
        return;
    }
    if (message.method === "ui/message") {
        window.__modelContextFailureMessages.push(message.params || {});
        reply({});
        return;
    }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    if (call.name === "workspace_snapshot" || call.name === "workspace_reconnect") {
        reply({ _meta: { "portable-devshell/workspace": { token: "model-context-token" } }, structuredContent: modelContextFailureSnapshot() });
        return;
    }
    if (call.name === "workspace_watch") return;
    if (call.name === "workspace_reentry_control") {
        if (call.arguments.action === "claim") {
            window.__modelContextFailureReentryClaimId = call.arguments.claimId;
            reply({ structuredContent: { claimId: window.__modelContextFailureReentryClaimId, claimed: true, epoch: 0, pending: true } });
            return;
        }
        if (call.arguments.action === "validate") {
            reply({ structuredContent: { claimId: window.__modelContextFailureReentryClaimId, epoch: 0, pending: true, valid: window.__modelContextFailureReentryClaimId === call.arguments.claimId } });
            return;
        }
        if (call.arguments.action === "release") {
            window.__modelContextFailureReentryClaimId = "";
            reply({ structuredContent: { epoch: 0, pending: false, released: true } });
            return;
        }
        reply({ structuredContent: { epoch: 0, pending: !!window.__modelContextFailureReentryClaimId } });
        return;
    }
    if (call.name === "workspace_question_answer") {
        window.__modelContextFailureAnswered = true;
        reply({ structuredContent: {
            answer: call.arguments.answer,
            detached: true,
            questionId: "question-model-context",
            waitId: "wait-model-context"
        } });
        return;
    }
    if (call.name === "workspace_wait_recover") {
        window.__modelContextFailureActions.push(call.arguments.action);
        if (call.arguments.action === "claim") {
            reply({ structuredContent: {
                claimId: "model-context-claim",
                kind: "question",
                recoveryMessageId: "model-context-message",
                result: { answer: "Continue" },
                targetId: "question-model-context",
                waitId: "wait-model-context"
            } });
            return;
        }
        if (call.arguments.action === "attempt") {
            reply({ structuredContent: {
                attempted: true,
                recoveryMessageAttemptedAt: "2026-08-30T00:00:02.000Z",
                recoveryMessageId: "model-context-message",
                waitId: "wait-model-context"
            } });
            return;
        }
        if (call.arguments.action === "release") {
            reply({ structuredContent: { released: true, waitId: "wait-model-context" } });
            return;
        }
        if (call.arguments.action === "reject") {
            reply({ structuredContent: { rejected: true, waitId: "wait-model-context" } });
            return;
        }
        if (call.arguments.action === "sent") {
            reply({ structuredContent: { recoveryMessageSentAt: "2026-08-30T00:00:03.000Z", sent: true, waitId: "wait-model-context" } });
            return;
        }
        if (call.arguments.action === "complete") {
            reply({ structuredContent: { completed: true, kind: "question", targetId: "question-model-context", waitId: "wait-model-context" } });
        }
    }
});
`;

test("Workspace heartbeat reconciles durable state even when the event stream reports no change", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    await page.evaluate(MISSED_EVENT_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    await app.getByText("Task · After reconciliation", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await app.getByText("Task · Before reconciliation", { exact: true }).count(), 0);
    const watches = await page.evaluate(
        "(window.__missedEventCalls || []).filter(call => call.name === 'workspace_watch')",
    ) as Array<{ arguments?: Record<string, unknown> }>;
    assert.equal(watches.length >= 1, true);
});

const MISSED_EVENT_BRIDGE_SCRIPT = String.raw`
window.__missedEventCalls = [];
window.__missedEventReconciled = false;
function missedEventSnapshot(after) {
    return {
        approvals: [], background: [], ctxId: "ctx-missed-event", currentEvent: null,
        cursor: after ? 2 : 1, goal: null, instance: "browser-instance", questions: [],
        tasks: [{
            completed: after ? 2 : 1,
            currentItem: after ? "Recovered state" : "Old state",
            revision: after ? 2 : 1,
            status: "in_progress",
            taskId: "task-missed-event",
            title: after ? "After reconciliation" : "Before reconciliation",
            total: 3,
            updatedAt: after ? "2026-08-29T12:01:00.000Z" : "2026-08-29T12:00:00.000Z"
        }]
    };
}
window.addEventListener("message", function (event) {
    if (event.source === window || !event.data || event.data.jsonrpc !== "2.0") return;
    var source = event.source;
    var message = event.data;
    function reply(result) {
        if (message.id === undefined) return;
        source.postMessage({ id: message.id, jsonrpc: "2.0", result: result }, "*");
    }
    if (message.method === "ui/initialize") {
        source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { ctxId: "ctx-missed-event" } } }, "*");
        source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
            _meta: { "portable-devshell/workspace": { token: "missed-event-token" } },
            structuredContent: { ctxId: "ctx-missed-event", instance: "browser-instance" }
        } }, "*");
        reply({ hostCapabilities: {}, hostContext: {}, hostInfo: { name: "test-host", version: "1.0.0" }, protocolVersion: "2026-01-26" });
        return;
    }
    if (message.method === "ui/update-model-context") { reply({}); return; }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    window.__missedEventCalls.push(call);
    if (call.name === "workspace_reconnect" || call.name === "workspace_snapshot") {
        reply({ _meta: { "portable-devshell/workspace": { token: "missed-event-token" } }, structuredContent: missedEventSnapshot(false) });
        return;
    }
    if (call.name === "workspace_watch" && !window.__missedEventReconciled) {
        window.__missedEventReconciled = true;
        reply({ structuredContent: { changed: false, cursor: 2, snapshot: missedEventSnapshot(true) } });
    }
});
`;

test("Workspace App reconnects after MCP restart with its persisted private capability", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    const browserFailures: string[] = [];
    page.on("console", (message) => {
        if (message.type() === "error") browserFailures.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => browserFailures.push(`pageerror: ${error.message}`));
    await page.setContent('<iframe id="workspace" style="width:800px;height:320px"></iframe>');
    await page.evaluate(TOKEN_RESTART_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html.replace("<script>", `<script>
            window.openai = {
                widgetState: {
                    modelContent: null,
                    privateContent: {
                        portableDevshellWorkspace: {
                            ctxId: "ctx-token-restart",
                            token: "token-stable"
                        }
                    },
                    imageIds: []
                },
                setWidgetState: function (state) { this.widgetState = state; }
            };
        <\/script><script>`);
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__tokenRestartCalls || []).some(call => call.name === 'workspace_reconnect')");
    await page.waitForFunction("(window.__tokenRestartCalls || []).some(call => call.name === 'workspace_watch' && call.arguments.token === 'token-stable')");
    const calls = await page.evaluate("window.__tokenRestartCalls || []") as Array<{
        arguments?: Record<string, unknown>;
        name?: string;
    }>;
    const reconnects = calls.filter((call) => call.name === "workspace_reconnect");
    assert.equal(reconnects.length >= 1, true);
    assert.equal(reconnects.every((call) => call.arguments?.token === "token-stable"), true);
    assert.equal(calls.some((call) => call.name === "workspace_watch" && call.arguments?.token === "token-stable"), true);
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    assert.equal(
        await frame?.evaluate("window.openai.widgetState.privateContent.portableDevshellWorkspace.token"),
        "token-stable",
    );
    assert.equal(
        await frame?.evaluate("JSON.stringify(window.openai.widgetState.modelContent || null).includes('token-stable')"),
        false,
    );
    assert.deepEqual(browserFailures, []);
});

test("Workspace ignores a stale host tool result after live Context authorization is established", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:320px"></iframe>');
    await page.evaluate(TOKEN_RESTART_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html.replace("<script>", `<script>
            window.openai = {
                widgetState: {
                    modelContent: null,
                    privateContent: {
                        portableDevshellWorkspace: {
                            ctxId: "ctx-token-restart",
                            token: "token-stable"
                        }
                    },
                    imageIds: []
                },
                setWidgetState: function (state) { this.widgetState = state; }
            };
        <\/script><script>`);
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__tokenRestartCalls || []).some(call => call.name === 'workspace_watch' && call.arguments.ctxId === 'ctx-token-restart')");
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (frame === undefined) throw new Error("Workspace frame is missing.");
    await frame.evaluate(() => {
        window.dispatchEvent(new CustomEvent("openai:set_globals", {
            detail: {
                globals: {
                    toolOutput: { ctxId: "ctx-stale", instance: "browser-instance" },
                    toolResponseMetadata: {
                        mcp_tool_result: {
                            _meta: { "portable-devshell/workspace": { token: "token-stale" } },
                            structuredContent: { ctxId: "ctx-stale", instance: "browser-instance" },
                        },
                    },
                },
            },
        }));
    });
    await page.waitForTimeout(100);

    const calls = await page.evaluate("window.__tokenRestartCalls || []") as Array<{
        arguments?: Record<string, unknown>;
        name?: string;
    }>;
    assert.equal(calls.some((call) => call.arguments?.ctxId === "ctx-stale"), false);
    assert.equal(
        await frame.evaluate("window.openai.widgetState.privateContent.portableDevshellWorkspace.ctxId"),
        "ctx-token-restart",
    );
});

const TOKEN_RESTART_BRIDGE_SCRIPT = String.raw`
window.__tokenRestartCalls = [];
window.__tokenRestartWatchReplied = false;

function tokenRestartSnapshot() {
    return {
        approvals: [],
        background: [],
        ctxId: "ctx-token-restart",
        currentEvent: null,
        cursor: 1,
        goal: null,
        instance: "browser-instance",
        questions: [],
        tasks: []
    };
}

window.addEventListener("message", function (event) {
    if (event.source === window || !event.data || event.data.jsonrpc !== "2.0") return;
    var source = event.source;
    var message = event.data;
    function reply(result) {
        if (message.id === undefined) return;
        source.postMessage({ id: message.id, jsonrpc: "2.0", result: result }, "*");
    }
    function reject(messageText) {
        if (message.id === undefined) return;
        source.postMessage({
            error: { code: -32000, message: messageText },
            id: message.id,
            jsonrpc: "2.0"
        }, "*");
    }
    if (message.method === "ui/initialize") {
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: { ctxId: "ctx-token-restart" } }
        }, "*");
        reply({
            hostCapabilities: {},
            hostContext: {},
            hostInfo: { name: "test-host", version: "1.0.0" },
            protocolVersion: "2026-01-26"
        });
        return;
    }
    if (message.method === "ui/update-model-context") { reply({}); return; }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    window.__tokenRestartCalls.push(call);
    if (call.name === "workspace_reconnect" || call.name === "workspace_snapshot") {
        if (call.arguments.token !== "token-stable") {
            reject("Workspace App authorization is invalid for the current Context.");
            return;
        }
        reply({
            _meta: { "portable-devshell/workspace": { token: "token-stable" } },
            structuredContent: tokenRestartSnapshot()
        });
        return;
    }
    if (call.name === "workspace_watch") {
        if (call.arguments.token !== "token-stable") {
            reject("Workspace App authorization is invalid for the current Context.");
            return;
        }
        if (!window.__tokenRestartWatchReplied) {
            window.__tokenRestartWatchReplied = true;
            reply({ structuredContent: { changed: false, cursor: 1, snapshot: tokenRestartSnapshot() } });
        }
    }
});
`;

test("Workspace recovers ChatGPT-hidden result metadata from window.openai on first mount", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    await page.evaluate(CHATGPT_METADATA_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html.replace("<script>", `<script>
            window.openai = {
                toolOutput: { ctxId: "ctx-chatgpt-meta", instance: "browser-instance" },
                toolResponseMetadata: {
                    mcp_tool_result: {
                        _meta: { "portable-devshell/workspace": { token: "chatgpt-meta-token" } },
                        structuredContent: { ctxId: "ctx-chatgpt-meta", instance: "browser-instance" }
                    }
                },
                widgetState: { modelContent: null, privateContent: {}, imageIds: [] },
                setWidgetState: function (state) { this.widgetState = state; }
            };
        <\/script><script>`);
    }, workspaceAppHtml);

    await page.waitForFunction(
        "(window.__chatgptMetadataCalls || []).some(call => call.name === 'workspace_snapshot' && call.arguments.token === 'chatgpt-meta-token')",
        undefined,
        { timeout: 2_000 },
    );
});

const CHATGPT_METADATA_BRIDGE_SCRIPT = String.raw`
window.__chatgptMetadataCalls = [];
window.addEventListener("message", function (event) {
    if (event.source === window || !event.data || event.data.jsonrpc !== "2.0") return;
    var source = event.source;
    var message = event.data;
    function reply(result) {
        if (message.id === undefined) return;
        source.postMessage({ id: message.id, jsonrpc: "2.0", result: result }, "*");
    }
    if (message.method === "ui/initialize") {
        reply({ hostCapabilities: {}, hostContext: {}, hostInfo: { name: "test-host", version: "1.0.0" }, protocolVersion: "2026-01-26" });
        return;
    }
    if (message.method === "ui/notifications/initialized") {
        source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } }, "*");
        source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
            structuredContent: { ctxId: "ctx-chatgpt-meta", instance: "browser-instance" }
        } }, "*");
        return;
    }
    if (message.method === "ui/update-model-context") { reply({}); return; }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    window.__chatgptMetadataCalls.push(call);
    if (call.name === "workspace_snapshot") {
        reply({
            _meta: { "portable-devshell/workspace": { token: "chatgpt-meta-token" } },
            structuredContent: {
                approvals: [], background: [], ctxId: "ctx-chatgpt-meta", currentEvent: null,
                cursor: 1, goal: null, instance: "browser-instance", questions: [], tasks: []
            }
        });
        return;
    }
    if (call.name === "workspace_watch") return;
});
`;


test("Workspace waits for a delayed initial capability instead of minting reconnect authorization", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:360px"></iframe>');
    await page.evaluate(LATE_INITIAL_RESULT_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    await page.waitForTimeout(450);
    assert.equal(await page.evaluate("(window.__lateInitialCalls || []).length"), 0);
    await app.getByText("Waiting for Workspace authorization", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.evaluate("window.__deliverLateInitialResult()"), true);
    await page.waitForFunction("(window.__lateInitialCalls || []).some(call => call.name === 'workspace_reconnect' && call.arguments.token === 'token-initial')");
    await app.getByText("Continue after reconnect?", { exact: true }).waitFor({ state: "visible" });
    await app.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForFunction("(window.__lateInitialCalls || []).some(call => call.name === 'workspace_question_answer')");

    const answerToken = await page.evaluate(
        "(window.__lateInitialCalls || []).find(call => call.name === 'workspace_question_answer')?.arguments?.token",
    );
    assert.equal(answerToken, "token-initial");
    await app.getByText("Continue after reconnect?", { exact: true }).waitFor({ state: "hidden" });
});

const LATE_INITIAL_RESULT_BRIDGE_SCRIPT = String.raw`
window.__lateInitialCalls = [];
window.__lateInitialSource = null;
window.__lateInitialAnswered = false;
function lateInitialSnapshot() {
    var question = {
        eventName: "user.answer",
        kind: "question",
        name: "workspace_ask",
        payload: { allowText: false, choices: ["Continue"], question: "Continue after reconnect?" },
        status: "waiting",
        updatedAt: "2026-08-30T00:00:00.000Z",
        waitId: "wait-late-initial"
    };
    return {
        approvals: [], background: [], ctxId: "ctx-late-initial",
        currentEvent: window.__lateInitialAnswered ? null : question,
        cursor: 1, goal: null, instance: "browser-instance",
        questions: window.__lateInitialAnswered ? [] : [question], tasks: []
    };
}
window.__deliverLateInitialResult = function () {
    if (!window.__lateInitialSource) return false;
    window.__lateInitialSource.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
            _meta: { "portable-devshell/workspace": { token: "token-initial" } },
            content: [{ type: "text", text: "portable-devshell Workspace opened." }],
            structuredContent: { ctxId: "ctx-late-initial", instance: "browser-instance" }
        }
    }, "*");
    return true;
};
window.addEventListener("message", function (event) {
    if (event.source === window || !event.data || event.data.jsonrpc !== "2.0") return;
    var source = event.source;
    var message = event.data;
    function reply(result) {
        if (message.id === undefined) return;
        source.postMessage({ id: message.id, jsonrpc: "2.0", result: result }, "*");
    }
    function reject(text) {
        if (message.id === undefined) return;
        source.postMessage({ error: { code: -32000, message: text }, id: message.id, jsonrpc: "2.0" }, "*");
    }
    if (message.method === "ui/initialize") {
        window.__lateInitialSource = source;
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: { ctxId: "ctx-late-initial" } }
        }, "*");
        reply({ hostCapabilities: {}, hostContext: {}, hostInfo: { name: "test-host", version: "1.0.0" }, protocolVersion: "2026-01-26" });
        return;
    }
    if (message.method === "ui/update-model-context") { reply({}); return; }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    window.__lateInitialCalls.push(call);
    if (call.name === "workspace_reconnect" || call.name === "workspace_snapshot") {
        if (call.arguments.token !== "token-initial") {
            reject("Workspace App authorization is invalid for the current Context.");
            return;
        }
        reply({ _meta: { "portable-devshell/workspace": { token: "token-initial" } }, structuredContent: lateInitialSnapshot() });
        return;
    }
    if (call.name === "workspace_watch") return;
    if (call.name === "workspace_question_answer") {
        if (call.arguments.token !== "token-initial") {
            reject("Workspace App authorization is invalid for the current Context.");
            return;
        }
        window.__lateInitialAnswered = true;
        reply({ structuredContent: { answer: "Continue", detached: false, questionId: "question-late", waitId: "wait-late-initial" } });
    }
});
`;

async function launchBrowser(): Promise<Browser> {
    if (CHROMIUM_EXECUTABLE === undefined) {
        throw new Error("A Chromium executable is required for this browser test.");
    }
    return await chromium.launch({
        executablePath: CHROMIUM_EXECUTABLE,
        headless: true,
    });
}

function resolveChromiumExecutable(): string | undefined {
    const candidates = [
        process.env.PORTABLE_DEVSHELL_CHROMIUM,
        process.env.DEVSHELL_TEST_CHROMIUM,
        chromium.executablePath(),
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/opt/google/chrome/chrome",
    ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
    return candidates.find((candidate) => existsSync(candidate));
}
