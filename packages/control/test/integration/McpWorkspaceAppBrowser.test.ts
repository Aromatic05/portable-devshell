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
    await app.getByText("Continue the task?", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await app.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(
        await app.locator("html").evaluate((element) => element.style.getPropertyValue("--color-text-primary")),
        "rgb(12, 34, 56)"
    );
    await page.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        iframe?.contentWindow?.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/host-context-changed",
            params: { theme: "light", styles: { variables: { "--color-text-primary": "rgb(65, 43, 21)" } } }
        }, "*");
    });
    await page.waitForFunction(() => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        return iframe?.contentDocument?.documentElement.getAttribute("data-theme") === "light";
    });
    assert.equal(
        await app.locator("html").evaluate((element) => element.style.getPropertyValue("--color-text-primary")),
        "rgb(65, 43, 21)"
    );
    await app.getByText("workspace_ask", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("workspace_goal", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Ship Workspace Goal mode", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await app.getByRole("button", { name: "Stop Goal", exact: true }).count(), 1);
    const choice = app.locator('[data-question-choice="wait-question"]');
    await choice.first().waitFor({ state: "visible" });
    assert.equal(await choice.count(), 5);
    const choiceListSize = await app.locator(".choice-list").evaluate((element) => ({
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
        scrollHeight: element.scrollHeight,
    }));
    assert.equal(choiceListSize.scrollHeight, choiceListSize.clientHeight);
    assert.notEqual(choiceListSize.overflowY, "auto");
    assert.notEqual(choiceListSize.overflowY, "scroll");
    assert.equal(await choice.first().evaluate((element) => element.tagName), "BUTTON");
    assert.equal(await choice.first().evaluate((element) => getComputedStyle(element).borderRadius), "0px");
    assert.equal(await app.getByRole("button", { name: "Continue", exact: true }).count(), 1);
    assert.equal(await app.locator("body").evaluate((element) => element.scrollHeight <= 520), true);
    await app.getByRole("button", { name: "Show 7 more", exact: true }).click();
    assert.equal(await choice.count(), 12);
    assert.equal(await app.getByText("Activity", { exact: true }).count(), 0);
    assert.equal(await app.getByText("Background", { exact: true }).count(), 0);
    await page.waitForFunction("(window.__modelContextUpdates || []).length >= 2");
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);

    await choice.first().click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_question_answer')");
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);

    await app.getByText("approval.decision", { exact: false }).waitFor({ state: "visible" });
    await app.getByRole("button", { name: "Approve", exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_approval_decide')");
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);

    await app.getByText("tmux_run", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("event · tmux.task.completed", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("task-browser", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Interrupt wait", { exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_wait_interrupt')");
    await app.getByText("No blocking event.", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
    await app.getByRole("button", { name: "Stop Goal", exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_goal_stop')");
    await app.getByText("stopped", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
    await page.waitForFunction("(window.__workspaceWatchCount || 0) >= 2");

    await page.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        iframe?.contentWindow?.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-cancelled",
            params: { reason: "test cancellation" }
        }, "*");
    });
    assert.equal(await page.evaluate("window.__emitWorkspaceQuestionAfterCancellation()"), true);
    await app.getByText("Question after cancellation?", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.evaluate("(window.__workspaceCancelledRequests || []).length"), 0);

    const calls = await page.evaluate("window.__workspaceCalls || []") as Array<{
        arguments?: Record<string, unknown>;
        name?: string;
    }>;
    const snapshotCall = calls.find((call) => call.name === "workspace_snapshot");
    const watchCall = calls.find((call) => call.name === "workspace_watch");
    const answerCall = calls.find((call) => call.name === "workspace_question_answer");
    const approvalCall = calls.find((call) => call.name === "workspace_approval_decide");
    const goalStopCall = calls.find((call) => call.name === "workspace_goal_stop");
    const interruptCall = calls.find((call) => call.name === "workspace_wait_interrupt");

    assert.equal(snapshotCall?.arguments?.token, undefined);
    assert.equal(watchCall?.arguments?.token, undefined);
    assert.equal(answerCall?.arguments?.token, "browser-secret-token");
    assert.equal(answerCall?.arguments?.ctxId, "ctx-browser");
    assert.equal(answerCall?.arguments?.waitId, "wait-question");
    assert.equal(approvalCall?.arguments?.token, "browser-secret-token");
    assert.equal(approvalCall?.arguments?.decision, "approve");
    assert.equal(goalStopCall?.arguments?.token, "browser-secret-token");
    assert.equal(goalStopCall?.arguments?.ctxId, "ctx-browser");
    assert.equal(interruptCall?.arguments?.token, "browser-secret-token");
    assert.equal(interruptCall?.arguments?.waitId, "wait-background");
    assert.deepEqual(browserFailures, []);
});

test("Workspace Goal requests one model continuation after inactivity", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    const browserFailures: string[] = [];
    page.on("console", (message) => {
        if (message.type() === "error") browserFailures.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => browserFailures.push(`pageerror: ${error.message}`));
    await page.setContent('<iframe id="workspace" style="width:800px;height:500px"></iframe>');
    await page.evaluate(BRIDGE_SCRIPT);
    await page.evaluate(() => {
        const state = window as typeof window & {
            __workspaceApprovalPending: boolean;
            __workspaceGoalDueNow: boolean;
            __workspaceQuestionAnswered: boolean;
            __workspaceWaitInterrupted: boolean;
        };
        state.__workspaceGoalDueNow = true;
        state.__workspaceQuestionAnswered = true;
        state.__workspaceApprovalPending = false;
        state.__workspaceWaitInterrupted = true;
    });
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__modelMessages || []).length === 1");
    await page.waitForFunction("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_goal_continue').length >= 3");
    const continuationCalls = await page.evaluate(
        "(window.__workspaceCalls || []).filter(call => call.name === 'workspace_goal_continue')",
    ) as Array<{ arguments?: Record<string, unknown> }>;
    assert.equal(continuationCalls[0]?.arguments?.action, "claim");
    assert.equal(continuationCalls[1]?.arguments?.action, "validate");
    assert.equal(continuationCalls[2]?.arguments?.action, "report");
    assert.equal(continuationCalls[2]?.arguments?.accepted, true);
    assert.equal(await page.evaluate("(window.__goalContinuationReports || []).length"), 1);
    assert.deepEqual(browserFailures, []);
});

test("Workspace Goal respects continuation retry backoff", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:500px"></iframe>');
    await page.evaluate(BRIDGE_SCRIPT);
    await page.evaluate(() => {
        const state = window as typeof window & {
            __workspaceApprovalPending: boolean;
            __workspaceGoalDueNow: boolean;
            __workspaceGoalRetryAfter: string;
            __workspaceQuestionAnswered: boolean;
            __workspaceWaitInterrupted: boolean;
        };
        state.__workspaceGoalDueNow = true;
        state.__workspaceGoalRetryAfter = new Date(Date.now() + 5 * 60_000).toISOString();
        state.__workspaceQuestionAnswered = true;
        state.__workspaceApprovalPending = false;
        state.__workspaceWaitInterrupted = true;
    });
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await page.frameLocator("#workspace").getByText("Ship Workspace Goal mode", { exact: true }).waitFor({ state: "visible" });
    await page.waitForTimeout(250);
    assert.equal(
        await page.evaluate("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_goal_continue').length"),
        0,
    );
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
});

test("Workspace Stop fences an in-flight Goal continuation before model re-entry", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:500px"></iframe>');
    await page.evaluate(BRIDGE_SCRIPT);
    await page.evaluate(() => {
        const state = window as typeof window & {
            __holdGoalContinuationContext: boolean;
            __workspaceApprovalPending: boolean;
            __workspaceGoalDueNow: boolean;
            __workspaceQuestionAnswered: boolean;
            __workspaceWaitInterrupted: boolean;
        };
        state.__holdGoalContinuationContext = true;
        state.__workspaceGoalDueNow = true;
        state.__workspaceQuestionAnswered = true;
        state.__workspaceApprovalPending = false;
        state.__workspaceWaitInterrupted = true;
    });
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await page.waitForFunction("window.__pendingGoalContinuationContext != null");
    const app = page.frameLocator("#workspace");
    await app.getByRole("button", { name: "Stop Goal", exact: true }).click();
    await app.getByText("stopped", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.evaluate("window.__releaseGoalContinuationContext()"), true);
    await page.waitForFunction("(window.__goalContinuationReports || []).length === 1");
    await page.waitForTimeout(100);

    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
    const reports = await page.evaluate("window.__goalContinuationReports || []") as Array<{ accepted?: boolean }>;
    assert.equal(reports[0]?.accepted, false);
});

test("Workspace Goal does not continue while a detached wait is still pending", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:500px"></iframe>');
    await page.evaluate(BRIDGE_SCRIPT);
    await page.evaluate(() => {
        const state = window as typeof window & {
            __workspaceApprovalPending: boolean;
            __workspaceBackgroundDetached: boolean;
            __workspaceGoalDueNow: boolean;
            __workspaceQuestionAnswered: boolean;
            __workspaceWaitInterrupted: boolean;
        };
        state.__workspaceGoalDueNow = true;
        state.__workspaceQuestionAnswered = true;
        state.__workspaceApprovalPending = false;
        state.__workspaceWaitInterrupted = true;
        state.__workspaceBackgroundDetached = true;
    });
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await page.frameLocator("#workspace").getByText("Ship Workspace Goal mode", { exact: true }).waitFor({ state: "visible" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
    assert.equal(
        await page.evaluate("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_goal_continue').length"),
        0,
    );
});

test("Workspace App uses OpenAI session context without sending or injecting ctxId", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    const browserFailures: string[] = [];
    page.on("console", (message) => {
        if (message.type() === "error") browserFailures.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => browserFailures.push(`pageerror: ${error.message}`));
    await page.setContent('<iframe id="workspace" style="width:800px;height:320px"></iframe>');
    await page.evaluate(SESSION_MODE_BRIDGE_SCRIPT);
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    await app.getByText("Session mode question?", { exact: true }).waitFor({ state: "visible" });
    await app.locator('[data-question-choice="wait-session-question"]').click();
    await page.waitForFunction("(window.__sessionModeCalls || []).some(call => call.name === 'workspace_question_answer')");

    const calls = await page.evaluate("window.__sessionModeCalls || []") as Array<{
        arguments?: Record<string, unknown>;
        name?: string;
    }>;
    assert.equal(calls.some((call) => Object.hasOwn(call.arguments ?? {}, "ctxId")), false);
    const answer = calls.find((call) => call.name === "workspace_question_answer");
    assert.equal(answer?.arguments?.token, "session-mode-token");
    assert.equal(answer?.arguments?.waitId, "wait-session-question");

    const contexts = await page.evaluate("window.__sessionModeContexts || []") as Array<{
        structuredContent?: { portableDevshellWorkspace?: Record<string, unknown> };
    }>;
    assert.equal(contexts.length > 0, true);
    assert.equal(
        contexts.some((entry) => Object.hasOwn(entry.structuredContent?.portableDevshellWorkspace ?? {}, "ctxId")),
        false
    );
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
    await page.waitForFunction("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_wait_recover').length === 2");

    const firstEvents = await page.evaluate("window.__bridgeEvents || []") as string[];
    const firstMessage = firstEvents.indexOf("message");
    assert.equal(firstMessage > 0 && firstEvents[firstMessage - 1] === "context", true);

    await mount();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 1);
    assert.equal(await page.evaluate("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_wait_recover').length"), 2);

    const recoverCalls = await page.evaluate(
        "(window.__workspaceCalls || []).filter(call => call.name === 'workspace_wait_recover')",
    ) as Array<{ arguments?: Record<string, unknown> }>;
    assert.equal(recoverCalls[0]?.arguments?.action, "claim");
    assert.equal(recoverCalls[0]?.arguments?.token, "recovery-secret-token");
    assert.equal(recoverCalls[0]?.arguments?.waitId, "wait-recovery");
    assert.equal(recoverCalls[1]?.arguments?.action, "complete");
    assert.equal(recoverCalls[1]?.arguments?.claimId, "recovery-claim");
});

test("Workspace Goal recovers a resolved detached wait without Todo", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:900px"></iframe>');
    await page.evaluate(RECOVERY_BRIDGE_SCRIPT);
    await page.evaluate(() => {
        (window as typeof window & { __goalRecovery: boolean }).__goalRecovery = true;
    });
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__modelMessages || []).length === 1");
    await page.waitForFunction("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_wait_recover').length === 2");
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 1);
});

test("Workspace recovers an unassociated resolved wait by Context", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:900px"></iframe>');
    await page.evaluate(RECOVERY_BRIDGE_SCRIPT);
    await page.evaluate(() => {
        (window as typeof window & { __unassociatedRecovery: boolean }).__unassociatedRecovery = true;
    });
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__modelMessages || []).length === 1");
    await page.waitForFunction("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_wait_recover').length === 2");
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 1);
});

test("Workspace does not surface a detached tmux wait as another blocking event", BROWSER_TEST_OPTIONS, async (t) => {
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
    await app.getByText("No blocking event.", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
    assert.equal(await page.evaluate("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_wait_recover').length"), 0);
});

test("Workspace re-enters after a detached answer without surfacing detached tmux state", BROWSER_TEST_OPTIONS, async (t) => {
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
    await app.locator('[data-question-choice="wait-question-detached"]').click();
    await page.waitForFunction("(window.__modelMessages || []).length === 1");
    await app.getByText("No blocking event.", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await app.getByRole("button", { name: "Resume agent", exact: true }).count(), 0);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 1);
});

test("Workspace remount follows current ChatGPT tool output and falls back to widget state", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:320px"></iframe>');
    await page.evaluate(REMOUNT_BRIDGE_SCRIPT);
    const mount = async (globals: string) => await page.evaluate(({ html, globals }) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html.replace("<script>", `<script>window.openai = ${globals};<\/script><script>`);
    }, { html: workspaceAppHtml, globals });

    await mount(`{
        widgetState: { portableDevshellWorkspace: { ctxId: "ctx-widget-stale" } },
        toolResponseMetadata: { mcp_tool_result: { structuredContent: { ctxId: "ctx-stale" } } },
        toolOutput: { ctxId: "ctx-current" },
        setWidgetState: function (state) {
            this.widgetState = state;
        }
    }`);
    await page.waitForFunction("(window.__remountCalls || []).some(call => call.name === 'workspace_snapshot' && call.arguments.ctxId === 'ctx-current')");
    await page.waitForTimeout(100);
    const currentFrame = page.frames().find((frame) => frame !== page.mainFrame());
    assert.equal(
        await currentFrame?.evaluate("window.openai.widgetState.portableDevshellWorkspace.ctxId"),
        "ctx-current"
    );

    await page.evaluate("window.__remountCalls = []");
    await mount(`{
        widgetState: { portableDevshellWorkspace: { ctxId: "ctx-widget-only" } },
        setWidgetState: function (state) { this.widgetState = state; }
    }`);
    await page.waitForFunction("(window.__remountCalls || []).some(call => call.name === 'workspace_snapshot' && call.arguments.ctxId === 'ctx-widget-only')");
    assert.equal(await page.evaluate("(window.__remountCalls || []).some(call => call.arguments.ctxId === 'ctx-stale')"), false);
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

const REMOUNT_BRIDGE_SCRIPT = String.raw`
window.__remountCalls = [];
window.addEventListener("message", function (event) {
    if (event.source === window || !event.data || event.data.jsonrpc !== "2.0") return;
    var source = event.source;
    var message = event.data;
    function reply(result) {
        if (message.id === undefined) return;
        source.postMessage({ id: message.id, jsonrpc: "2.0", result: result }, "*");
    }
    if (message.method === "ui/initialize") {
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
    window.__remountCalls.push(call);
    if (call.name === "workspace_snapshot") {
        reply({
            _meta: { "portable-devshell/workspace": { token: "remount-token" } },
            structuredContent: {
                activity: [], approvals: [], background: [], currentEvent: null, questions: [], tasks: [], waits: [],
                contextSelector: { requiresExplicitContextId: true },
                ctxId: call.arguments.ctxId, cursor: 1, instance: "browser-instance"
            }
        });
        return;
    }
    if (call.name === "workspace_watch") return;
});
`;

const BRIDGE_SCRIPT = String.raw`
window.__workspaceCalls = [];
window.__workspaceCancelledRequests = [];
window.__workspaceQuestionAnswered = false;
window.__workspaceApprovalPending = true;
window.__workspaceWaitInterrupted = false;
window.__workspaceGoalStopped = false;
window.__workspaceGoalDueNow = false;
window.__workspaceGoalRetryAfter = "";
window.__workspaceBackgroundDetached = false;
window.__holdGoalContinuationContext = false;
window.__pendingGoalContinuationContext = null;
window.__goalContinuationReports = [];
window.__workspaceWatchCount = 0;
window.__workspacePendingWatch = null;
window.__workspaceQuestionText = "Continue the task?";
window.__workspaceCursor = 2;
window.__modelContextUpdates = [];
window.__modelMessages = [];
window.__bridgeEvents = [];
window.__taskStatus = "in_progress";

function snapshot(withQuestion) {
    var question = {
        createdAt: "2026-08-19T01:00:00.000Z",
        createdByCtxId: "ctx-browser",
        eventName: "user.answer",
        kind: "question",
        name: "workspace_ask",
        payload: {
            allowText: false,
            choices: [
                "Continue", "Option 2", "Option 3", "Option 4", "Option 5", "Option 6",
                "Option 7", "Option 8", "Option 9", "Option 10", "Option 11", "Option 12"
            ],
            question: window.__workspaceQuestionText
        },
        status: "waiting",
        targetId: "question-browser",
        updatedAt: "2026-08-19T01:00:00.000Z",
        waitId: "wait-question"
    };
    var approval = {
        approvalId: "approval-browser",
        createdAt: "2026-08-19T01:00:01.000Z",
        ctxId: "ctx-browser",
        eventName: "approval.decision",
        inputSummary: "git push origin v0.6.7",
        kind: "approval",
        name: "bash_run",
        riskLevel: "high",
        status: "waiting",
        toolName: "bash_run",
        updatedAt: "2026-08-19T01:00:01.000Z"
    };
    var tmux = {
        eventName: "tmux.task.completed",
        kind: "tmux",
        name: "tmux_run",
        status: "waiting",
        taskId: "task-plan",
        tmuxTaskId: "task-browser",
        updatedAt: "2026-08-19T01:00:02.000Z",
        waitId: "wait-background"
    };
    var currentEvent = withQuestion && !window.__workspaceQuestionAnswered
        ? question
        : window.__workspaceApprovalPending
            ? approval
            : window.__workspaceWaitInterrupted ? null : tmux;
    return {
        activity: [{
            callId: "call-1",
            inputSummary: "bash_run command",
            startedAt: "2026-08-19T01:00:00.000Z",
            status: "running",
            toolName: "bash_run"
        }],
        approvals: window.__workspaceApprovalPending ? [approval] : [],
        background: window.__workspaceWaitInterrupted && !window.__workspaceBackgroundDetached ? [] : [{
            detachedAt: new Date().toISOString(),
            status: "detached",
            taskId: "task-plan",
            tmuxTaskId: "task-browser",
            updatedAt: "2026-08-19T01:00:02.000Z",
            waitId: "wait-background"
        }],
        contextSelector: { requiresExplicitContextId: true },
        ctxId: "ctx-browser",
        currentEvent: currentEvent,
        cursor: window.__workspaceCursor,
        goal: {
            autoContinueExhausted: false,
            continuationCount: 0,
            continuationDue: window.__workspaceGoalDueNow,
            continuationDueAt: window.__workspaceGoalDueNow ? "2000-01-01T00:00:00.000Z" : "2099-08-20T01:00:00.000Z",
            continuationPending: false,
            continuationRetryAfter: window.__workspaceGoalRetryAfter || undefined,
            createdAt: "2026-08-19T01:00:00.000Z",
            goalId: "goal-browser",
            lastAgentActivityAt: "2026-08-19T01:00:00.000Z",
            maxContinuations: 10,
            objective: "Ship Workspace Goal mode",
            revision: 1,
            status: window.__workspaceGoalStopped ? "stopped" : "active",
            steps: [
                { id: "implement", status: "completed", text: "Implement Goal runtime" },
                { id: "verify", status: "active", text: "Verify Workspace UI" }
            ],
            updatedAt: "2026-08-19T01:00:00.000Z"
        },
        instance: "browser-instance",
        questions: withQuestion && !window.__workspaceQuestionAnswered ? [question] : [],
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
        reply({
            hostCapabilities: {},
            hostContext: {
                theme: "dark",
                styles: { variables: { "--color-text-primary": "rgb(12, 34, 56)" } }
            },
            hostInfo: { name: "test-host", version: "1.0.0" },
            protocolVersion: "2026-01-26"
        });
        return;
    }
    if (message.method === "ui/update-model-context") {
        window.__modelContextUpdates.push(message.params || {});
        window.__bridgeEvents.push("context");
        if (window.__holdGoalContinuationContext && JSON.stringify(message.params || {}).includes("goalContinuation")) {
            window.__pendingGoalContinuationContext = { id: message.id, source: source };
            return;
        }
        reply({});
        return;
    }
    if (message.method === "ui/message") {
        window.__modelMessages.push(message.params || {});
        window.__bridgeEvents.push("message");
        reply({});
        return;
    }
    if (message.method === "notifications/cancelled") {
        window.__workspaceCancelledRequests.push(message.params || {});
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
                : Object.assign(snapshot(false), {
                    activity: [],
                    approvals: [],
                    background: window.__workspaceBackgroundDetached ? snapshot(false).background : [],
                    currentEvent: null,
                    cursor: 1
                })
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
        } else {
            window.__workspacePendingWatch = { id: message.id, source: source };
        }
        return;
    }
    if (call.name === "workspace_question_answer") {
        window.__workspaceQuestionAnswered = true;
        reply({ structuredContent: { answer: "Continue", detached: false, taskId: "task-plan", waitId: "wait-question" } });
        return;
    }
    if (call.name === "workspace_approval_decide") {
        window.__workspaceApprovalPending = false;
        reply({ structuredContent: { approvalId: call.arguments.approvalId, status: "approved" } });
        return;
    }
    if (call.name === "workspace_wait_interrupt") {
        window.__workspaceWaitInterrupted = true;
        reply({ structuredContent: { interrupted: true, status: "cancelled", tmuxTaskId: "task-browser", waitId: "wait-background" } });
        return;
    }
    if (call.name === "workspace_goal_stop") {
        window.__workspaceGoalStopped = true;
        reply({ structuredContent: { goal: snapshot(false).goal } });
        return;
    }
    if (call.name === "workspace_goal_continue") {
        var action = call.arguments && call.arguments.action;
        if (action === "claim") {
            reply({ structuredContent: {
                claimed: call.arguments.available === true,
                claimId: call.arguments.claimId,
                continuationCount: 1,
                goal: Object.assign({}, snapshot(false).goal, { continuationDue: false, continuationPending: true })
            } });
            return;
        }
        if (action === "validate") {
            reply({ structuredContent: {
                valid: call.arguments.available === true,
                goal: Object.assign({}, snapshot(false).goal, { continuationDue: false, continuationPending: true })
            } });
            return;
        }
        if (action === "report") {
            window.__goalContinuationReports.push(call.arguments);
            window.__workspaceGoalDueNow = false;
            reply({ structuredContent: { goal: Object.assign({}, snapshot(false).goal, { continuationCount: 1 }) } });
            return;
        }
    }
});

window.__releaseGoalContinuationContext = function () {
    var pending = window.__pendingGoalContinuationContext;
    if (!pending || pending.id === undefined || !pending.source) return false;
    window.__pendingGoalContinuationContext = null;
    pending.source.postMessage({ id: pending.id, jsonrpc: "2.0", result: {} }, "*");
    return true;
};

window.__emitWorkspaceQuestionAfterCancellation = function () {
    var pending = window.__workspacePendingWatch;
    if (!pending || pending.id === undefined || !pending.source) return false;
    window.__workspacePendingWatch = null;
    window.__workspaceQuestionAnswered = false;
    window.__workspaceApprovalPending = false;
    window.__workspaceWaitInterrupted = true;
    window.__workspaceQuestionText = "Question after cancellation?";
    window.__workspaceCursor = 3;
    pending.source.postMessage({
        id: pending.id,
        jsonrpc: "2.0",
        result: {
            _meta: { "portable-devshell/workspace": { token: "browser-secret-token" } },
            structuredContent: { changed: true, cursor: 3, snapshot: snapshot(true) }
        }
    }, "*");
    return true;
};
`;

const SESSION_MODE_BRIDGE_SCRIPT = String.raw`
window.__sessionModeCalls = [];
window.__sessionModeContexts = [];
window.__sessionModeAnswered = false;

function sessionModeSnapshot() {
    var question = {
        eventName: "user.answer",
        kind: "question",
        name: "workspace_ask",
        payload: { allowText: false, choices: ["Continue"], question: "Session mode question?" },
        status: "waiting",
        taskId: "task-session",
        updatedAt: "2026-08-19T01:00:00.000Z",
        waitId: "wait-session-question"
    };
    return {
        activity: [],
        approvals: [],
        background: [],
        contextSelector: { requiresExplicitContextId: false },
        currentEvent: window.__sessionModeAnswered ? null : question,
        cursor: 1,
        instance: "browser-instance",
        questions: window.__sessionModeAnswered ? [] : [question],
        tasks: [{
            currentItem: "Session mode",
            status: "in_progress",
            taskId: "task-session",
            title: "Session task"
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
        reply({
            hostCapabilities: {},
            hostContext: {},
            hostInfo: { name: "test-host", version: "1.0.0" },
            protocolVersion: "2026-01-26"
        });
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
                _meta: { "portable-devshell/workspace": { token: "session-mode-token" } },
                content: [{ type: "text", text: "portable-devshell Workspace opened." }],
                structuredContent: sessionModeSnapshot()
            }
        }, "*");
        return;
    }
    if (message.method === "ui/update-model-context") {
        window.__sessionModeContexts.push(message.params || {});
        reply({});
        return;
    }
    if (message.method !== "tools/call") return;
    var call = message.params || {};
    window.__sessionModeCalls.push(call);
    if (call.name === "workspace_snapshot") {
        reply({
            _meta: { "portable-devshell/workspace": { token: "session-mode-token" } },
            structuredContent: sessionModeSnapshot()
        });
        return;
    }
    if (call.name === "workspace_watch") return;
    if (call.name === "workspace_question_answer") {
        window.__sessionModeAnswered = true;
        reply({ structuredContent: { answer: "Continue", detached: false, taskId: "task-session", waitId: "wait-session-question" } });
        return;
    }
});
`;

const RECOVERY_BRIDGE_SCRIPT = String.raw`
window.__workspaceCalls = [];
window.__modelMessages = [];
window.__bridgeEvents = [];
window.__recovered = false;
window.__goalRecovery = false;
window.__unassociatedRecovery = false;

function recoverySnapshot() {
    var goalMode = window.__goalRecovery;
    var unassociated = window.__unassociatedRecovery;
    return {
        activity: [],
        approvals: [],
        background: window.__recovered ? [] : [{
            detachedAt: "2026-08-19T01:00:01.000Z",
            goalId: goalMode ? "goal-recovery" : undefined,
            status: "resolved",
            taskId: goalMode || unassociated ? undefined : "task-recovery",
            tmuxTaskId: "tmux-recovery",
            updatedAt: "2026-08-19T01:00:02.000Z",
            waitId: "wait-recovery"
        }],
        ctxId: "ctx-recovery",
        cursor: 1,
        goal: goalMode ? {
            autoContinueExhausted: false,
            continuationCount: 0,
            continuationDue: false,
            continuationDueAt: "2099-08-20T01:00:00.000Z",
            continuationPending: false,
            createdAt: "2026-08-19T01:00:00.000Z",
            goalId: "goal-recovery",
            lastAgentActivityAt: "2026-08-19T01:00:00.000Z",
            maxContinuations: 10,
            objective: "Recover Goal work",
            revision: 1,
            status: "active",
            steps: [{ id: "wait", status: "active", text: "Wait for background work" }],
            updatedAt: "2026-08-19T01:00:00.000Z"
        } : undefined,
        instance: "browser-instance",
        questions: [],
        tasks: goalMode || unassociated ? [] : [{
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
        reply({
            hostCapabilities: {},
            hostContext: {},
            hostInfo: { name: "test-host", version: "1.0.0" },
            protocolVersion: "2026-01-26"
        });
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
        if (call.arguments.action === "claim") {
            reply({ structuredContent: {
                claimId: "recovery-claim",
                goalId: window.__goalRecovery ? "goal-recovery" : undefined,
                kind: "tmux",
                result: { task: { status: "0" } },
                taskId: window.__goalRecovery || window.__unassociatedRecovery ? undefined : "task-recovery",
                targetId: "tmux-recovery",
                waitId: "wait-recovery"
            } });
            return;
        }
        if (call.arguments.action === "complete") {
            window.__recovered = true;
            reply({ structuredContent: { completed: true, kind: "tmux", targetId: "tmux-recovery", waitId: "wait-recovery" } });
            return;
        }
        if (call.arguments.action === "release") {
            reply({ structuredContent: { released: true, waitId: "wait-recovery" } });
        }
    }
});
`;

const RESUME_BRIDGE_SCRIPT = String.raw`
window.__workspaceCalls = [];
window.__modelMessages = [];
window.__taskStatus = "in_progress";
window.__waitWindowInterrupted = false;

function resumeSnapshot() {
    return {
        activity: [], approvals: [], questions: [], waits: [],
        background: window.__waitWindowInterrupted ? [] : [{
            detachedAt: new Date().toISOString(),
            status: "detached",
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
    if (call.name === "workspace_wait_interrupt") {
        window.__waitWindowInterrupted = true;
        reply({ structuredContent: {
            interrupted: true,
            status: "cancelled",
            tmuxTaskId: "tmux-resume",
            waitId: "wait-resume"
        } });
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
            detachedAt: new Date().toISOString(),
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
        return;
    }
    if (call.name === "workspace_wait_recover") {
        if (call.arguments.action === "claim") {
            reply({ structuredContent: {
                claimId: "detached-recovery-claim",
                kind: "question",
                result: { answer: "Continue" },
                taskId: "task-detached",
                targetId: "question-detached",
                waitId: "wait-question-detached"
            } });
            return;
        }
        if (call.arguments.action === "complete") {
            reply({ structuredContent: { completed: true, kind: "question", targetId: "question-detached", waitId: "wait-question-detached" } });
            return;
        }
        if (call.arguments.action === "release") {
            reply({ structuredContent: { released: true, waitId: "wait-question-detached" } });
        }
    }
});
`;
