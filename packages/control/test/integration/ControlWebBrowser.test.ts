import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { chromium, type Browser, type Page } from "playwright";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

import { HttpHost, McpOAuthProtectedResource, type McpOAuthApprovalService } from "@portable-devshell/mcp";
import {
    CONTROL_PROTOCOL_VERSION,
    PrefixRoute,
    controlWebBasePath,
    type JsonValue,
    type PrefixRouteSnapshot,
} from "@portable-devshell/shared";

import { ControlChannelServer } from "../../src/server/channel/ControlChannelServer.ts";
import { ControlWebOAuthFlow } from "../../src/server/web/ControlWebOAuthFlow.ts";
import { ControlWebSessionService } from "../../src/server/web/ControlWebSessionService.ts";
import { ControlWebSocketChannelProvider } from "../../src/server/web/ControlWebSocketChannelProvider.ts";

const WEB_SCOPES = ["web"];
const WEB_RESOURCE_NAME = "browser-web";

test("real Chromium opens auth=none WebUI, establishes a session, and boots through control WebSocket RPC", async (t) => {
    const runtime = await startBrowserRuntime({ auth: "none", prefix: "" });
    const browser = await launchBrowser();
    t.after(async () => {
        await browser.close().catch(() => undefined);
        await runtime.close();
    });

    const page = await guardedPage(browser);
    await page.goto(`${runtime.origin}${runtime.basePath}/`, { waitUntil: "domcontentloaded" });
    await assertOverview(page);

    assert.equal(runtime.calls.hello > 0, true, "the SPA must complete the real control protocol handshake");
    assert.equal(runtime.calls.overview > 0, true, "the SPA must load the real Overview read model");
    assert.equal(
        (await page.context().cookies()).some((cookie) => cookie.name === "devshell_web_session"),
        true,
        "auth=none still establishes the WebSocket session cookie",
    );
    assertPageHealthy(page);
});

test("real Chromium follows Web OAuth redirects, completes both approvals, and returns to the live SPA", async (t) => {
    const runtime = await startBrowserRuntime({ auth: "oauth2", prefix: "" });
    const browser = await launchBrowser();
    t.after(async () => {
        await browser.close().catch(() => undefined);
        await runtime.close();
    });

    const page = await guardedPage(browser);
    await page.goto(`${runtime.origin}${runtime.basePath}/`, { waitUntil: "domcontentloaded" });
    const approvals = runtime.approvals;
    assert.notEqual(approvals, undefined);

    const approvedKinds = await approveBrowserFlow(page, approvals!, `${runtime.origin}${runtime.basePath}/`);
    assert.deepEqual([...approvedKinds].sort(), ["authorization", "registration"]);
    await assertOverview(page);

    assert.equal(runtime.calls.hello > 0, true, "the OAuth callback must boot the real control WebSocket client");
    assert.equal(new URL(page.url()).pathname, `${runtime.basePath}/`);
    assertPageHealthy(page);
});

test("real Chromium preserves a public URL prefix through session bootstrap and WebSocket RPC", async (t) => {
    const runtime = await startBrowserRuntime({ auth: "none", prefix: "/devshell" });
    const browser = await launchBrowser();
    t.after(async () => {
        await browser.close().catch(() => undefined);
        await runtime.close();
    });

    const page = await guardedPage(browser);
    await page.goto(`${runtime.origin}${runtime.basePath}/`, { waitUntil: "domcontentloaded" });
    await assertOverview(page);

    assert.equal(new URL(page.url()).pathname, `${runtime.basePath}/`);
    assert.equal(runtime.calls.hello > 0, true);
    assertPageHealthy(page);
});

interface BrowserRuntime {
    approvals?: McpOAuthApprovalService;
    basePath: string;
    calls: { hello: number; overview: number };
    close(): Promise<void>;
    origin: string;
}

async function startBrowserRuntime(options: {
    auth: "none" | "oauth2";
    prefix: string;
}): Promise<BrowserRuntime> {
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const publicBaseUrl = `${origin}${options.prefix}`;
    const basePath = controlWebBasePath(publicBaseUrl);
    const storage = await createTestTempDirectory("web-browser");
    const assetDirectory = join(storage, "web-assets");
    await buildBrowserAssets(assetDirectory);
    const http = new HttpHost({ listenHost: "127.0.0.1", listenPort: port });
    const sessions = new ControlWebSessionService({
        auth: options.auth === "none"
            ? { mode: "none" }
            : {
                  mode: "oauth2",
                  oauth2: { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME },
              },
        basePath,
    });
    const calls = { hello: 0, overview: 0 };
    const channels = new ControlChannelServer({
        providers: [
            new ControlWebSocketChannelProvider({
                assetDirectory,
                basePath,
                http,
                sessions,
            }),
        ],
        routes: {
            connectionClosed() {},
            snapshot: () => createRouteSnapshot(calls),
        },
    });

    let flow: ControlWebOAuthFlow | undefined;
    let protectedResource: McpOAuthProtectedResource | undefined;
    let uninstallFlow: (() => void) | undefined;
    if (options.auth === "oauth2") {
        protectedResource = new McpOAuthProtectedResource(
            { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME },
            origin,
            storage,
            { trustProxy: true },
        );
        flow = new ControlWebOAuthFlow({
            basePath,
            config: { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME },
            ownsProvider: true,
            protectedResource,
            publicBaseUrl,
            sessions,
        });
        http.installOAuth(protectedResource);
        await flow.warmup();
        uninstallFlow = flow.install(http);
    }

    try {
        await channels.start();
        await http.start();
    } catch (error) {
        uninstallFlow?.();
        await channels.close().catch(() => undefined);
        await http.stop().catch(() => undefined);
        await rm(storage, { force: true, recursive: true });
        throw error;
    }

    return {
        approvals: protectedResource?.approvals,
        basePath,
        calls,
        origin,
        async close() {
            await channels.close().catch(() => undefined);
            uninstallFlow?.();
            await http.stop().catch(() => undefined);
            await rm(storage, { force: true, recursive: true });
        },
    };
}

async function buildBrowserAssets(outputDirectory: string): Promise<void> {
    const require = createRequire(
        new URL("../../../web/package.json", import.meta.url),
    );
    const viteModule = (await import(
        pathToFileURL(require.resolve("vite")).href
    )) as {
        build(options: {
            build: { emptyOutDir: boolean; outDir: string };
            logLevel: "silent";
            root: string;
        }): Promise<unknown>;
    };
    await viteModule.build({
        build: { emptyOutDir: true, outDir: outputDirectory },
        logLevel: "silent",
        root: fileURLToPath(new URL("../../../web/", import.meta.url)),
    });
}

function createRouteSnapshot(calls: { hello: number; overview: number }): PrefixRouteSnapshot {
    return PrefixRoute.snapshot([
        {
            destination: "@control",
            modules: [
                {
                    name: "service",
                    operations: [
                        {
                            name: "hello",
                            handle: () => {
                                calls.hello += 1;
                                return {
                                    capabilities: ["request", "stream", "streamResume"],
                                    protocolVersion: CONTROL_PROTOCOL_VERSION,
                                };
                            },
                        },
                        { name: "status", handle: () => ({ instanceCount: 0, ok: true, pid: process.pid }) },
                        { name: "ping", handle: () => ({ pong: true }) },
                    ],
                },
                {
                    name: "instance",
                    operations: [{ name: "list", handle: () => [] }],
                },
                {
                    name: "mcp",
                    operations: [{ name: "status", handle: () => ({ running: false }) }],
                },
                {
                    name: "overview",
                    operations: [
                        {
                            name: "get",
                            handle: () => {
                                calls.overview += 1;
                                return overviewPayload();
                            },
                        },
                    ],
                },
            ],
        },
    ]);
}

function overviewPayload(): JsonValue {
    return {
        activity: [],
        alerts: [],
        controller: { pid: process.pid, uptimeSeconds: 1 },
        counts: {
            activeTodos: 0,
            failedCalls24h: 0,
            instancesAttention: 0,
            instancesCritical: 0,
            instancesReady: 0,
            instancesTotal: 0,
            pendingApprovals: 0,
        },
        generatedAt: new Date().toISOString(),
        health: "healthy",
        instances: [],
        todos: [],
    };
}

async function launchBrowser(): Promise<Browser> {
    return await chromium.launch({
        executablePath: await resolveChromiumExecutable(),
        headless: true,
    });
}

async function resolveChromiumExecutable(): Promise<string> {
    const candidates = [
        process.env.DEVSHELL_TEST_CHROMIUM,
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/opt/google/chrome/chrome",
    ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
    for (const candidate of candidates) {
        try {
            await access(candidate);
            return candidate;
        } catch {
            // Try the next explicitly supported browser location.
        }
    }
    throw new Error("A system Chromium executable is required. Set DEVSHELL_TEST_CHROMIUM.");
}

interface GuardedPage extends Page {
    __browserFailures: string[];
    __browserResponses: string[];
}

async function guardedPage(browser: Browser): Promise<GuardedPage> {
    const context = await browser.newContext();
    const page = await context.newPage() as GuardedPage;
    page.__browserFailures = [];
    page.__browserResponses = [];
    page.on("console", (message) => {
        if (message.type() === "error") {
            const location = message.location();
            page.__browserFailures.push(
                `console: ${message.text()} ${location.url}:${location.lineNumber}:${location.columnNumber}`,
            );
        }
    });
    page.on("pageerror", (error) => page.__browserFailures.push(`pageerror: ${error.message}`));
    page.on("requestfailed", (request) => {
        page.__browserFailures.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`);
    });
    page.on("response", (response) => {
        page.__browserResponses.push(`${response.request().method()} ${response.status()} ${response.url()}`);
    });
    return page;
}

function assertPageHealthy(page: GuardedPage): void {
    assert.deepEqual(page.__browserFailures, [], page.__browserResponses.join("\n"));
}

async function assertOverview(page: Page): Promise<void> {
    try {
        await page.getByRole("heading", { name: "Overview" }).waitFor({
            state: "visible",
            timeout: 5_000,
        });
    } catch (error) {
        const failures = (page as GuardedPage).__browserFailures ?? [];
        const responses = (page as GuardedPage).__browserResponses ?? [];
        const body = await page.locator("body").innerText().catch(() => "<body unavailable>");
        throw new Error(
            `WebUI did not render Overview. url=${page.url()} body=${JSON.stringify(body)} failures=${JSON.stringify(failures)} responses=${JSON.stringify(responses)}`,
            { cause: error },
        );
    }
    await page.getByText("Checking session…").waitFor({ state: "detached" }).catch(() => undefined);
}

async function approveBrowserFlow(
    page: Page,
    approvals: McpOAuthApprovalService,
    expectedReturnUrl: string,
): Promise<Set<"authorization" | "registration">> {
    const approvedIds = new Set<string>();
    const kinds = new Set<"authorization" | "registration">();
    let sawInteraction = false;
    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline) {
        const url = page.url();
        if (url.includes("/interaction/")) sawInteraction = true;
        for (const approval of await approvals.list()) {
            if (approval.status !== "pending" || approvedIds.has(approval.approvalId)) continue;
            await approvals.decide(approval.approvalId, "approve", "web");
            approvedIds.add(approval.approvalId);
            kinds.add(approval.kind);
        }
        if (page.url() === expectedReturnUrl && await page.getByRole("heading", { name: "Overview" }).isVisible().catch(() => false)) {
            assert.equal(sawInteraction, true, "the SPA must actually navigate through the OAuth interaction page");
            return kinds;
        }
        await page.waitForTimeout(100);
    }
    throw new Error(`Web OAuth browser flow did not return to ${expectedReturnUrl}; current URL is ${page.url()}`);
}

async function reservePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Port reservation failed.");
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
    });
    return address.port;
}
