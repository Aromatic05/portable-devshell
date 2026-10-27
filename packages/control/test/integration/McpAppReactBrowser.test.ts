import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import {
    mcpAppAssetDirectory,
    mcpAppHtmlForPublicBaseUrl,
} from "@portable-devshell/mcp/testing";
import { chromiumTestOptions } from "../../../../test/TestPlatformSupport.ts";

const chromiumExecutable = [
    process.env.PORTABLE_DEVSHELL_CHROMIUM,
    process.env.DEVSHELL_TEST_CHROMIUM,
    chromium.executablePath(),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
].find((candidate) => candidate !== undefined && existsSync(candidate));
const browserOptions = chromiumTestOptions(chromiumExecutable);

const token = {
    "ctx-browser": "browser-private-capability-00001",
    "ctx-next": "browser-private-capability-00002",
    "ctx-reentry": "browser-private-capability-00003",
} as const;

interface BrowserFixture {
    origin: string;
    server: Server;
    requests: Array<{ path: string; authorization?: string; credentials?: string }>;
    state: { approved: boolean; revoked: boolean };
    close(): Promise<void>;
}

/**
 * Delivers the production Vite bundle, not the removed inline MCP App client.
 * The parent frame implements the standard MCP Apps JSON-RPC Host handshake.
 */
async function createBrowserFixture(): Promise<BrowserFixture> {
    const requests: BrowserFixture["requests"] = [];
    const state = { approved: false, revoked: false };
    let origin = "";
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", origin);
            if (url.pathname === "/") {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                res.end(`<!doctype html><html><body>
                    <iframe id="workspace" src="/widget" style="width:900px;height:620px;border:0"></iframe>
                    <iframe id="interaction" src="/interaction" style="width:900px;height:240px;border:0"></iframe>
                    <script>${HOST_BRIDGE}</script>
                </body></html>`);
                return;
            }
            if (url.pathname === "/widget") {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                res.end(mcpAppHtmlForPublicBaseUrl(origin));
                return;
            }
            if (url.pathname === "/interaction") {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                res.end(mcpAppHtmlForPublicBaseUrl(origin, "interaction"));
                return;
            }
            const prefix = "/mcpapp/assets/";
            if (url.pathname.startsWith(prefix)) {
                const file = url.pathname.slice(prefix.length);
                if (!/^[A-Za-z0-9._-]+$/u.test(file) || file.startsWith(".")) {
                    res.writeHead(403).end();
                    return;
                }
                const bytes = await readFile(join(mcpAppAssetDirectory, file));
                res.writeHead(200, {
                    "content-type": extname(file) === ".css" ? "text/css" : "text/javascript",
                    "cache-control": "no-store",
                });
                res.end(bytes);
                return;
            }
            if (url.pathname === "/__action" && req.method === "POST") {
                let body = "";
                for await (const part of req) body += String(part);
                const action = JSON.parse(body) as { actionId?: string };
                if (action.actionId === "approve") state.approved = true;
                res.writeHead(200, { "content-type": "application/json" }).end("{}");
                return;
            }
            if (url.pathname === "/__revoke" && req.method === "POST") {
                state.revoked = true;
                res.writeHead(200).end();
                return;
            }
            if (url.pathname.startsWith("/api/live/demo/workspace/")) {
                const ctxId = url.searchParams.get("ctxId") ?? "";
                requests.push({
                    path: url.pathname + url.search,
                    authorization: req.headers.authorization,
                    credentials: req.headers.cookie,
                });
                if (state.revoked || req.headers.authorization !== `Bearer ${token[ctxId as keyof typeof token] ?? ""}`) {
                    res.writeHead(401).end();
                    return;
                }
                const response = (value: unknown) =>
                    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
                if (url.pathname.endsWith("/snapshot")) {
                    response(snapshot(ctxId, state.approved));
                    return;
                }
                if (url.pathname.endsWith("/watch")) {
                    const delay = setTimeout(() => {
                        if (!res.destroyed && !res.writableEnded)
                            response({ changed: false, cursor: Number(url.searchParams.get("cursor")) || 7 });
                    }, 350);
                    delay.unref();
                    return;
                }
            }
            res.writeHead(404).end();
        } catch (error) {
            if (!res.headersSent) res.writeHead(500);
            res.end(String(error));
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
    return {
        origin, server, requests, state,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => error ? reject(error) : resolve()));
        },
    };
}

function snapshot(ctxId: string, approved: boolean) {
    return {
        ctxId, instance: "demo", cursor: 7, agentBusy: false,
        presentation: {
            ...(ctxId === "ctx-browser" && !approved ? {
                primary: {
                    id: "approval-browser", title: "Approval required",
                    detail: "Review the deployment", actions: [
                        { id: "approve", label: "Approve" },
                        { id: "deny", label: "Deny", confirmation: { message: "Deny deployment?" } },
                    ],
                },
            } : {}),
            work: ctxId === "ctx-next" ? [{ id: "task-next", title: "Other Context task", actions: [] }] : [],
            background: [],
        },
        reentry: ctxId === "ctx-reentry" ? {
            pending: true, directives: [{
                kind: "reentry", id: "directive-browser",
                intent: "goal-resume", sourceId: "goal-recovery",
            }],
        } : { pending: false },
    };
}

/** Standard JSON-RPC MCP Apps host, intentionally no legacy client projections. */
const HOST_BRIDGE = String.raw`
window.__hostCalls = [];
window.__modelContexts = [];
window.__messages = [];
window.__initialized = 0;
window.__currentCtx = "ctx-browser";
function notifyContext(source, ctxId) {
    window.__currentCtx = ctxId;
    source.postMessage({
        jsonrpc: "2.0", method: "ui/notifications/tool-input",
        params: { arguments: { ctxId: ctxId } }
    }, "*");
    source.postMessage({
        jsonrpc: "2.0", method: "ui/notifications/tool-result",
        params: {
            structuredContent: { ctxId: ctxId, instance: "demo" },
            _meta: { "portable-devshell/mcpapp": {
                ctxId: ctxId, token: ({
                    "ctx-browser": "browser-private-capability-00001",
                    "ctx-next": "browser-private-capability-00002",
                    "ctx-reentry": "browser-private-capability-00003"
                })[ctxId],
                liveBaseUrl: location.origin + "/api/live/demo/workspace"
            } }
        }
    }, "*");
}
window.__sendContext = function(ctxId) {
    window.__currentCtx = ctxId;
    for (var id of ["workspace", "interaction"]) {
        notifyContext(document.querySelector("#" + id).contentWindow, ctxId);
    }
};
window.addEventListener("message", function(event) {
    if (event.source === window || !event.data || event.data.jsonrpc !== "2.0") return;
    var source = event.source;
    var message = event.data;
    function reply(value) {
        if (message.id !== undefined)
            source.postMessage({ jsonrpc: "2.0", id: message.id, result: value }, "*");
    }
    if (message.method === "ui/initialize") {
        window.__initialized += 1;
        reply({
            hostCapabilities: {},
            hostContext: { displayMode: "inline", theme: "light" },
            hostInfo: { name: "react-browser-host", version: "1.0.0" },
            protocolVersion: "2026-01-26"
        });
        setTimeout(function () { notifyContext(source, window.__currentCtx); }, 0);
        return;
    }
    if (message.method === "ui/update-model-context") {
        window.__modelContexts.push(message.params);
        reply({});
        return;
    }
    if (message.method === "ui/message") {
        window.__messages.push(message.params);
        reply({});
        return;
    }
    if (message.method !== "tools/call") {
        reply({});
        return;
    }
    var call = message.params || {};
    window.__hostCalls.push(call);
    if (call.name === "mcpapp_open") {
        reply({ structuredContent: { ctxId: window.__currentCtx, instance: "demo" },
            _meta: { "portable-devshell/mcpapp": {
                ctxId: window.__currentCtx,
                token: ({
                    "ctx-browser": "browser-private-capability-00001",
                    "ctx-next": "browser-private-capability-00002",
                    "ctx-reentry": "browser-private-capability-00003"
                })[window.__currentCtx],
                liveBaseUrl: location.origin + "/api/live/demo/workspace"
            } } });
        return;
    }
    if (call.name === "mcpapp_action") {
        fetch("/__action", { method: "POST", body: JSON.stringify(call.arguments) })
            .then(function () { reply({ structuredContent: {
                status: "applied", itemId: call.arguments.itemId, actionId: call.arguments.actionId
            } }); });
        return;
    }
    if (call.name === "mcpapp_reentry") {
        var action = call.arguments.action;
        if (action === "claim") reply({ structuredContent: {
            claimed: true, delivery: { message: "Resume the authorized Goal",
                modelContext: { structuredContent: { ctxId: "ctx-reentry" } } }
        } });
        else if (action === "validate") reply({ structuredContent: { valid: true } });
        else if (action === "attempt") reply({ structuredContent: { attempted: true } });
        else reply({ structuredContent: { reported: true } });
        return;
    }
    reply({ structuredContent: {} });
});
`;

test("production React MCP App uses private Live HTTP state and dispatches approved actions", browserOptions, async (t) => {
    const fixture = await createBrowserFixture();
    t.after(() => fixture.close());
    const browser = await chromium.launch({ executablePath: chromiumExecutable, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(fixture.origin);
    const app = page.frameLocator("#workspace");
    const interaction = page.frameLocator("#interaction");
    await interaction.getByText("Approval required", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("An approval is awaiting your decision.", { exact: true })
        .waitFor({ state: "visible" });
    assert.equal(await page.evaluate("window.__initialized"), 2);
    assert.equal(await app.getByRole("button", { name: "Approve", exact: true }).count(), 1);
    assert.equal(fixture.requests.some((request) =>
        request.path.includes("/snapshot?ctxId=ctx-browser") &&
        request.authorization === "Bearer browser-private-capability-00001" &&
        request.credentials === undefined), true);
    assert.doesNotMatch(await app.locator("body").innerText(), /browser-private-capability/u);
    assert.doesNotMatch(await interaction.locator("body").innerText(), /browser-private-capability/u);

    await interaction.getByRole("button", { name: "Approve", exact: true }).click();
    await interaction.getByText("Approval required", { exact: true }).waitFor({ state: "hidden" });
    const action = await page.evaluate("window.__hostCalls.find(call => call.name === 'mcpapp_action')") as {
        arguments: { ctxId: string; itemId: string; actionId: string; requestId: string };
    } | undefined;
    assert.ok(action);
    assert.equal(action.arguments.ctxId, "ctx-browser");
    assert.equal(action.arguments.itemId, "approval-browser");
    assert.equal(action.arguments.actionId, "approve");
    assert.ok(action.arguments.requestId.length >= 16);

    await page.evaluate("window.__sendContext('ctx-next')");
    await app.getByText("Other Context task", { exact: true }).waitFor({ state: "visible" });
    assert.equal(fixture.requests.some((request) =>
        request.path.includes("ctxId=ctx-next") &&
        request.authorization === "Bearer browser-private-capability-00002"), true);
    assert.deepEqual(errors, []);
});

test("production React MCP App sends exactly one authorized reentry through the Host", browserOptions, async (t) => {
    const fixture = await createBrowserFixture();
    t.after(() => fixture.close());
    const browser = await chromium.launch({ executablePath: chromiumExecutable, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(fixture.origin);
    await page.evaluate("window.__sendContext('ctx-reentry')");
    const app = page.frameLocator("#workspace");
    await app.getByText("Workspace ready", { exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction("window.__messages.length === 1");
    const actions = await page.evaluate(
        "window.__hostCalls.filter(call => call.name === 'mcpapp_reentry').map(call => call.arguments.action)");
    assert.deepEqual(actions, ["claim", "validate", "attempt", "report"]);
    assert.equal(await page.evaluate("window.__modelContexts.length"), 1);
    assert.equal(await page.evaluate("window.__messages[0].content[0].text"), "Resume the authorized Goal");
    await page.waitForTimeout(550);
    assert.equal(await page.evaluate("window.__messages.length"), 1);
});

test("production React MCP App rejects revoked Live capabilities", browserOptions, async (t) => {
    const fixture = await createBrowserFixture();
    t.after(() => fixture.close());
    const browser = await chromium.launch({ executablePath: chromiumExecutable, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(fixture.origin);
    const app = page.frameLocator("#workspace");
    const interaction = page.frameLocator("#interaction");
    await interaction.getByText("Approval required", { exact: true }).waitFor({ state: "visible" });
    await page.evaluate(() => fetch("/__revoke", { method: "POST" }));
    await page.evaluate("window.__sendContext('ctx-next')");
    await app.getByText("MCP App authorization expired", { exact: false }).waitFor({ state: "visible" });
    await interaction.getByText("MCP App authorization expired", { exact: false })
        .waitFor({ state: "visible" });
    assert.doesNotMatch(await app.locator("body").innerText(), /browser-private-capability/u);
    assert.doesNotMatch(await interaction.locator("body").innerText(), /browser-private-capability/u);
    assert.equal(fixture.requests.some((request) => request.path.includes("ctxId=ctx-next")), true);
});
