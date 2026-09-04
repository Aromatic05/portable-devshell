import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LINUX_TESTSPACE_ISOLATION, TESTSPACE_ISOLATION_ENV } from "./TestspaceNamespace.mjs";

const TEST_HOST = "portable-devshell.test";
const DEFAULT_TIMEOUT_MS = 15_000;

export function resolveChromiumExecutable(
    environment = process.env,
    platform = process.platform,
    probe = commandAvailable,
) {
    const configured = environment.PORTABLE_DEVSHELL_CHROMIUM;
    if (configured !== undefined && configured.length > 0) {
        if (!probe(configured)) {
            throw new Error(`PORTABLE_DEVSHELL_CHROMIUM is not executable: ${configured}`);
        }
        return configured;
    }

    const candidates = platform === "darwin"
        ? [
              "/Applications/Chromium.app/Contents/MacOS/Chromium",
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          ]
        : platform === "win32"
          ? ["chromium.exe", "chrome.exe", "msedge.exe"]
          : ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
    return candidates.find((candidate) => probe(candidate));
}

export function chromiumLaunchArguments(options = {}) {
    const environment = options.environment ?? process.env;
    const platform = options.platform ?? process.platform;
    const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    const sandboxUnavailable = platform === "linux" && (
        environment.CI ||
        environment[TESTSPACE_ISOLATION_ENV] === LINUX_TESTSPACE_ISOLATION ||
        uid === 0
    );
    return [
        "--headless=new",
        ...(sandboxUnavailable ? ["--no-sandbox"] : []),
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        `--host-resolver-rules=MAP ${TEST_HOST} 127.0.0.1`,
        "--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable",
    ];
}

export async function runTestspaceWebSmoke({
    browserExecutable = resolveChromiumExecutable(),
    webPort,
    exerciseLifecycle = false,
    expectedInstance = "testspace-local",
    timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
    if (browserExecutable === undefined) {
        throw new Error(
            "A Chromium browser is required. Install Chromium or set PORTABLE_DEVSHELL_CHROMIUM.",
        );
    }
    if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65_535) {
        throw new Error("webPort must be a valid TCP port.");
    }

    const debuggingPort = await reservePort();
    const profile = await mkdtemp(join(tmpdir(), "pds-web-smoke-"));
    const browser = spawn(browserExecutable, [
        ...chromiumLaunchArguments(),
        `--remote-debugging-port=${debuggingPort}`,
        `--user-data-dir=${profile}`,
        "about:blank",
    ], {
        stdio: ["ignore", "ignore", "pipe"],
    });
    let browserStderr = "";
    browser.stderr?.setEncoding("utf8");
    browser.stderr?.on("data", (chunk) => {
        browserStderr += chunk;
    });

    try {
        const version = await waitForJson(
            `http://127.0.0.1:${debuggingPort}/json/version`,
            timeoutMs,
            () => `Chromium did not expose DevTools.\n${browserStderr}`,
        );
        if (typeof version.webSocketDebuggerUrl !== "string") {
            throw new Error("Chromium DevTools version response did not include a WebSocket URL.");
        }
        const targets = await fetchJson(`http://127.0.0.1:${debuggingPort}/json`);
        const page = Array.isArray(targets)
            ? targets.find((target) => target?.type === "page")
            : undefined;
        if (typeof page?.webSocketDebuggerUrl !== "string") {
            throw new Error("Chromium did not expose a page target.");
        }

        const devtools = await connectDevtools(page.webSocketDebuggerUrl);
        try {
            await Promise.all([
                devtools.send("Page.enable"),
                devtools.send("Runtime.enable"),
                devtools.send("Log.enable"),
                devtools.send("Network.enable"),
            ]);
            const url = `http://${TEST_HOST}:${webPort}/web/`;
            await devtools.send("Page.navigate", { url });
            const pageState = await waitForPageState(devtools, timeoutMs);
            const failures = devtools.events.filter((event) =>
                event.method === "Runtime.exceptionThrown" ||
                event.method === "Network.loadingFailed" ||
                (event.method === "Log.entryAdded" && event.params?.entry?.level === "error")
            );
            assertWebSmokeState(pageState, failures, expectedInstance);
            if (exerciseLifecycle) {
                await exerciseInstanceLifecycle(devtools, expectedInstance, timeoutMs);
            }
            return {
                browser: browserExecutable,
                instanceLifecycle: exerciseLifecycle ? "stop-start" : "not-exercised",
                instanceVisible: pageState.body.includes(expectedInstance),
                online: true,
                randomUuidAvailable: pageState.randomUuidType === "function",
                secureContext: pageState.secureContext,
                url,
            };
        } finally {
            devtools.close();
        }
    } finally {
        browser.kill("SIGTERM");
        if (!await waitForProcessExit(browser, 1_000)) {
            browser.kill("SIGKILL");
            await waitForProcessExit(browser, 1_000);
        }
        await rm(profile, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
        });
    }
}

async function waitForProcessExit(process, timeoutMs) {
    if (process.exitCode !== null || process.signalCode !== null) return true;
    return await Promise.race([
        new Promise((resolve) => process.once("exit", () => resolve(true))),
        delay(timeoutMs).then(() => false),
    ]);
}

async function exerciseInstanceLifecycle(devtools, instanceName, timeoutMs) {
    await clickButton(devtools, "Instances", { prefix: true });
    await waitForCondition(
        devtools,
        `document.body?.innerText.includes(${JSON.stringify(instanceName)}) === true`,
        timeoutMs,
        "Instances page did not render the target instance.",
    );
    await evaluateRequired(
        devtools,
        `(() => {
            const target = [...document.querySelectorAll('button.instance.card')]
                .find((button) => button.textContent?.includes(${JSON.stringify(instanceName)}));
            if (!(target instanceof HTMLElement)) return false;
            target.click();
            return true;
        })()`,
        "Target instance card is not clickable.",
    );
    await waitForCondition(
        devtools,
        `document.body?.innerText.includes('Runtime: ready') === true`,
        timeoutMs,
        "Instance detail did not reach ready state before Stop.",
    );

    await clickButton(devtools, "Stop", { outsideDialog: true });
    await clickButton(devtools, "Stop", { insideDialog: true });
    await waitForCondition(
        devtools,
        `document.body?.innerText.includes('Runtime: stopped') === true`,
        timeoutMs,
        "Web Stop action did not reach stopped state.",
    );

    await clickButton(devtools, "Start", { outsideDialog: true });
    await waitForCondition(
        devtools,
        `document.body?.innerText.includes('Runtime: ready') === true`,
        timeoutMs,
        "Web Start action did not return the instance to ready state.",
    );
}

async function clickButton(devtools, label, options = {}) {
    await evaluateRequired(
        devtools,
        `(() => {
            const target = [...document.querySelectorAll('button')]
                .filter((button) => {
                    const inDialog = button.closest('[role="dialog"]') !== null;
                    if (${options.insideDialog === true} && !inDialog) return false;
                    if (${options.outsideDialog === true} && inDialog) return false;
                    return true;
                })
                .find((button) => {
                    const text = button.textContent?.trim() ?? '';
                    return ${options.prefix === true}
                        ? text.startsWith(${JSON.stringify(label)})
                        : text === ${JSON.stringify(label)};
                });
            if (!(target instanceof HTMLElement) || target.hasAttribute('disabled')) return false;
            target.click();
            return true;
        })()`,
        `Button ${label} is not clickable.`,
    );
}

async function evaluateRequired(devtools, expression, message) {
    const evaluated = await devtools.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
    });
    if (evaluated.result?.value !== true) {
        throw new Error(message);
    }
}

async function waitForCondition(devtools, expression, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const evaluated = await devtools.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
        });
        if (evaluated.result?.value === true) {
            return;
        }
        await delay(100);
    }
    const page = await devtools.send("Runtime.evaluate", {
        expression: "document.body?.innerText ?? ''",
        returnByValue: true,
    });
    throw new Error(`${message}\n${String(page.result?.value ?? "")}`);
}

export function assertWebSmokeState(pageState, failures = [], expectedInstance = "testspace-local") {
    if (pageState.secureContext !== false) {
        throw new Error("Web smoke did not exercise a non-secure HTTP origin.");
    }
    if (pageState.randomUuidType !== "undefined") {
        throw new Error("Web smoke did not exercise the crypto.randomUUID fallback path.");
    }
    if (!pageState.body.includes("Online") || pageState.body.includes("Offline")) {
        throw new Error(`Web SPA did not connect to Control.\n${pageState.body}`);
    }
    if (
        !pageState.body.includes("Overview") ||
        !pageState.body.includes("Audit") ||
        !pageState.body.includes(expectedInstance)
    ) {
        throw new Error(`Web SPA did not render the real testspace read model.\n${pageState.body}`);
    }
    if (pageState.alerts.length > 0) {
        throw new Error(`Web SPA rendered errors: ${pageState.alerts.join(" | ")}`);
    }
    if (failures.length > 0) {
        throw new Error(`Chromium reported Web failures: ${JSON.stringify(failures)}`);
    }
}

async function waitForPageState(devtools, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        const evaluated = await devtools.send("Runtime.evaluate", {
            expression: `({
                alerts: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent ?? ''),
                body: document.body?.innerText ?? '',
                readyState: document.readyState,
                randomUuidType: typeof globalThis.crypto?.randomUUID,
                secureContext: globalThis.isSecureContext
            })`,
            returnByValue: true,
        });
        last = evaluated.result?.value;
        if (
            last?.readyState === "complete" &&
            typeof last.body === "string" &&
            (last.body.includes("Online") || last.body.includes("Offline"))
        ) {
            await delay(500);
            const settled = await devtools.send("Runtime.evaluate", {
                expression: `({
                    alerts: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent ?? ''),
                    body: document.body?.innerText ?? '',
                    readyState: document.readyState,
                    randomUuidType: typeof globalThis.crypto?.randomUUID,
                    secureContext: globalThis.isSecureContext
                })`,
                returnByValue: true,
            });
            return settled.result?.value;
        }
        await delay(100);
    }
    throw new Error(`Web SPA did not settle within ${timeoutMs}ms. Last state: ${JSON.stringify(last)}`);
}

async function connectDevtools(url) {
    const socket = new WebSocket(url);
    await new Promise((resolvePromise, rejectPromise) => {
        socket.addEventListener("open", resolvePromise, { once: true });
        socket.addEventListener("error", rejectPromise, { once: true });
    });
    let nextId = 1;
    const pending = new Map();
    const events = [];
    socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== undefined) {
            const waiter = pending.get(message.id);
            if (waiter !== undefined) {
                pending.delete(message.id);
                if (message.error !== undefined) {
                    waiter.reject(new Error(JSON.stringify(message.error)));
                } else {
                    waiter.resolve(message.result);
                }
            }
            return;
        }
        if (message.method !== undefined) {
            events.push(message);
        }
    });
    return {
        events,
        close() {
            socket.close();
            for (const waiter of pending.values()) {
                waiter.reject(new Error("Chromium DevTools connection closed."));
            }
            pending.clear();
        },
        send(method, params = {}) {
            const id = nextId++;
            return new Promise((resolvePromise, rejectPromise) => {
                pending.set(id, { reject: rejectPromise, resolve: resolvePromise });
                socket.send(JSON.stringify({ id, method, params }));
            });
        },
    };
}

async function waitForJson(url, timeoutMs, failureMessage) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            return await fetchJson(url);
        } catch {
            await delay(50);
        }
    }
    throw new Error(failureMessage());
}

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`${url} returned HTTP ${response.status}.`);
    }
    return await response.json();
}

async function reservePort() {
    const server = createServer();
    await new Promise((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => error ? rejectPromise(error) : resolvePromise());
    });
    if (address === null || typeof address === "string") {
        throw new Error("Failed to reserve a Chromium debugging port.");
    }
    return address.port;
}

function commandAvailable(command) {
    const result = spawnSync(command, ["--version"], {
        stdio: "ignore",
        windowsHide: true,
    });
    return result.status === 0;
}

function delay(milliseconds) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
