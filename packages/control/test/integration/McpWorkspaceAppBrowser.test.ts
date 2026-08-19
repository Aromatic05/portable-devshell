import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { chromium, type Browser } from "playwright";

import { workspaceAppHtml } from "@portable-devshell/mcp/testing";
import { chromiumTestOptions } from "../../../../test/TestPlatformSupport.ts";

const CHROMIUM_EXECUTABLE = resolveChromiumExecutable();
const BROWSER_TEST_OPTIONS = chromiumTestOptions(CHROMIUM_EXECUTABLE);

test("Workspace App watches live state and keeps human-action authorization hidden", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    const browserFailures: string[] = [];
    page.on("console", (message) => {
        if (message.type() === "error") browserFailures.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => browserFailures.push(`pageerror: ${error.message}`));

    await page.setContent('<iframe id="workspace" style="width:800px;height:900px"></iframe>');
    await page.evaluate(BRIDGE_SCRIPT);

    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    await app.getByText("Activity", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Background", { exact: true }).waitFor({ state: "visible" });
    await app.locator(".title.mono").filter({ hasText: "bash_run" }).waitFor({ state: "visible" });
    await app.getByText("task-browser", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Live Workspace is connected", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Continue the task?", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Approval required", { exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction("(window.__modelContextUpdates || []).length >= 2");
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);

    await app.getByRole("button", { name: "Approve", exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_approval_decide')");
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);

    await app.getByRole("button", { name: "Pause" }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_task_control' && call.arguments.action === 'pause')");
    await app.getByRole("button", { name: "Resume", exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
    assert.equal(await app.getByRole("button", { name: "Resume agent", exact: true }).count(), 0);

    await app.getByRole("button", { name: "Continue" }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_question_answer')");
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);

    await app.getByRole("button", { name: "Resume", exact: true }).click();
    await page.waitForFunction("(window.__modelMessages || []).length === 1");
    await app.getByRole("button", { name: "Ask", exact: true }).click();
    await page.waitForFunction("(window.__modelMessages || []).length === 2");

    await app.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_task_control' && call.arguments.action === 'cancel')");
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 2);

    const calls = await page.evaluate("window.__workspaceCalls || []") as Array<{
        arguments?: Record<string, unknown>;
        name?: string;
    }>;
    const snapshotCall = calls.find((call) => call.name === "workspace_snapshot");
    const watchCall = calls.find((call) => call.name === "workspace_watch");
    const answerCall = calls.find((call) => call.name === "workspace_question_answer");
    const approvalCall = calls.find((call) => call.name === "workspace_approval_decide");
    const taskCalls = calls.filter((call) => call.name === "workspace_task_control");

    assert.equal(snapshotCall?.arguments?.token, undefined);
    assert.equal(watchCall?.arguments?.token, undefined);
    assert.equal(answerCall?.arguments?.token, "browser-secret-token");
    assert.equal(answerCall?.arguments?.ctxId, "ctx-browser");
    assert.equal(answerCall?.arguments?.waitId, "wait-question");
    assert.equal(approvalCall?.arguments?.token, "browser-secret-token");
    assert.equal(approvalCall?.arguments?.decision, "approve");
    assert.deepEqual(taskCalls.map((call) => call.arguments?.action), ["pause", "resume", "cancel"]);
    assert.equal(taskCalls.every((call) => call.arguments?.token === "browser-secret-token"), true);
    const bridgeEvents = await page.evaluate("window.__bridgeEvents || []") as string[];
    assert.equal(bridgeEvents.at(-1), "context");
    const messageIndex = bridgeEvents.indexOf("message");
    assert.equal(messageIndex > 0 && bridgeEvents[messageIndex - 1] === "context", true);
    assert.deepEqual(browserFailures, []);
});

test("Workspace App claims a resolved detached wait before one automatic model re-entry", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:900px"></iframe>');
    await page.evaluate(RECOVERY_BRIDGE_SCRIPT);
    const mount = async () => await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await mount();
    await page.waitForFunction("(window.__modelMessages || []).length === 1");
    await page.waitForFunction("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_wait_recover').length === 1");

    const firstEvents = await page.evaluate("window.__bridgeEvents || []") as string[];
    const firstMessage = firstEvents.indexOf("message");
    assert.equal(firstMessage > 0 && firstEvents[firstMessage - 1] === "context", true);

    await mount();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 1);
    assert.equal(await page.evaluate("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_wait_recover').length"), 1);

    const recoverCall = await page.evaluate(
        "(window.__workspaceCalls || []).find(call => call.name === 'workspace_wait_recover')",
    ) as { arguments?: Record<string, unknown> };
    assert.equal(recoverCall.arguments?.token, "recovery-secret-token");
    assert.equal(recoverCall.arguments?.waitId, "wait-recovery");
});

test("Workspace explicit Resume does not double-trigger passive detached-wait recovery", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:900px"></iframe>');
    await page.evaluate(RESUME_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    const resume = app.getByRole("button", { name: "Resume", exact: true });
    await resume.waitFor({ state: "visible" });
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
    assert.equal(await page.evaluate("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_wait_recover').length"), 0);

    await resume.click();
    await page.waitForFunction("(window.__modelMessages || []).length === 1");
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 1);
    assert.equal(await page.evaluate("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_wait_recover').length"), 0);
});

test("Workspace re-enters after a detached answer and guards manual background resume", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:900px"></iframe>');
    await page.evaluate(DETACHED_INTERACTION_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    await app.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForFunction("(window.__modelMessages || []).length === 1");

    const resume = app.getByRole("button", { name: "Resume agent", exact: true });
    await resume.waitFor({ state: "visible" });
    await resume.click({ noWaitAfter: true });
    await app.getByRole("button", { name: "Resume agent", exact: true }).waitFor({ state: "visible" });
    assert.equal(await app.getByRole("button", { name: "Resume agent", exact: true }).isDisabled(), true);
    await page.waitForFunction("(window.__modelMessages || []).length === 2");
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 2);
});

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

const BRIDGE_SCRIPT = String.raw`
window.__workspaceCalls = [];
window.__workspaceQuestionAnswered = false;
window.__workspaceApprovalPending = true;
window.__workspaceWatchCount = 0;
window.__modelContextUpdates = [];
window.__modelMessages = [];
window.__bridgeEvents = [];
window.__taskStatus = "in_progress";

function snapshot(withQuestion) {
    return {
        activity: [{
            callId: "call-1",
            inputSummary: "bash_run command",
            startedAt: "2026-08-19T01:00:00.000Z",
            status: "running",
            toolName: "bash_run"
        }],
        approvals: window.__workspaceApprovalPending ? [{
            approvalId: "approval-browser",
            ctxId: "ctx-browser",
            inputSummary: "git push origin v0.6.6",
            riskLevel: "high",
            status: "pending",
            toolName: "bash_run"
        }] : [],
        background: [{
            detachedAt: "2026-08-19T01:00:01.000Z",
            status: "detached",
            taskId: "task-plan",
            tmuxTaskId: "task-browser",
            updatedAt: "2026-08-19T01:00:02.000Z",
            waitId: "wait-background"
        }],
        ctxId: "ctx-browser",
        cursor: 2,
        instance: "browser-instance",
        questions: withQuestion ? [{
            createdAt: "2026-08-19T01:00:00.000Z",
            createdByCtxId: "ctx-browser",
            kind: "question",
            payload: {
                allowText: false,
                choices: ["Continue"],
                question: "Continue the task?"
            },
            status: "waiting",
            targetId: "question-browser",
            updatedAt: "2026-08-19T01:00:00.000Z",
            waitId: "wait-question"
        }] : [],
        tasks: [{
            checkpoint: {
                next: "Finish re-entry controls",
                summary: "Live Workspace is connected",
                updatedAt: "2026-08-19T01:00:00.000Z"
            },
            completed: 1,
            currentItem: "Implement live Workspace",
            status: window.__taskStatus,
            taskId: "task-plan",
            title: "v0.6 feature train",
            total: 7
        }],
        waits: []
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
            params: { arguments: { ctxId: "ctx-browser" } }
        }, "*");
        reply({ protocolVersion: "2026-01-26" });
        return;
    }
    if (message.method === "ui/update-model-context") {
        window.__modelContextUpdates.push(message.params || {});
        window.__bridgeEvents.push("context");
        reply({});
        return;
    }
    if (message.method === "ui/message") {
        window.__modelMessages.push(message.params || {});
        window.__bridgeEvents.push("message");
        reply({});
        return;
    }
    if (message.method !== "tools/call") return;

    var call = message.params || {};
    window.__workspaceCalls.push(call);
    if (call.name === "workspace_snapshot") {
        reply({
            _meta: { "portable-devshell/workspace": { token: "browser-secret-token" } },
            structuredContent: window.__workspaceWatchCount > 0
                ? snapshot(!window.__workspaceQuestionAnswered)
                : Object.assign(snapshot(false), { activity: [], background: [], cursor: 1 })
        });
        return;
    }
    if (call.name === "workspace_watch") {
        window.__workspaceWatchCount += 1;
        if (window.__workspaceWatchCount === 1) {
            reply({
                _meta: { "portable-devshell/workspace": { token: "browser-secret-token" } },
                structuredContent: { changed: true, cursor: 2, snapshot: snapshot(true) }
            });
        }
        return;
    }
    if (call.name === "workspace_question_answer") {
        window.__workspaceQuestionAnswered = true;
        reply({ structuredContent: { answer: "Continue", detached: true, taskId: "task-plan", waitId: "wait-question" } });
        return;
    }
    if (call.name === "workspace_approval_decide") {
        window.__workspaceApprovalPending = false;
        reply({ structuredContent: { approvalId: call.arguments.approvalId, status: "approved" } });
        return;
    }
    if (call.name === "workspace_task_control") {
        if (call.arguments.action === "pause") window.__taskStatus = "paused";
        if (call.arguments.action === "resume") window.__taskStatus = "in_progress";
        if (call.arguments.action === "cancel") window.__taskStatus = "cancelled";
        reply({ structuredContent: { taskId: call.arguments.taskId } });
    }
});
`;

const RECOVERY_BRIDGE_SCRIPT = String.raw`
window.__workspaceCalls = [];
window.__modelMessages = [];
window.__bridgeEvents = [];
window.__recovered = false;

function recoverySnapshot() {
    return {
        activity: [],
        approvals: [],
        background: window.__recovered ? [] : [{
            detachedAt: "2026-08-19T01:00:01.000Z",
            status: "resolved",
            taskId: "task-recovery",
            tmuxTaskId: "tmux-recovery",
            updatedAt: "2026-08-19T01:00:02.000Z",
            waitId: "wait-recovery"
        }],
        ctxId: "ctx-recovery",
        cursor: 1,
        instance: "browser-instance",
        questions: [],
        tasks: [{
            checkpoint: {
                next: "Inspect the completed background result",
                summary: "The long-running command was detached",
                updatedAt: "2026-08-19T01:00:00.000Z"
            },
            completed: 1,
            currentItem: "Wait for background work",
            status: "in_progress",
            taskId: "task-recovery",
            title: "Recovery task",
            total: 2
        }],
        waits: []
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
            params: { arguments: { ctxId: "ctx-recovery" } }
        }, "*");
        reply({ protocolVersion: "2026-01-26" });
        return;
    }
    if (message.method === "ui/update-model-context") {
        window.__bridgeEvents.push("context");
        reply({});
        return;
    }
    if (message.method === "ui/message") {
        window.__modelMessages.push(message.params || {});
        window.__bridgeEvents.push("message");
        reply({});
        return;
    }
    if (message.method !== "tools/call") return;

    var call = message.params || {};
    window.__workspaceCalls.push(call);
    if (call.name === "workspace_snapshot") {
        reply({
            _meta: { "portable-devshell/workspace": { token: "recovery-secret-token" } },
            structuredContent: recoverySnapshot()
        });
        return;
    }
    if (call.name === "workspace_watch") {
        reply({ structuredContent: { changed: false, cursor: 1 } });
        return;
    }
    if (call.name === "workspace_wait_recover") {
        window.__recovered = true;
        reply({
            structuredContent: {
                result: { task: { status: "0" } },
                taskId: "task-recovery",
                tmuxTaskId: "tmux-recovery",
                waitId: "wait-recovery"
            }
        });
    }
});
`;

const RESUME_BRIDGE_SCRIPT = String.raw`
window.__workspaceCalls = [];
window.__modelMessages = [];
window.__taskStatus = "paused";

function resumeSnapshot() {
    return {
        activity: [], approvals: [], questions: [], waits: [],
        background: [{
            detachedAt: "2026-08-19T01:00:01.000Z",
            status: "resolved",
            taskId: "task-resume",
            tmuxTaskId: "tmux-resume",
            updatedAt: "2026-08-19T01:00:02.000Z",
            waitId: "wait-resume"
        }],
        ctxId: "ctx-resume",
        cursor: 1,
        instance: "browser-instance",
        tasks: [{
            checkpoint: {
                summary: "Resume from this checkpoint",
                updatedAt: "2026-08-19T01:00:00.000Z"
            },
            completed: 1,
            currentItem: "Continue work",
            status: window.__taskStatus,
            taskId: "task-resume",
            title: "Resume task",
            total: 2
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
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: { ctxId: "ctx-resume" } }
        }, "*");
        reply({ protocolVersion: "2026-01-26" });
        return;
    }
    if (message.method === "ui/update-model-context") {
        reply({});
        return;
    }
    if (message.method === "ui/message") {
        window.__modelMessages.push(message.params || {});
        reply({});
        return;
    }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    window.__workspaceCalls.push(call);
    if (call.name === "workspace_snapshot") {
        reply({
            _meta: { "portable-devshell/workspace": { token: "resume-secret-token" } },
            structuredContent: resumeSnapshot()
        });
        return;
    }
    if (call.name === "workspace_watch") return;
    if (call.name === "workspace_task_control") {
        window.__taskStatus = "in_progress";
        reply({ structuredContent: { taskId: "task-resume" } });
        return;
    }
    if (call.name === "workspace_wait_recover") {
        reply({ structuredContent: { taskId: "task-resume", waitId: "wait-resume" } });
    }
});
`;
const DETACHED_INTERACTION_BRIDGE_SCRIPT = String.raw`
window.__modelMessages = [];
window.__questionAnswered = false;

function detachedInteractionSnapshot() {
    return {
        activity: [], approvals: [], waits: [],
        background: [{
            detachedAt: "2026-08-19T01:00:01.000Z",
            status: "detached",
            taskId: "task-detached",
            tmuxTaskId: "tmux-detached",
            updatedAt: "2026-08-19T01:00:02.000Z",
            waitId: "wait-background-detached"
        }],
        ctxId: "ctx-detached",
        cursor: 1,
        instance: "browser-instance",
        questions: window.__questionAnswered ? [] : [{
            createdAt: "2026-08-19T01:00:00.000Z",
            createdByCtxId: "ctx-detached",
            kind: "question",
            payload: { allowText: false, choices: ["Continue"], question: "Continue after restart?" },
            status: "detached",
            targetId: "question-detached",
            taskId: "task-detached",
            updatedAt: "2026-08-19T01:00:00.000Z",
            waitId: "wait-question-detached"
        }],
        tasks: [{
            checkpoint: { summary: "Recovered after host restart", updatedAt: "2026-08-19T01:00:00.000Z" },
            completed: 1,
            currentItem: "Continue recovered work",
            status: "in_progress",
            taskId: "task-detached",
            title: "Detached interaction task",
            total: 2
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
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: { ctxId: "ctx-detached" } }
        }, "*");
        reply({ protocolVersion: "2026-01-26" });
        return;
    }
    if (message.method === "ui/update-model-context") {
        reply({});
        return;
    }
    if (message.method === "ui/message") {
        window.__modelMessages.push(message.params || {});
        setTimeout(function () { reply({}); }, 250);
        return;
    }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    if (call.name === "workspace_snapshot") {
        reply({
            _meta: { "portable-devshell/workspace": { token: "detached-secret-token" } },
            structuredContent: detachedInteractionSnapshot()
        });
        return;
    }
    if (call.name === "workspace_watch") {
        reply({ structuredContent: { changed: false, cursor: 1 } });
        return;
    }
    if (call.name === "workspace_question_answer") {
        window.__questionAnswered = true;
        reply({ structuredContent: {
            answer: call.arguments.answer,
            detached: true,
            taskId: "task-detached",
            waitId: "wait-question-detached"
        } });
    }
});
`;
