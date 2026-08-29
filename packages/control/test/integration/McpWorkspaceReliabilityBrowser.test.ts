import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { chromium, type Browser } from "playwright";

import { workspaceAppHtml } from "@portable-devshell/mcp/testing";
import { chromiumTestOptions } from "../../../../test/TestPlatformSupport.ts";

const CHROMIUM_EXECUTABLE = resolveChromiumExecutable();
const BROWSER_TEST_OPTIONS = chromiumTestOptions(CHROMIUM_EXECUTABLE);

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

test("Workspace App recovers from a stale in-memory token after MCP restart", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    const browserFailures: string[] = [];
    page.on("console", (message) => {
        if (message.type() === "error" && !message.text().includes("authorization is invalid")) {
            browserFailures.push(`console: ${message.text()}`);
        }
    });
    page.on("pageerror", (error) => browserFailures.push(`pageerror: ${error.message}`));
    await page.setContent('<iframe id="workspace" style="width:800px;height:320px"></iframe>');
    await page.evaluate(TOKEN_RESTART_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__tokenRestartCalls || []).filter(call => call.name === 'workspace_reconnect').length >= 2");
    await page.waitForFunction("(window.__tokenRestartCalls || []).some(call => call.name === 'workspace_watch' && call.arguments.token === 'token-new')");
    const calls = await page.evaluate("window.__tokenRestartCalls || []") as Array<{
        arguments?: Record<string, unknown>;
        name?: string;
    }>;
    const reconnects = calls.filter((call) => call.name === "workspace_reconnect");
    assert.equal(reconnects.length >= 2, true);
    assert.equal(reconnects.every((call) => call.arguments?.token === undefined), true);
    assert.equal(calls.some((call) => call.name === "workspace_watch" && call.arguments?.token === "token-old"), true);
    assert.equal(calls.some((call) => call.name === "workspace_watch" && call.arguments?.token === "token-new"), true);
    assert.deepEqual(browserFailures, []);
});

const TOKEN_RESTART_BRIDGE_SCRIPT = String.raw`
window.__tokenRestartCalls = [];
window.__tokenRestartReconnects = 0;
window.__tokenRestartFailedOldWatch = false;

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
    if (message.method === "ui/update-model-context") {
        reply({});
        return;
    }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    window.__tokenRestartCalls.push(call);
    if (call.name === "workspace_reconnect") {
        window.__tokenRestartReconnects += 1;
        reply({
            _meta: { "portable-devshell/workspace": { token: window.__tokenRestartReconnects === 1 ? "token-old" : "token-new" } },
            structuredContent: tokenRestartSnapshot()
        });
        return;
    }
    if (call.name === "workspace_watch") {
        if (call.arguments.token === "token-old" && !window.__tokenRestartFailedOldWatch) {
            window.__tokenRestartFailedOldWatch = true;
            reject("Workspace App authorization is invalid for the current Context.");
            return;
        }
        reply({ structuredContent: { changed: false, cursor: 1, snapshot: tokenRestartSnapshot() } });
        return;
    }
    if (call.name === "workspace_snapshot") {
        reply({
            _meta: { "portable-devshell/workspace": { token: "token-new" } },
            structuredContent: tokenRestartSnapshot()
        });
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
