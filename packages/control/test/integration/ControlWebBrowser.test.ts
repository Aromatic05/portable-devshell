import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { chromium, type Browser, type Page } from "playwright";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { cleanupInOrder } from "../../../../test/TestCleanup.ts";
import { requireTcpPort } from "../../../../test/TestHttpSupport.ts";
import { chromiumTestOptions } from "../../../../test/TestPlatformSupport.ts";

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
import { ControlWebSocketListener } from "../../src/server/web/ControlWebSocketListener.ts";

const WEB_SCOPES = ["web"];
const WEB_RESOURCE_NAME = "browser-web";
const WEB_TOKEN = "browser-web-token-0123456789abcdef0123456789abcdef";
const CHROMIUM_EXECUTABLE = resolveChromiumExecutable();
const BROWSER_TEST_OPTIONS = chromiumTestOptions(CHROMIUM_EXECUTABLE);

test("real Chromium opens auth=none WebUI, establishes a session, and boots through control WebSocket RPC", BROWSER_TEST_OPTIONS, async (t) => {
    const runtime = await startBrowserRuntime({ auth: "none", prefix: "" });
    const browser = await launchBrowser();
    t.after(async () => {
        await cleanupInOrder(
            () => browser.close(),
            () => runtime.close(),
        );
    });

    const page = await guardedPage(browser);
    await page.goto(`${runtime.origin}${runtime.basePath}/`, { waitUntil: "domcontentloaded" });
    await assertOverview(page, runtime.calls);

    assert.equal(runtime.calls.hello > 0, true, "the SPA must complete the real control protocol handshake");
    assert.equal(
        (await page.context().cookies()).some((cookie) => cookie.name === "devshell_web_session"),
        true,
        "auth=none still establishes the WebSocket session cookie",
    );
    assertPageHealthy(page);
});

test("real Chromium rejects a wrong Web token, accepts the configured token, and logs out", BROWSER_TEST_OPTIONS, async (t) => {
    const runtime = await startBrowserRuntime({ auth: "token", prefix: "" });
    const browser = await launchBrowser();
    t.after(async () => {
        await cleanupInOrder(
            () => browser.close(),
            () => runtime.close(),
        );
    });

    const page = await guardedPage(browser);
    await page.goto(`${runtime.origin}${runtime.basePath}/`, { waitUntil: "domcontentloaded" });
    const tokenInput = page.getByLabel("Access token");
    await tokenInput.waitFor({ state: "visible" });
    await tokenInput.fill("wrong-token");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("alert").filter({ hasText: "Sign-in was not accepted." }).waitFor({
        state: "visible",
    });
    assert.equal(runtime.calls.hello, 0, "a rejected token must not open the control WebSocket");
    assert.equal(
        page.__browserFailures.every((failure) =>
            failure.includes("401 (Unauthorized)") && failure.includes(`${runtime.basePath}/session`)
        ),
        true,
        page.__browserFailures.join("\n"),
    );
    page.__browserFailures.length = 0;

    await tokenInput.fill(WEB_TOKEN);
    await page.getByRole("button", { name: "Sign in" }).click();
    await assertOverview(page, runtime.calls);
    assert.equal(runtime.calls.hello > 0, true);
    assert.deepEqual(
        await page.evaluate(() => ({
            local: window.localStorage.getItem("token"),
            session: window.sessionStorage.getItem("token"),
        })),
        { local: null, session: null },
    );

    assertPageHealthy(page);
    page.__browserFailures.length = 0;
    const logoutResponse = page.waitForResponse((response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname === `${runtime.basePath}/session`
    );
    await page.getByRole("button", { name: "Log out" }).click();
    assert.equal((await logoutResponse).status(), 204);
    await page.getByRole("button", { name: "Sign in" }).waitFor({ state: "visible" });
    assert.equal(
        (await page.context().cookies()).some((cookie) => cookie.name === "devshell_web_session"),
        false,
    );
    assert.deepEqual(
        page.__browserFailures.filter((failure) =>
            !failure.includes(`requestfailed: DELETE ${runtime.origin}${runtime.basePath}/session net::ERR_ABORTED`)
        ),
        [],
        page.__browserResponses.join("\n"),
    );
});

test("real Chromium follows Web OAuth redirects, completes both approvals, and returns to the live SPA", BROWSER_TEST_OPTIONS, async (t) => {
    const runtime = await startBrowserRuntime({ auth: "oauth2", prefix: "" });
    const browser = await launchBrowser();
    t.after(async () => {
        await cleanupInOrder(
            () => browser.close(),
            () => runtime.close(),
        );
    });

    const page = await guardedPage(browser);
    await page.goto(`${runtime.origin}${runtime.basePath}/`, { waitUntil: "domcontentloaded" });
    const approvals = runtime.approvals;
    assert.notEqual(approvals, undefined);

    const approvedKinds = await approveBrowserFlow(page, approvals!, `${runtime.origin}${runtime.basePath}/`);
    assert.deepEqual([...approvedKinds].sort(), ["authorization", "registration"]);
    await assertOverview(page, runtime.calls);

    assert.equal(runtime.calls.hello > 0, true, "the OAuth callback must boot the real control WebSocket client");
    assert.equal(new URL(page.url()).pathname, `${runtime.basePath}/`);
    assertPageHealthy(page);
});

test("real Chromium preserves a public URL prefix through session bootstrap and WebSocket RPC", BROWSER_TEST_OPTIONS, async (t) => {
    const runtime = await startBrowserRuntime({ auth: "none", prefix: "/devshell" });
    const browser = await launchBrowser();
    t.after(async () => {
        await cleanupInOrder(
            () => browser.close(),
            () => runtime.close(),
        );
    });

    const page = await guardedPage(browser);
    await page.goto(`${runtime.origin}${runtime.basePath}/`, { waitUntil: "domcontentloaded" });
    await assertOverview(page, runtime.calls);

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
    auth: "none" | "oauth2" | "token";
    prefix: string;
}): Promise<BrowserRuntime> {
    const storage = await createTestTempDirectory("web-browser");
    const assetDirectory = join(storage, "web-assets");
    await buildBrowserAssets(assetDirectory);
    const http = new HttpHost({ listenHost: "127.0.0.1", listenPort: 0 });
    await http.start();
    const origin = `http://127.0.0.1:${requireTcpPort(http.address)}`;
    const publicBaseUrl = `${origin}${options.prefix}`;
    const basePath = controlWebBasePath(publicBaseUrl);
    const sessions = new ControlWebSessionService({
        auth: options.auth === "none"
            ? { mode: "none" }
            : options.auth === "token"
              ? { mode: "token", token: WEB_TOKEN }
              : {
                    mode: "oauth2",
                    oauth2: { requiredScopes: WEB_SCOPES, resourceName: WEB_RESOURCE_NAME },
                },
        basePath,
    });
    const calls = { hello: 0, overview: 0 };
    const channels = new ControlChannelServer({
        listeners: [
            new ControlWebSocketListener({
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
    } catch (error) {
        try {
            await cleanupInOrder(
                () => channels.close(),
                () => uninstallFlow?.(),
                () => http.stop(),
                () => rm(storage, { force: true, recursive: true }),
            );
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                "Browser runtime startup and cleanup both failed.",
            );
        }
        throw error;
    }

    return {
        approvals: protectedResource?.approvals,
        basePath,
        calls,
        origin,
        async close() {
            await cleanupInOrder(
                () => channels.close(),
                () => uninstallFlow?.(),
                () => http.stop(),
                () => rm(storage, { force: true, recursive: true }),
            );
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

async function assertOverview(
    page: Page,
    calls: { overview: number },
): Promise<void> {
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
    const deadline = Date.now() + 5_000;
    while (calls.overview === 0 && Date.now() < deadline) {
        await page.waitForTimeout(25);
    }
    assert.equal(calls.overview > 0, true, "the SPA must load the real Overview read model");
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
