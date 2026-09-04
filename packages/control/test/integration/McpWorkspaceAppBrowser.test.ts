import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { chromium, type Browser } from "playwright";

import { workspaceAppHtml, workspaceAppVersion } from "@portable-devshell/mcp/testing";
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
    assert.deepEqual(await page.evaluate("window.__workspaceAppInfo"), {
        name: "portable-devshell-workspace",
        version: workspaceAppVersion,
    });
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
    await app.getByText("Question", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Goal", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Ship Workspace Goal mode", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("1/2 steps", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Verify Workspace UI", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await app.getByText("Implement Goal runtime", { exact: true }).count(), 0);
    assert.equal(await app.getByText("workspace_ask", { exact: true }).count(), 0);
    assert.equal(await app.getByText("workspace_goal", { exact: true }).count(), 0);
    assert.equal(await app.getByText(/event ·/u).count(), 0);
    assert.match(await app.locator(".card").first().innerText(), /Continue the task\?/u);
    assert.equal(await app.getByRole("button", { name: "Stop Goal", exact: true }).count(), 1);
    assert.equal(await app.getByRole("button", { name: "Send", exact: true }).count(), 1);
    const choice = app.locator('[data-question-choice="wait-question"]');
    await choice.first().waitFor({ state: "visible" });
    assert.equal(await choice.count(), 3);
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
    const bodyHeight = await app.locator("body").evaluate((element) => element.scrollHeight);
    assert.equal(bodyHeight <= 520, true, `Workspace height ${bodyHeight}px exceeds compact limit`);
    await app.getByRole("button", { name: "Show 9 more", exact: true }).click();
    assert.equal(await choice.count(), 12);
    assert.equal(await app.getByText("Activity", { exact: true }).count(), 0);
    assert.equal(await app.getByText("Background", { exact: true }).count(), 0);
    await page.waitForFunction("(window.__modelContextUpdates || []).length >= 2");
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);

    await choice.first().click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_answer')");
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);

    await app.getByText("Approval", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Approval required", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("High risk", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("git push origin v0.6.7", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Publishing a release changes the remote repository.", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await app.getByText("approval.decision", { exact: false }).count(), 0);
    await app.getByRole("button", { name: "Approve", exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_approval')");
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);

    await app.getByText("Background task", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Waiting for task to finish", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await app.getByText("tmux_run", { exact: true }).count(), 0);
    assert.equal(await app.getByText("task-browser", { exact: true }).count(), 0);
    await app.getByText("Stop waiting", { exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_interrupt')");
    assert.equal(await app.getByText("No blocking event.", { exact: true }).count(), 0);
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
    await app.getByRole("button", { name: "Stop Goal", exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_stop')");
    await page.waitForFunction(() => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        return !iframe?.contentDocument?.body.textContent?.includes("Ship Workspace Goal mode");
    });
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
    await app.getByText("Task · v0.6 feature train", { exact: true }).waitFor({ state: "visible" });
    await app.getByRole("button", { name: "Pause task", exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_task' && call.arguments.action === 'pause')");
    await app.getByText("Paused", { exact: true }).waitFor({ state: "visible" });
    await app.getByRole("button", { name: "Resume task", exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_task' && call.arguments.action === 'resume')");
    await page.waitForFunction("(window.__modelMessages || []).length === 1");
    await app.getByText("Running", { exact: true }).waitFor({ state: "visible" });
    await app.getByRole("button", { name: "Cancel task", exact: true }).click();
    await app.getByRole("button", { name: "Confirm cancel", exact: true }).waitFor({ state: "visible" });
    assert.equal(
        await page.evaluate("(window.__workspaceCalls || []).some(call => call.name === 'workspace_task' && call.arguments.action === 'cancel')"),
        false,
    );
    await app.getByRole("button", { name: "Confirm cancel", exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_task' && call.arguments.action === 'cancel')");
    await app.getByText("Task · v0.6 feature train", { exact: true }).waitFor({ state: "detached" });
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
    const answerCall = calls.find((call) => call.name === "workspace_answer");
    const approvalCall = calls.find((call) => call.name === "workspace_approval");
    const goalStopCall = calls.find((call) => call.name === "workspace_stop");
    const interruptCall = calls.find((call) => call.name === "workspace_interrupt");
    const taskPauseCall = calls.find((call) => call.name === "workspace_task" && call.arguments?.action === "pause");
    const taskResumeCall = calls.find((call) => call.name === "workspace_task" && call.arguments?.action === "resume");
    const taskCancelCall = calls.find((call) => call.name === "workspace_task" && call.arguments?.action === "cancel");

    assert.equal(snapshotCall?.arguments?.token, "browser-secret-token");
    assert.equal(watchCall?.arguments?.token, "browser-secret-token");
    assert.equal(answerCall?.arguments?.token, "browser-secret-token");
    assert.equal(answerCall?.arguments?.ctxId, "ctx-browser");
    assert.equal(answerCall?.arguments?.waitId, "wait-question");
    assert.equal(approvalCall?.arguments?.token, "browser-secret-token");
    assert.equal(approvalCall?.arguments?.decision, "approve");
    assert.equal(goalStopCall?.arguments?.token, "browser-secret-token");
    assert.equal(goalStopCall?.arguments?.ctxId, "ctx-browser");
    assert.equal(goalStopCall?.arguments?.goalId, "goal-browser");
    assert.equal(goalStopCall?.arguments?.revision, 1);
    assert.equal(interruptCall?.arguments?.token, "browser-secret-token");
    assert.equal(interruptCall?.arguments?.waitId, "wait-background");
    assert.equal(taskPauseCall?.arguments?.taskId, "task-plan");
    assert.equal(taskPauseCall?.arguments?.revision, 1);
    assert.equal(taskPauseCall?.arguments?.token, "browser-secret-token");
    assert.equal(taskResumeCall?.arguments?.taskId, "task-plan");
    assert.equal(taskResumeCall?.arguments?.revision, 2);
    assert.equal(taskResumeCall?.arguments?.token, "browser-secret-token");
    assert.equal(taskCancelCall?.arguments?.taskId, "task-plan");
    assert.equal(taskCancelCall?.arguments?.revision, 3);
    assert.equal(taskCancelCall?.arguments?.token, "browser-secret-token");
    assert.deepEqual(browserFailures, []);
});

test("Workspace blocked Goal shows its reason and can be resumed by the user", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());
    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:420px"></iframe>');
    await page.evaluate(BRIDGE_SCRIPT);
    await page.evaluate(() => {
        const state = window as typeof window & {
            __workspaceApprovalPending: boolean;
            __workspaceGoalBlocked: boolean;
            __workspaceQuestionAnswered: boolean;
            __workspaceWaitInterrupted: boolean;
        };
        state.__workspaceApprovalPending = false;
        state.__workspaceGoalBlocked = true;
        state.__workspaceQuestionAnswered = true;
        state.__workspaceWaitInterrupted = true;
    });
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    await app.getByText("Blocked", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Waiting for user decision", { exact: true }).waitFor({ state: "visible" });
    await app.getByRole("button", { name: "Resume Goal", exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_resume')");
    const resumeCall = await page.evaluate(
        "(window.__workspaceCalls || []).find(call => call.name === 'workspace_resume')",
    ) as { arguments?: Record<string, unknown> } | undefined;
    assert.equal(resumeCall?.arguments?.goalId, "goal-browser");
    assert.equal(resumeCall?.arguments?.revision, 1);
    assert.equal(resumeCall?.arguments?.token, "browser-secret-token");
    await page.waitForFunction("(window.__modelMessages || []).length === 1");
    await page.waitForFunction("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_reentry' && ['claim','validate','attempt','report'].includes(call.arguments.action)).length >= 3");
    await page.waitForTimeout(100);
    const explicitClaimId = await page.evaluate("(window.__workspaceCalls || []).find(call => call.name === 'workspace_reentry' && call.arguments.action === 'claim' && call.arguments.intent === 'goal-resume')?.arguments.claimId") as string;
    const continuationCalls = await page.evaluate((claimId) =>
        ((window as typeof window & { __workspaceCalls?: Array<{ arguments?: Record<string, unknown>; name?: string }> }).__workspaceCalls || [])
            .filter((call) => call.name === "workspace_reentry" && call.arguments?.claimId === claimId),
        explicitClaimId,
    ) as Array<{ arguments?: Record<string, unknown> }>;
    assert.deepEqual(continuationCalls.map((call) => call.arguments?.action), ["claim", "validate", "attempt", "report"]);
    assert.equal(continuationCalls[0]?.arguments?.intent, "goal-resume");
    assert.equal(continuationCalls[0]?.arguments?.sourceId, "goal-browser");
    assert.equal(continuationCalls.every((call) => call.arguments?.token === "browser-secret-token"), true);
    await app.getByText("Active", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await app.getByRole("button", { name: "Resume Goal", exact: true }).count(), 0);
});

test("Workspace fences an ambiguous user-initiated Goal resume before Host dispatch replay", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());
    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:420px"></iframe>');
    await page.evaluate(BRIDGE_SCRIPT);
    await page.evaluate(() => {
        const state = window as typeof window & {
            __ambiguousNextModelMessage: boolean;
            __workspaceApprovalPending: boolean;
            __workspaceGoalBlocked: boolean;
            __workspaceQuestionAnswered: boolean;
            __workspaceWaitInterrupted: boolean;
        };
        state.__ambiguousNextModelMessage = true;
        state.__workspaceApprovalPending = false;
        state.__workspaceGoalBlocked = true;
        state.__workspaceQuestionAnswered = true;
        state.__workspaceWaitInterrupted = true;
    });
    const mount = async () => await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await mount();
    const app = page.frameLocator("#workspace");
    await app.getByRole("button", { name: "Resume Goal", exact: true }).click();
    await page.waitForFunction("(window.__modelMessages || []).length === 1");
    await page.waitForFunction("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_reentry' && ['claim','validate','attempt','report'].includes(call.arguments.action)).length >= 3");
    await page.waitForTimeout(100);
    const ambiguousClaimId = await page.evaluate("(window.__workspaceCalls || []).find(call => call.name === 'workspace_reentry' && call.arguments.action === 'claim' && call.arguments.intent === 'goal-resume')?.arguments.claimId") as string;
    assert.deepEqual(
        await page.evaluate((claimId) =>
            ((window as typeof window & { __workspaceCalls?: Array<{ arguments?: Record<string, unknown>; name?: string }> }).__workspaceCalls || [])
                .filter((call) => call.name === "workspace_reentry" && call.arguments?.claimId === claimId)
                .map((call) => call.arguments?.action),
            ambiguousClaimId,
        ),
        ["claim", "validate", "attempt", "report"],
    );
    assert.equal(await page.evaluate("window.__workspaceReentryReports.at(-1).outcome"), "uncertain");

    await mount();
    await app.getByText("Active", { exact: true }).waitFor({ state: "visible" });
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 1);
    assert.equal(await page.evaluate("window.__workspaceReentryReports.filter(report => report.outcome === 'uncertain').length"), 1);
    assert.equal(
        await page.evaluate((claimId) =>
            ((window as typeof window & { __workspaceCalls?: Array<{ arguments?: Record<string, unknown>; name?: string }> }).__workspaceCalls || [])
                .filter((call) => call.name === "workspace_reentry" && call.arguments?.action === "attempt" && call.arguments?.claimId === claimId).length,
            ambiguousClaimId,
        ),
        1,
    );
});

test("Workspace user can pause an active Goal without triggering model re-entry", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:500px"></iframe>');
    await page.evaluate(BRIDGE_SCRIPT);
    await page.evaluate(() => {
        const state = window as typeof window & {
            __workspaceApprovalPending: boolean;
            __workspaceGoalDueNow: boolean;
            __workspaceQuestionAnswered: boolean;
            __workspaceWaitInterrupted: boolean;
        };
        state.__workspaceQuestionAnswered = true;
        state.__workspaceApprovalPending = false;
        state.__workspaceWaitInterrupted = true;
        state.__workspaceGoalDueNow = false;
    });
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    await app.getByRole("button", { name: "Pause Goal", exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_pause')");
    await app.getByText("Paused", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await app.getByRole("button", { name: "Resume Goal", exact: true }).count(), 1);
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
    assert.equal(await page.evaluate("window.__workspaceReentryMode"), "paused");
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
    await page.waitForFunction("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_reentry' && ['claim','validate','attempt','report'].includes(call.arguments.action)).length >= 4");
    const continuationText = await page.evaluate(
        "window.__modelMessages[0].content[0].text",
    ) as string;
    assert.equal(
        continuationText,
        "Finish the current Goal item shown in the Workspace context.\n\nThen immediately continue with the next Goal item.\n\nDo not stop after completing or reporting the current item.",
    );
    assert.doesNotMatch(continuationText, /Verify Workspace UI|Current task item/u);
    const goalContinuationContext = await page.evaluate(`
        (window.__modelContextUpdates || [])
            .map(update => update.structuredContent && update.structuredContent.portableDevshellWorkspace)
            .filter(state => state && state.continuation && state.continuation.kind === "goal")
            .at(-1).continuation
    `) as {
        attempt: number;
        currentItem: { id: string; text: string };
        nextItem: { id: string; kind: string; text: string };
        orderedItems: Array<{ id: string }>;
    };
    assert.equal(goalContinuationContext.attempt, 1);
    assert.equal(goalContinuationContext.currentItem.id, "verify");
    assert.equal(goalContinuationContext.currentItem.text, "Verify Workspace UI");
    assert.equal(goalContinuationContext.nextItem.id, "finish-goal");
    assert.equal(goalContinuationContext.nextItem.kind, "goal-terminal");
    assert.equal(goalContinuationContext.nextItem.text, "Complete the Goal.");
    assert.deepEqual(goalContinuationContext.orderedItems.map((item) => item.id), ["implement", "verify", "finish-goal"]);
    const automaticClaimId = await page.evaluate("window.__workspaceReentryReports.at(-1).claimId") as string;
    const continuationCalls = await page.evaluate((claimId) =>
        ((window as typeof window & { __workspaceCalls?: Array<{ arguments?: Record<string, unknown>; name?: string }> }).__workspaceCalls || [])
            .filter((call) => call.name === "workspace_reentry" && call.arguments?.claimId === claimId),
        automaticClaimId,
    ) as Array<{ arguments?: Record<string, unknown> }>;
    assert.equal(continuationCalls[0]?.arguments?.action, "claim");
    assert.equal(continuationCalls[0]?.arguments?.intent, "automatic");
    assert.equal(continuationCalls[1]?.arguments?.action, "validate");
    assert.equal(continuationCalls[2]?.arguments?.action, "attempt");
    assert.equal(continuationCalls[3]?.arguments?.action, "report");
    assert.equal(continuationCalls[3]?.arguments?.outcome, "accepted");
    assert.equal(await page.evaluate("(window.__goalContinuationReports || []).length"), 1);
    assert.deepEqual(browserFailures, []);
});


test("Workspace Goal continuation prompt preserves escalating enforcement around one boundary-crossing contract", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const cases = [
        { count: 0, expected: "Finish the current Goal item shown in the Workspace context.", forbidden: "Wake attempt" },
        { count: 1, expected: "Wake attempt 2. The previous continuation produced no verifiable execution progress.", forbidden: "Wake attempt 3." },
        { count: 2, expected: "Wake attempt 3. Repeated continuation attempts have not produced verifiable execution progress.", forbidden: "Wake attempt 4." },
        { count: 3, expected: "Wake attempt 4. You have repeatedly failed to advance an actionable Goal.", forbidden: "Critical execution failure" },
        { count: 4, expected: "Wake attempt 5. Critical execution failure: the Goal remains actionable after repeated continuation attempts without verifiable progress.", forbidden: "Wake attempt 4." },
    ];
    for (const item of cases) {
        const page = await browser.newPage();
        await page.setContent('<iframe id="workspace" style="width:800px;height:500px"></iframe>');
        await page.evaluate(BRIDGE_SCRIPT);
        await page.evaluate((count) => {
            const state = window as typeof window & {
                __workspaceApprovalPending: boolean;
                __workspaceGoalContinuationCount: number;
                __workspaceGoalDueNow: boolean;
                __workspaceQuestionAnswered: boolean;
                __workspaceWaitInterrupted: boolean;
            };
            state.__workspaceGoalContinuationCount = count;
            state.__workspaceGoalDueNow = true;
            state.__workspaceQuestionAnswered = true;
            state.__workspaceApprovalPending = false;
            state.__workspaceWaitInterrupted = true;
        }, item.count);
        await page.evaluate((html) => {
            const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
            if (iframe === null) throw new Error("Workspace iframe is missing.");
            iframe.srcdoc = html;
        }, workspaceAppHtml);
        await page.waitForFunction("(window.__modelMessages || []).length === 1");
        const text = await page.evaluate("window.__modelMessages[0].content[0].text") as string;
        assert.match(text, new RegExp(item.expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
        assert.doesNotMatch(text, new RegExp(item.forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
        assert.match(text, /Finish the current Goal item shown in the Workspace context\./u);
        assert.match(text, /Then immediately continue with the next Goal item\./u);
        assert.match(text, /Do not stop after completing or reporting the current item\./u);
        assert.doesNotMatch(text, /Verify Workspace UI|Current task item|completing the final task item completes the Goal/u);
        await page.close();
    }
});

test("Workspace user cancellation suppresses automatic Goal continuation until later agent activity", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:500px"></iframe>');
    await page.evaluate(BRIDGE_SCRIPT);
    await page.evaluate(() => {
        const state = window as typeof window & {
            __workspaceAgentBusy: boolean;
            __workspaceApprovalPending: boolean;
            __workspaceGoalDueNow: boolean;
            __workspaceQuestionAnswered: boolean;
            __workspaceWaitInterrupted: boolean;
        };
        state.__workspaceAgentBusy = true;
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

    await page.waitForFunction("(window.__workspaceWatchCount || 0) >= 2");
    await page.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        iframe?.contentWindow?.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-cancelled",
            params: { reason: "user action" }
        }, "*");
    });
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_reentry' && call.arguments.action === 'yield')");

    assert.equal(await page.evaluate("window.__emitWorkspaceSnapshotAfterCancellation()"), true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
});

test("Workspace Goal does not re-enter for a legacy active Goal with no actionable step", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:500px"></iframe>');
    await page.evaluate(BRIDGE_SCRIPT);
    await page.evaluate(() => {
        const state = window as typeof window & {
            __workspaceApprovalPending: boolean;
            __workspaceGoalDueNow: boolean;
            __workspaceGoalStepsDone: boolean;
            __workspaceQuestionAnswered: boolean;
            __workspaceWaitInterrupted: boolean;
        };
        state.__workspaceGoalDueNow = true;
        state.__workspaceGoalStepsDone = true;
        state.__workspaceQuestionAnswered = true;
        state.__workspaceApprovalPending = false;
        state.__workspaceWaitInterrupted = true;
    });
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__workspaceWatchCount || 0) >= 2");
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
});

test("Workspace Goal does not auto-continue while an Agent tool call is still running", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:500px"></iframe>');
    await page.evaluate(BRIDGE_SCRIPT);
    await page.evaluate(() => {
        const state = window as typeof window & {
            __workspaceAgentBusy: boolean;
            __workspaceApprovalPending: boolean;
            __workspaceGoalDueNow: boolean;
            __workspaceQuestionAnswered: boolean;
            __workspaceWaitInterrupted: boolean;
        };
        state.__workspaceAgentBusy = true;
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

    await page.frameLocator("#workspace").getByText("Ship Workspace Goal mode", { exact: true }).waitFor({ state: "visible" });
    await page.waitForTimeout(250);
    assert.equal(
        await page.evaluate("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_goal_continue').length"),
        0,
    );
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
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
    await page.waitForFunction(() => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        return !iframe?.contentDocument?.body.textContent?.includes("Ship Workspace Goal mode");
    });
    assert.equal(await page.evaluate("window.__releaseGoalContinuationContext()"), true);
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_reentry' && call.arguments.action === 'release')");
    await page.waitForTimeout(100);

    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
    assert.equal(await page.evaluate("(window.__goalContinuationReports || []).length"), 0);
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

test("Workspace App keeps the internal ctxId even when Context selection came from an external session", BROWSER_TEST_OPTIONS, async (t) => {
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
    await page.waitForFunction("(window.__sessionModeCalls || []).some(call => call.name === 'workspace_answer')");

    const calls = await page.evaluate("window.__sessionModeCalls || []") as Array<{
        arguments?: Record<string, unknown>;
        name?: string;
    }>;
    assert.equal(calls.length > 0, true);
    assert.equal(calls.every((call) => call.arguments?.ctxId === "ctx-session-mode"), true);
    const answer = calls.find((call) => call.name === "workspace_answer");
    assert.equal(answer?.arguments?.token, "session-mode-token");
    assert.equal(answer?.arguments?.waitId, "wait-session-question");

    const contexts = await page.evaluate("window.__sessionModeContexts || []") as Array<{
        structuredContent?: { portableDevshellWorkspace?: Record<string, unknown> };
    }>;
    assert.equal(contexts.length > 0, true);
    assert.equal(
        contexts.every((entry) => entry.structuredContent?.portableDevshellWorkspace?.ctxId === "ctx-session-mode"),
        true
    );
    assert.deepEqual(browserFailures, []);
});

test(
    "Workspace App resumes after a delayed initial tool result instead of staying in Waiting",
    BROWSER_TEST_OPTIONS,
    async (t) => {
        const browser = await launchBrowser();
        t.after(async () => await browser.close());

        const page = await browser.newPage();
        const browserFailures: string[] = [];
        page.on("console", (message) => {
            if (message.type() === "error")
                browserFailures.push(`console: ${message.text()}`);
        });
        page.on("pageerror", (error) =>
            browserFailures.push(`pageerror: ${error.message}`),
        );
        await page.setContent(
            '<iframe id="workspace" style="width:800px;height:320px"></iframe>',
        );
        await page.evaluate(DELAYED_CONTEXT_BRIDGE_SCRIPT);
        await page.evaluate((html) => {
            const iframe =
                document.querySelector<HTMLIFrameElement>("#workspace");
            if (iframe === null)
                throw new Error("Workspace iframe is missing.");
            iframe.srcdoc = html;
        }, workspaceAppHtml);

        const app = page.frameLocator("#workspace");
        await app
            .getByText("Waiting for Workspace context", { exact: true })
            .waitFor({ state: "visible" });
        assert.equal(
            await page.evaluate("window.__deliverDelayedWorkspaceContext()"),
            true,
        );
        await page.waitForFunction(
            "(window.__delayedContextCalls || []).some(call => call.name === 'workspace_reconnect' || call.name === 'workspace_snapshot')",
        );
        await app
            .getByText("Delayed context ready", { exact: true })
            .waitFor({ state: "visible" });
        assert.equal(
            await page.evaluate(
                "(window.__delayedContextCalls || []).every(call => call.arguments.ctxId === 'ctx-delayed')",
            ),
            true,
        );
        assert.deepEqual(browserFailures, []);
    },
);

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
    await page.waitForFunction("(window.__recoveryReentryReports || []).length === 1");
    const recoveryText = await page.evaluate("window.__modelMessages[0].content[0].text") as string;
    assert.equal(
        recoveryText,
        "Resume the existing execution from the Workspace continuation context.\n\nPerform the continuation operation, then continue the suspended work from its result.",
    );
    assert.doesNotMatch(recoveryText, /tmux-recovery|status 0|finish the Goal|block the Goal|workspace_goal/u);
    const waitContinuationContext = await page.evaluate(`
        (window.__recoveryModelContextUpdates || [])
            .map(update => update.structuredContent && update.structuredContent.portableDevshellWorkspace)
            .filter(state => state && state.continuation && state.continuation.kind === "wait")
            .at(-1).continuation
    `) as {
        constraints: { restartTask: boolean };
        nextOperation: { taskId: string; tool: string };
        reason: string;
        result: { task: { status: string } };
        suspendedOperation: { kind: string; taskId: string };
    };
    assert.equal(waitContinuationContext.reason, "tmux-finished");
    assert.equal(waitContinuationContext.result.task.status, "0");
    assert.equal(waitContinuationContext.suspendedOperation.kind, "tmux-wait");
    assert.equal(waitContinuationContext.suspendedOperation.taskId, "tmux-recovery");
    assert.equal(waitContinuationContext.nextOperation.tool, "tmux_read");
    assert.equal(waitContinuationContext.nextOperation.taskId, "tmux-recovery");
    assert.equal(waitContinuationContext.constraints.restartTask, false);

    const firstEvents = await page.evaluate("window.__bridgeEvents || []") as string[];
    const firstMessage = firstEvents.indexOf("message");
    assert.equal(firstMessage > 0 && firstEvents[firstMessage - 1] === "context", true);

    await mount();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 1);
    assert.equal(await page.evaluate("(window.__recoveryReentryReports || []).length"), 1);
    const recoveryClaimId = await page.evaluate("window.__recoveryReentryReports[0].claimId") as string;
    const recoverCalls = await page.evaluate((claimId) =>
        ((window as typeof window & { __workspaceCalls?: Array<{ arguments?: Record<string, unknown>; name?: string }> }).__workspaceCalls || [])
            .filter((call) => call.name === "workspace_reentry" && call.arguments?.claimId === claimId),
        recoveryClaimId,
    ) as Array<{ arguments?: Record<string, unknown> }>;
    assert.deepEqual(recoverCalls.map((call) => call.arguments?.action), ["claim", "validate", "attempt", "report"]);
    assert.equal(recoverCalls[0]?.arguments?.token, "recovery-secret-token");
    assert.equal(recoverCalls[0]?.arguments?.intent, "automatic");
    assert.equal(recoverCalls[3]?.arguments?.outcome, "accepted");
});

test("Workspace never automatically replays an uncertain detached wait", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:900px"></iframe>');
    await page.evaluate(RECOVERY_BRIDGE_SCRIPT);
    await page.evaluate(() => {
        (window as typeof window & { __recoveryAttempted: boolean }).__recoveryAttempted = true;
    });
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await page.waitForFunction(
        "(window.__workspaceCalls || []).some(call => call.name === 'workspace_snapshot' || call.name === 'workspace_reconnect')",
    );
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
    assert.equal(
        await page.evaluate("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_recover').length"),
        0,
    );
});

test("Workspace user ownership fences a ready detached wait recovery", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:900px"></iframe>');
    await page.evaluate(RECOVERY_BRIDGE_SCRIPT);
    await page.evaluate(() => {
        const state = window as typeof window & {
            __recoveryReentryMode: string;
            __recoverySuppressedAt: string;
        };
        state.__recoveryReentryMode = "user_owned";
        state.__recoverySuppressedAt = new Date().toISOString();
    });
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await page.waitForFunction(
        "(window.__workspaceCalls || []).some(call => call.name === 'workspace_snapshot' || call.name === 'workspace_reconnect')",
    );
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 0);
    assert.equal(
        await page.evaluate("(window.__workspaceCalls || []).filter(call => call.name === 'workspace_recover').length"),
        0,
    );
});

test("Workspace re-enters after a detached tmux wait deadline", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:900px"></iframe>');
    await page.evaluate(RECOVERY_BRIDGE_SCRIPT);
    await page.evaluate(() => {
        (window as typeof window & { __recoveryTimedOut: boolean }).__recoveryTimedOut = true;
    });
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    await page.waitForFunction("(window.__modelMessages || []).length === 1");
    await page.waitForFunction("(window.__recoveryReentryReports || []).length === 1");
    assert.equal(
        await page.evaluate("window.__modelMessages[0].content[0].text"),
        "Resume the existing execution from the Workspace continuation context.\n\nPerform the continuation operation, then continue the suspended work from its result.",
    );
    const timeoutContinuationContext = await page.evaluate(`
        (window.__recoveryModelContextUpdates || [])
            .map(update => update.structuredContent && update.structuredContent.portableDevshellWorkspace)
            .filter(state => state && state.continuation && state.continuation.kind === "wait")
            .at(-1).continuation
    `) as { afterResult: { operation: { kind: string; taskId: string; tool: string }; when: string }; reason: string };
    assert.equal(timeoutContinuationContext.reason, "tmux-wait-deadline-elapsed");
    assert.equal(timeoutContinuationContext.afterResult.when, "task-still-running-and-result-required");
    assert.equal(timeoutContinuationContext.afterResult.operation.kind, "blocking-wait");
    assert.equal(timeoutContinuationContext.afterResult.operation.tool, "tmux_read");
    assert.equal(timeoutContinuationContext.afterResult.operation.taskId, "tmux-recovery");
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
    await page.waitForFunction("(window.__recoveryReentryReports || []).length === 1");
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
    await page.waitForFunction("(window.__recoveryReentryReports || []).length === 1");
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 1);
});

test("Workspace Stop waiting resumes the agent after a detached tmux wait", BROWSER_TEST_OPTIONS, async (t) => {
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
    await app.getByText("Background task", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await app.getByText("No blocking event.", { exact: true }).count(), 0);
    await app.getByText("Stop waiting", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Stop waiting", { exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_interrupt')");
    await page.waitForFunction("(window.__modelMessages || []).length === 1");
    await page.waitForFunction("(window.__resumeReports || []).length === 1");
    const recoveryClaimId = await page.evaluate("window.__resumeReports[0].claimId") as string;
    const recoveryActions = await page.evaluate((claimId) =>
        ((window as typeof window & { __workspaceCalls?: Array<{ arguments?: Record<string, unknown>; name?: string }> }).__workspaceCalls || [])
            .filter((call) => call.name === "workspace_reentry" && call.arguments?.claimId === claimId)
            .map((call) => call.arguments?.action),
        recoveryClaimId,
    );
    assert.deepEqual(recoveryActions, ["claim", "validate", "attempt", "report"]);
});

test("Workspace task Resume uses an already resolved wait as its single model re-entry", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:900px"></iframe>');
    await page.evaluate(RESUME_BRIDGE_SCRIPT);
    await page.evaluate(() => {
        const state = window as typeof window & {
            __taskStatus: string;
            __waitWindowInterrupted: boolean;
        };
        state.__taskStatus = "paused";
        state.__waitWindowInterrupted = true;
    });
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    await app.getByRole("button", { name: "Resume task", exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_task' && call.arguments.action === 'resume')");
    await page.waitForFunction("(window.__resumeReports || []).length === 1");
    await page.waitForFunction("(window.__modelMessages || []).length === 1");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 1);
    assert.equal(await page.evaluate("window.__resumeReports[0].outcome"), "accepted");
});

test("Workspace task Resume ignores a background wait whose recovery ownership is disabled", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:900px"></iframe>');
    await page.evaluate(RESUME_BRIDGE_SCRIPT);
    await page.evaluate(() => {
        const state = window as typeof window & {
            __taskStatus: string;
            __waitRecoveryDisabled: boolean;
        };
        state.__taskStatus = "paused";
        state.__waitRecoveryDisabled = true;
    });
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    await app.getByRole("button", { name: "Resume task", exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_task' && call.arguments.action === 'resume')");
    await page.waitForFunction("(window.__modelMessages || []).length === 1");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 1);
    assert.equal(await page.evaluate("window.__resumeReports.length"), 1);
    assert.equal(
        await page.evaluate("(window.__workspaceCalls || []).find(call => call.name === 'workspace_reentry' && call.arguments.action === 'claim' && call.arguments.intent === 'task-resume')?.arguments.sourceId"),
        "task-resume",
    );
});

test("Workspace Goal Resume uses an already resolved wait as its single model re-entry", BROWSER_TEST_OPTIONS, async (t) => {
    const browser = await launchBrowser();
    t.after(async () => await browser.close());

    const page = await browser.newPage();
    await page.setContent('<iframe id="workspace" style="width:800px;height:900px"></iframe>');
    await page.evaluate(RESUME_BRIDGE_SCRIPT);
    await page.evaluate(() => {
        const state = window as typeof window & {
            __resumeGoalBlocked: boolean;
            __resumeGoalMode: boolean;
            __waitWindowInterrupted: boolean;
        };
        state.__resumeGoalMode = true;
        state.__resumeGoalBlocked = true;
        state.__waitWindowInterrupted = true;
    });
    await page.evaluate((html) => {
        const iframe = document.querySelector<HTMLIFrameElement>("#workspace");
        if (iframe === null) throw new Error("Workspace iframe is missing.");
        iframe.srcdoc = html;
    }, workspaceAppHtml);

    const app = page.frameLocator("#workspace");
    await app.getByRole("button", { name: "Resume Goal", exact: true }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_resume')");
    await page.waitForFunction("(window.__resumeReports || []).length === 1");
    await page.waitForFunction("(window.__modelMessages || []).length === 1");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await page.evaluate("(window.__modelMessages || []).length"), 1);
    assert.equal(await page.evaluate("window.__resumeReports[0].outcome"), "accepted");
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
    const answerRecoveryText = await page.evaluate("window.__modelMessages[0].content[0].text") as string;
    assert.equal(
        answerRecoveryText,
        "Resume the existing execution from the Workspace continuation context.\n\nPerform the continuation operation, then continue the suspended work from its result.",
    );
    assert.doesNotMatch(answerRecoveryText, /Continue|question|finish the Goal|block the Goal|workspace_goal/u);
    const answerContinuationContext = await page.evaluate(`
        (window.__detachedModelContextUpdates || [])
            .map(update => update.structuredContent && update.structuredContent.portableDevshellWorkspace)
            .filter(state => state && state.continuation && state.continuation.kind === "wait")
            .at(-1).continuation
    `) as { nextOperation: { kind: string }; reason: string; result: { answer: string } };
    assert.equal(answerContinuationContext.reason, "question-answered");
    assert.equal(answerContinuationContext.result.answer, "Continue");
    assert.equal(answerContinuationContext.nextOperation.kind, "resume-with-answer");
    await app.getByText("Background task", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await app.getByText("No blocking event.", { exact: true }).count(), 0);
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
        widgetState: {
            modelContent: null,
            privateContent: { portableDevshellWorkspace: { ctxId: "ctx-widget-stale", token: "stale-token" } },
            imageIds: []
        },
        toolResponseMetadata: { mcp_tool_result: {
            _meta: { "portable-devshell/workspace": { token: "current-token" } },
            structuredContent: { ctxId: "ctx-stale" }
        } },
        toolOutput: { ctxId: "ctx-current" },
        setWidgetState: function (state) {
            this.widgetState = state;
        }
    }`);
    await page.waitForFunction("(window.__remountCalls || []).some(call => (call.name === 'workspace_snapshot' || call.name === 'workspace_reconnect') && call.arguments.ctxId === 'ctx-current' && call.arguments.token === 'current-token')");
    await page.waitForTimeout(100);
    const currentFrame = page.frames().find((frame) => frame !== page.mainFrame());
    const currentApp = page.frameLocator("#workspace");
    await currentApp.getByText("Workspace", { exact: true }).waitFor({ state: "visible" });
    await currentApp.getByText("Ready", { exact: true }).waitFor({ state: "visible" });
    await currentApp.getByText("No active goal, task, question, approval, or background wait.", { exact: true }).waitFor({ state: "visible" });
    assert.equal(
        await currentFrame?.evaluate("window.openai.widgetState.privateContent.portableDevshellWorkspace.ctxId"),
        "ctx-current"
    );

    await page.evaluate("window.__remountCalls = []");
    await mount(`{
        widgetState: {
            modelContent: null,
            privateContent: { portableDevshellWorkspace: { ctxId: "ctx-widget-only", token: "widget-token" } },
            imageIds: []
        },
        setWidgetState: function (state) { this.widgetState = state; }
    }`);
    await page.waitForFunction("(window.__remountCalls || []).some(call => (call.name === 'workspace_snapshot' || call.name === 'workspace_reconnect') && call.arguments.ctxId === 'ctx-widget-only' && call.arguments.token === 'widget-token')");
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
    if (call.name === "workspace_snapshot" || call.name === "workspace_reconnect") {
        if (!call.arguments.token) return;
        reply({
            _meta: { "portable-devshell/workspace": { token: call.arguments.token } },
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
window.__workspaceAgentBusy = false;
window.__workspaceWaitInterrupted = false;
window.__workspaceGoalStopped = false;
window.__workspaceGoalBlocked = false;
window.__workspaceGoalPaused = false;
window.__workspaceGoalDueNow = false;
window.__workspaceGoalAttempted = false;
window.__workspaceGoalRetryAfter = "";
window.__workspaceGoalContinuationCount = 0;
window.__workspaceGoalLastAgentActivityAt = "2026-08-19T01:00:00.000Z";
window.__workspaceReentryEpoch = 0;
window.__workspaceReentryClaimId = "";
window.__workspaceReentrySuppressedAt = "";
window.__workspaceReentryMode = "automatic";
window.__rejectNextModelMessage = false;
window.__ambiguousNextModelMessage = false;
window.__workspaceBackgroundDetached = false;
window.__holdGoalContinuationContext = false;
window.__pendingGoalContinuationContext = null;
window.__goalContinuationReports = [];
window.__workspaceWatchCount = 0;
window.__workspacePendingWatch = null;
window.__workspaceQuestionText = "Continue the task?";
window.__workspaceCursor = 2;
window.__workspaceGoalStepsDone = false;
window.__modelContextUpdates = [];
window.__modelMessages = [];
window.__bridgeEvents = [];
window.__taskStatus = "in_progress";
window.__taskRevision = 1;
window.__workspaceAppInfo = null;
window.__workspaceReentrySourceKind = "";
window.__workspaceReentrySourceId = "";
window.__workspaceReentryAttempted = false;
window.__workspaceReentryReports = [];

function serverModelContext(continuation) {
    var current = snapshot(false);
    var state = {
        background: current.background || [],
        continuation: continuation,
        ctxId: current.ctxId,
        goal: current.goal,
        instance: current.instance,
        tasks: current.tasks || []
    };
    return {
        content: [{ type: "text", text: "portable-devshell durable Workspace state:\n" + JSON.stringify(state, null, 2) }],
        structuredContent: { portableDevshellWorkspace: state }
    };
}

function serverGoalContinuation() {
    var goal = snapshot(false).goal;
    var steps = Array.isArray(goal.steps) ? goal.steps.slice() : [];
    var terminal = { id: "finish-goal", kind: "goal-terminal", status: "pending", text: "Complete the Goal." };
    var orderedItems = steps.concat([terminal]);
    var currentIndex = steps.findIndex(function (step) { return step.status === "active"; });
    if (currentIndex < 0) currentIndex = steps.findIndex(function (step) { return step.status === "pending"; });
    var attempt = Math.max(1, Number(window.__workspaceGoalContinuationCount || 0) + 1);
    return {
        attempt: attempt,
        currentItem: orderedItems[currentIndex],
        goalId: goal.goalId,
        kind: "goal",
        nextItem: orderedItems[currentIndex + 1],
        noActionStreak: Number(window.__workspaceGoalContinuationCount || 0),
        objective: goal.objective,
        orderedItems: orderedItems,
        stagnationStreak: 0
    };
}

function serverGoalMessage() {
    var attempt = Math.max(1, Number(window.__workspaceGoalContinuationCount || 0) + 1);
    var prefix = "";
    if (attempt === 2) prefix = "Wake attempt 2. The previous continuation produced no verifiable execution progress.\n\n";
    else if (attempt === 3) prefix = "Wake attempt 3. Repeated continuation attempts have not produced verifiable execution progress. Take concrete execution actions instead of only describing the state.\n\n";
    else if (attempt === 4) prefix = "Wake attempt 4. You have repeatedly failed to advance an actionable Goal. Stop substituting acknowledgements, plans, or status reports for execution.\n\n";
    else if (attempt >= 5) prefix = "Wake attempt " + attempt + ". Critical execution failure: the Goal remains actionable after repeated continuation attempts without verifiable progress. Execute concrete work now rather than another acknowledgement, plan, status report, apology, or promise.\n\n";
    return prefix + "Finish the current Goal item shown in the Workspace context.\n\nThen immediately continue with the next Goal item.\n\nDo not stop after completing or reporting the current item.";
}

function serverReentryDelivery(args) {
    var intent = args.intent || "automatic";
    var current = snapshot(false);
    if (intent === "automatic" && Array.isArray(current.background) && current.background.some(function (wait) { return wait.status === "detached" || wait.status === "waiting"; })) return null;
    if (intent === "task-resume") {
        return {
            kind: "explicit",
            sourceId: args.sourceId,
            message: "The user resumed this Workspace task. Continue the task immediately from its current durable state.",
            modelContext: serverModelContext({ kind: "explicit", reason: "task-resume", taskId: args.sourceId })
        };
    }
    if (intent === "goal-resume" || intent === "goal-retry") {
        return {
            kind: "explicit",
            sourceId: args.sourceId,
            message: intent === "goal-resume"
                ? "The user resumed the active Workspace Goal. Continue the Goal immediately from its current durable state; do not restart completed work."
                : "The user explicitly retried automatic execution for this Workspace Goal. Continue immediately from the current durable Goal state.",
            modelContext: serverModelContext({ goalId: args.sourceId, kind: "explicit", reason: intent })
        };
    }
    var retryAfterMs = Date.parse(window.__workspaceGoalRetryAfter || "");
    var retryReady = !Number.isFinite(retryAfterMs) || Date.now() >= retryAfterMs;
    if (!window.__workspaceAgentBusy && !window.__workspaceApprovalPending && retryReady && window.__workspaceGoalDueNow && !window.__workspaceGoalAttempted && !window.__workspaceGoalStopped && !window.__workspaceGoalPaused && !window.__workspaceGoalBlocked && !window.__workspaceGoalStepsDone) {
        var continuation = serverGoalContinuation();
        return {
            kind: "goal",
            sourceId: "goal-browser",
            message: serverGoalMessage(),
            messageId: "goal-message-browser",
            modelContext: serverModelContext(continuation)
        };
    }
    return null;
}

function snapshot(withQuestion) {
    var question = {
        createdAt: "2026-08-19T01:00:00.000Z",
        createdByCtxId: "ctx-browser",
        eventName: "user.answer",
        kind: "question",
        name: "workspace_ask",
        payload: {
            allowText: true,
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
        reason: "Publishing a release changes the remote repository.",
        riskLevel: "high",
        status: "waiting",
        toolName: "bash_run",
        updatedAt: "2026-08-19T01:00:01.000Z"
    };
    var currentEvent = withQuestion && !window.__workspaceQuestionAnswered
        ? question
        : window.__workspaceApprovalPending
            ? approval
            : null;
    return {
        agentBusy: window.__workspaceAgentBusy,
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
            goalId: "goal-browser",
            status: "detached",
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
            continuationAttemptedAt: window.__workspaceGoalAttempted ? new Date().toISOString() : undefined,
            continuationCount: 0,
            continuationDue: window.__workspaceGoalDueNow && !window.__workspaceGoalAttempted,
            continuationDueAt: window.__workspaceGoalDueNow ? "2000-01-01T00:00:00.000Z" : "2099-08-20T01:00:00.000Z",
            continuationMessageId: window.__workspaceGoalAttempted ? "goal-message-browser" : undefined,
            continuationPending: window.__workspaceGoalAttempted,
            continuationRetryAfter: window.__workspaceGoalRetryAfter || undefined,
            continuationUncertain: window.__workspaceGoalAttempted,
            createdAt: "2026-08-19T01:00:00.000Z",
            goalId: "goal-browser",
            lastAgentActivityAt: window.__workspaceGoalLastAgentActivityAt,
            lastProgressAt: "2026-08-19T01:00:00.000Z",
            maxContinuations: 10,
            note: window.__workspaceGoalBlocked ? "Waiting for user decision" : undefined,
            objective: "Ship Workspace Goal mode",
            progressEpoch: 0,
            revision: 1,
            status: window.__workspaceGoalStopped ? "stopped" : window.__workspaceGoalPaused ? "paused" : window.__workspaceGoalBlocked ? "blocked" : "active",
            steps: window.__workspaceGoalStepsDone
                ? [
                    { id: "implement", status: "completed", text: "Implement Goal runtime" },
                    { id: "verify", status: "completed", text: "Verify Workspace UI" }
                ]
                : [
                    { id: "implement", status: "completed", text: "Implement Goal runtime" },
                    { id: "verify", status: "active", text: "Verify Workspace UI" }
                ],
            updatedAt: "2026-08-19T01:00:00.000Z"
        },
        instance: "browser-instance",
        questions: withQuestion && !window.__workspaceQuestionAnswered ? [question] : [],
        reentry: {
            claimId: window.__workspaceReentryClaimId || undefined,
            epoch: window.__workspaceReentryEpoch,
            mode: window.__workspaceReentryMode,
            pending: !!window.__workspaceReentryClaimId,
            suppressedAt: window.__workspaceReentrySuppressedAt || undefined
        },
        tasks: [{
            checkpoint: {
                next: "Finish re-entry controls",
                summary: "Live Workspace is connected",
                updatedAt: "2026-08-19T01:00:00.000Z"
            },
            completed: 1,
            currentItem: "Implement live Workspace",
            revision: window.__taskRevision,
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
        window.__workspaceAppInfo = message.params.appInfo;
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: { ctxId: "ctx-browser" } }
        }, "*");
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
                _meta: { "portable-devshell/workspace": { token: "browser-secret-token" } },
                content: [{ type: "text", text: "portable-devshell Workspace opened." }],
                structuredContent: { ctxId: "ctx-browser", instance: "browser-instance" }
            }
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
        if (window.__holdGoalContinuationContext && JSON.stringify(message.params || {}).includes('"continuation"') && JSON.stringify(message.params || {}).includes('"kind":"goal"')) {
            window.__pendingGoalContinuationContext = { id: message.id, source: source };
            return;
        }
        reply({});
        return;
    }
    if (message.method === "ui/message") {
        window.__modelMessages.push(message.params || {});
        window.__bridgeEvents.push("message");
        if (window.__ambiguousNextModelMessage) {
            window.__ambiguousNextModelMessage = false;
            source.postMessage({ error: { code: -32002, message: "host accepted state is unknown" }, id: message.id, jsonrpc: "2.0" }, "*");
        } else if (window.__rejectNextModelMessage) {
            window.__rejectNextModelMessage = false;
            reply({ isError: true });
        } else {
            reply({});
        }
        return;
    }
    if (message.method === "notifications/cancelled") {
        window.__workspaceCancelledRequests.push(message.params || {});
        return;
    }
    if (message.method !== "tools/call") return;

    var call = message.params || {};
    window.__workspaceCalls.push(call);
    if (call.name === "workspace_snapshot" || call.name === "workspace_reconnect") {
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
    if (call.name === "workspace_answer") {
        window.__workspaceQuestionAnswered = true;
        reply({ structuredContent: { answer: "Continue", detached: false, taskId: "task-plan", waitId: "wait-question" } });
        return;
    }
    if (call.name === "workspace_approval") {
        window.__workspaceApprovalPending = false;
        reply({ structuredContent: { approvalId: call.arguments.approvalId, status: "approved" } });
        return;
    }
    if (call.name === "workspace_interrupt") {
        window.__workspaceWaitInterrupted = true;
        reply({ structuredContent: { detached: false, interrupted: true, status: "resolved", taskId: "task-plan", tmuxTaskId: "task-browser", waitId: "wait-background" } });
        return;
    }
    if (call.name === "workspace_task") {
        if (call.arguments.action === "pause") window.__taskStatus = "paused";
        if (call.arguments.action === "resume") window.__taskStatus = "in_progress";
        if (call.arguments.action === "cancel") window.__taskStatus = "cancelled";
        window.__taskRevision += 1;
        reply({ structuredContent: {
            items: [],
            revision: window.__taskRevision,
            summary: { completed: 1, total: 7 },
            taskId: "task-plan",
            title: "v0.6 feature train"
        } });
        return;
    }
    if (call.name === "workspace_pause") {
        window.__workspaceGoalPaused = true;
        window.__workspaceReentryMode = "paused";
        window.__workspaceReentrySuppressedAt = new Date().toISOString();
        reply({ structuredContent: { goal: snapshot(false).goal } });
        return;
    }
    if (call.name === "workspace_stop") {
        window.__workspaceGoalStopped = true;
        reply({ structuredContent: { goal: snapshot(false).goal } });
        return;
    }
    if (call.name === "workspace_resume") {
        window.__workspaceGoalBlocked = false;
        window.__workspaceGoalPaused = false;
        window.__workspaceReentryMode = "automatic";
        window.__workspaceReentrySuppressedAt = "";
        reply({ structuredContent: { goal: snapshot(false).goal } });
        return;
    }
    if (call.name === "workspace_goal_continue") {
        var action = call.arguments && call.arguments.action;
        if (action === "reset") {
            window.__workspaceGoalDueNow = false;
            reply({ structuredContent: { goal: snapshot(false).goal } });
            return;
        }
        if (action === "claim") {
            reply({ structuredContent: {
                claimed: call.arguments.available === true,
                claimId: call.arguments.claimId,
                continuationCount: Number(window.__workspaceGoalContinuationCount || 0) + 1,
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
        if (action === "attempt") {
            window.__workspaceGoalAttempted = true;
            reply({ structuredContent: {
                attempted: true,
                messageId: "goal-message-browser",
                goal: Object.assign({}, snapshot(false).goal, {
                    continuationAttemptedAt: new Date().toISOString(),
                    continuationDue: false,
                    continuationMessageId: "goal-message-browser",
                    continuationPending: true,
                    continuationUncertain: true
                })
            } });
            return;
        }
        if (action === "report") {
            window.__goalContinuationReports.push(call.arguments);
            window.__workspaceGoalDueNow = false;
            window.__workspaceGoalAttempted = false;
            reply({ structuredContent: { goal: Object.assign({}, snapshot(false).goal, { continuationCount: 1 }) } });
            return;
        }
    }
    if (call.name === "workspace_reentry") {
        var reentryAction = call.arguments && call.arguments.action;
        if (reentryAction === "yield") {
            window.__workspaceReentryEpoch += 1;
            window.__workspaceReentryClaimId = "";
            window.__workspaceReentrySourceKind = "";
            window.__workspaceReentrySourceId = "";
            window.__workspaceReentryAttempted = false;
            window.__workspaceReentrySuppressedAt = new Date().toISOString();
            window.__workspaceReentryMode = "user_owned";
            reply({ structuredContent: Object.assign(snapshot(false).reentry, { executionActive: false, executionEpoch: 0 }) });
            return;
        }
        if (reentryAction === "resume") {
            window.__workspaceReentryEpoch += 1;
            window.__workspaceReentryClaimId = "";
            window.__workspaceReentrySourceKind = "";
            window.__workspaceReentrySourceId = "";
            window.__workspaceReentryAttempted = false;
            window.__workspaceReentrySuppressedAt = "";
            window.__workspaceReentryMode = "automatic";
            reply({ structuredContent: Object.assign(snapshot(false).reentry, { executionActive: false, executionEpoch: 0, resumed: true }) });
            return;
        }
        if (reentryAction === "claim") {
            var delivery = serverReentryDelivery(call.arguments || {});
            var canClaim = !window.__workspaceReentrySuppressedAt && !window.__workspaceReentryClaimId && !!delivery;
            if (canClaim) {
                window.__workspaceReentryClaimId = call.arguments.claimId;
                window.__workspaceReentrySourceKind = delivery.kind === "goal" ? "goal" : call.arguments.intent;
                window.__workspaceReentrySourceId = delivery.sourceId;
            }
            reply({ structuredContent: Object.assign(snapshot(false).reentry, {
                attempted: false,
                claimId: call.arguments.claimId,
                claimed: canClaim,
                delivery: canClaim ? delivery : undefined,
                executionActive: false,
                executionEpoch: 0,
                sourceId: canClaim ? window.__workspaceReentrySourceId : undefined,
                sourceKind: canClaim ? window.__workspaceReentrySourceKind : undefined
            }) });
            return;
        }
        if (reentryAction === "validate") {
            reply({ structuredContent: Object.assign(snapshot(false).reentry, {
                attempted: window.__workspaceReentryAttempted,
                executionActive: false,
                executionEpoch: 0,
                sourceId: window.__workspaceReentrySourceId || undefined,
                sourceKind: window.__workspaceReentrySourceKind || undefined,
                valid: !window.__workspaceReentrySuppressedAt && window.__workspaceReentryClaimId === call.arguments.claimId
            }) });
            return;
        }
        if (reentryAction === "attempt") {
            var sourceStillValid = !(window.__workspaceReentrySourceKind === "goal" && (window.__workspaceGoalStopped || window.__workspaceGoalPaused || window.__workspaceGoalBlocked));
            window.__workspaceReentryAttempted = window.__workspaceReentryClaimId === call.arguments.claimId && sourceStillValid;
            if (window.__workspaceReentrySourceKind === "goal" && window.__workspaceReentryAttempted) window.__workspaceGoalAttempted = true;
            reply({ structuredContent: Object.assign(snapshot(false).reentry, {
                attempted: window.__workspaceReentryAttempted,
                executionActive: false,
                executionEpoch: 0,
                sourceId: window.__workspaceReentrySourceId || undefined,
                sourceKind: window.__workspaceReentrySourceKind || undefined
            }) });
            return;
        }
        if (reentryAction === "report") {
            window.__workspaceReentryReports.push(call.arguments);
            if (window.__workspaceReentrySourceKind === "goal") {
                window.__goalContinuationReports.push(call.arguments);
                if (call.arguments.outcome === "accepted") {
                    window.__workspaceGoalDueNow = false;
                    window.__workspaceGoalContinuationCount += 1;
                    window.__workspaceGoalAttempted = false;
                } else if (call.arguments.outcome === "rejected") {
                    window.__workspaceGoalAttempted = false;
                }
            }
            window.__workspaceReentryClaimId = "";
            window.__workspaceReentrySourceKind = "";
            window.__workspaceReentrySourceId = "";
            window.__workspaceReentryAttempted = false;
            reply({ structuredContent: Object.assign(snapshot(false).reentry, {
                attempted: false,
                executionActive: call.arguments.outcome !== "rejected",
                executionEpoch: 1,
                outcome: call.arguments.outcome,
                reported: true
            }) });
            return;
        }
        if (reentryAction === "release") {
            if (window.__workspaceReentryClaimId === call.arguments.claimId && !window.__workspaceReentryAttempted) {
                window.__workspaceReentryClaimId = "";
                window.__workspaceReentrySourceKind = "";
                window.__workspaceReentrySourceId = "";
            }
            reply({ structuredContent: Object.assign(snapshot(false).reentry, { attempted: false, executionActive: false, executionEpoch: 0, released: true }) });
            return;
        }
        reply({ structuredContent: Object.assign(snapshot(false).reentry, { attempted: window.__workspaceReentryAttempted, executionActive: false, executionEpoch: 0 }) });
        return;
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

window.__emitWorkspaceSnapshotAfterCancellation = function () {
    var pending = window.__workspacePendingWatch;
    if (!pending || pending.id === undefined || !pending.source) return false;
    window.__workspacePendingWatch = null;
    window.__workspaceAgentBusy = false;
    window.__workspaceGoalDueNow = true;
    window.__workspaceCursor += 1;
    pending.source.postMessage({
        id: pending.id,
        jsonrpc: "2.0",
        result: {
            _meta: { "portable-devshell/workspace": { token: "browser-secret-token" } },
            structuredContent: { changed: true, cursor: window.__workspaceCursor, snapshot: snapshot(false) }
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
        ctxId: "ctx-session-mode",
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
    if (call.name === "workspace_snapshot" || call.name === "workspace_reconnect") {
        reply({
            _meta: { "portable-devshell/workspace": { token: "session-mode-token" } },
            structuredContent: sessionModeSnapshot()
        });
        return;
    }
    if (call.name === "workspace_watch") return;
    if (call.name === "workspace_answer") {
        window.__sessionModeAnswered = true;
        reply({ structuredContent: { answer: "Continue", detached: false, taskId: "task-session", waitId: "wait-session-question" } });
        return;
    }
});
`;

const DELAYED_CONTEXT_BRIDGE_SCRIPT = String.raw`
window.__delayedContextCalls = [];
window.__delayedContextSource = null;

function delayedContextSnapshot() {
    var question = {
        eventName: "user.answer",
        kind: "question",
        name: "workspace_ask",
        payload: { allowText: false, choices: ["Continue"], question: "Delayed context ready" },
        status: "waiting",
        updatedAt: "2026-08-29T00:00:00.000Z",
        waitId: "wait-delayed"
    };
    return {
        approvals: [],
        background: [],
        ctxId: "ctx-delayed",
        currentEvent: question,
        cursor: 1,
        goal: null,
        instance: "browser-instance",
        questions: [question],
        tasks: []
    };
}

window.__deliverDelayedWorkspaceContext = function () {
    if (!window.__delayedContextSource) return false;
    window.__delayedContextSource.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
            _meta: { "portable-devshell/workspace": { token: "delayed-context-token" } },
            content: [{ type: "text", text: "portable-devshell Workspace opened." }],
            structuredContent: { ctxId: "ctx-delayed", instance: "browser-instance" }
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
    if (message.method === "ui/initialize") {
        window.__delayedContextSource = source;
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
    window.__delayedContextCalls.push(call);
    if (call.name === "workspace_reconnect" || call.name === "workspace_snapshot") {
        reply({
            _meta: { "portable-devshell/workspace": { token: "delayed-context-token" } },
            structuredContent: delayedContextSnapshot()
        });
        return;
    }
    if (call.name === "workspace_watch") return;
});
`;

const RECOVERY_BRIDGE_SCRIPT = String.raw`
window.__workspaceCalls = [];
window.__modelMessages = [];
window.__recoveryModelContextUpdates = [];
window.__bridgeEvents = [];
window.__recovered = false;
window.__recoveryAttempted = false;
window.__goalRecovery = false;
window.__unassociatedRecovery = false;
window.__recoveryTimedOut = false;
window.__recoveryReentryClaimId = "";
window.__recoveryReentryMode = "automatic";
window.__recoverySuppressedAt = "";
window.__recoverySourceId = "";
window.__recoveryReentryReports = [];

function recoveryDelivery() {
    if (window.__recovered || window.__recoveryAttempted || window.__recoveryReentryMode !== "automatic" || window.__recoverySuppressedAt) return null;
    var result = window.__recoveryTimedOut
        ? { task: { id: "tmux-recovery", status: "running" }, timedOut: true }
        : { task: { id: "tmux-recovery", status: "0" } };
    var reason = window.__recoveryTimedOut ? "tmux-wait-deadline-elapsed" : "tmux-finished";
    var continuation = {
        kind: "wait",
        reason: reason,
        result: result,
        suspendedOperation: { kind: "tmux-wait", taskId: "tmux-recovery" },
        nextOperation: { kind: "tool", taskId: "tmux-recovery", tool: "tmux_read" },
        constraints: { restartTask: false },
        wait: { kind: "tmux", targetId: "tmux-recovery", waitId: "wait-recovery" }
    };
    if (window.__recoveryTimedOut) {
        continuation.afterResult = {
            operation: { kind: "blocking-wait", taskId: "tmux-recovery", tool: "tmux_read" },
            when: "task-still-running-and-result-required"
        };
    }
    var snap = recoverySnapshot();
    var state = {
        background: snap.background,
        continuation: continuation,
        ctxId: snap.ctxId,
        goal: snap.goal,
        instance: snap.instance,
        tasks: snap.tasks
    };
    return {
        kind: "wait",
        sourceId: "wait-recovery",
        message: "Resume the existing execution from the Workspace continuation context.\n\nPerform the continuation operation, then continue the suspended work from its result.",
        messageId: "recovery-message-id",
        modelContext: {
            content: [{ type: "text", text: "portable-devshell durable Workspace state:\n" + JSON.stringify(state, null, 2) }],
            structuredContent: { portableDevshellWorkspace: state }
        }
    };
}

function recoverySnapshot() {
    var goalMode = window.__goalRecovery;
    var unassociated = window.__unassociatedRecovery;
    return {
        activity: [],
        approvals: [],
        background: window.__recovered ? [] : [{
            detachedAt: "2026-08-19T01:00:01.000Z",
            goalId: goalMode ? "goal-recovery" : undefined,
            recoveryMessageAttemptedAt: window.__recoveryAttempted ? "2026-08-19T01:00:02.500Z" : undefined,
            recoveryMessageId: window.__recoveryAttempted ? "recovery-message-id" : undefined,
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
        reentry: {
            claimId: window.__recoveryReentryClaimId || undefined,
            epoch: 0,
            mode: window.__recoveryReentryMode,
            pending: !!window.__recoveryReentryClaimId,
            suppressedAt: window.__recoverySuppressedAt || undefined
        },
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
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
                _meta: { "portable-devshell/workspace": { token: "recovery-secret-token" } },
                content: [{ type: "text", text: "portable-devshell Workspace opened." }],
                structuredContent: { ctxId: "ctx-recovery", instance: "browser-instance" }
            }
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
        window.__recoveryModelContextUpdates.push(message.params || {});
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
    if (call.name === "workspace_snapshot" || call.name === "workspace_reconnect") {
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
    if (call.name === "workspace_reentry") {
        var reentryAction = call.arguments.action;
        if (reentryAction === "claim") {
            var delivery = recoveryDelivery();
            var claimed = !!delivery && !window.__recoveryReentryClaimId;
            if (claimed) {
                window.__recoveryReentryClaimId = call.arguments.claimId;
                window.__recoverySourceId = delivery.sourceId;
            }
            reply({ structuredContent: {
                attempted: false,
                claimId: call.arguments.claimId,
                claimed: claimed,
                delivery: claimed ? delivery : undefined,
                epoch: 0,
                executionActive: false,
                executionEpoch: 0,
                mode: window.__recoveryReentryMode,
                pending: !!window.__recoveryReentryClaimId,
                sourceId: claimed ? window.__recoverySourceId : undefined,
                sourceKind: claimed ? "wait" : undefined
            } });
            return;
        }
        if (reentryAction === "validate") {
            reply({ structuredContent: {
                attempted: window.__recoveryAttempted,
                claimId: window.__recoveryReentryClaimId || undefined,
                epoch: 0,
                executionActive: false,
                executionEpoch: 0,
                pending: !!window.__recoveryReentryClaimId,
                sourceId: window.__recoverySourceId || undefined,
                sourceKind: window.__recoverySourceId ? "wait" : undefined,
                valid: window.__recoveryReentryClaimId === call.arguments.claimId && !window.__recovered
            } });
            return;
        }
        if (reentryAction === "attempt") {
            window.__recoveryAttempted = window.__recoveryReentryClaimId === call.arguments.claimId;
            reply({ structuredContent: {
                attempted: window.__recoveryAttempted,
                claimId: window.__recoveryReentryClaimId || undefined,
                epoch: 0,
                executionActive: false,
                executionEpoch: 0,
                pending: !!window.__recoveryReentryClaimId,
                sourceId: window.__recoverySourceId || undefined,
                sourceKind: window.__recoverySourceId ? "wait" : undefined
            } });
            return;
        }
        if (reentryAction === "report") {
            window.__recoveryReentryReports.push(call.arguments);
            window.__recovered = true;
            window.__recoveryReentryClaimId = "";
            window.__recoverySourceId = "";
            reply({ structuredContent: {
                attempted: false,
                epoch: 0,
                executionActive: call.arguments.outcome !== "rejected",
                executionEpoch: 1,
                outcome: call.arguments.outcome,
                pending: false,
                reported: true
            } });
            return;
        }
        if (reentryAction === "release") {
            if (!window.__recoveryAttempted && window.__recoveryReentryClaimId === call.arguments.claimId) {
                window.__recoveryReentryClaimId = "";
                window.__recoverySourceId = "";
            }
            reply({ structuredContent: { attempted: false, epoch: 0, executionActive: false, executionEpoch: 0, pending: false, released: true } });
            return;
        }
        if (reentryAction === "resume") {
            window.__recoveryReentryClaimId = "";
            window.__recoverySourceId = "";
            window.__recoveryReentryMode = "automatic";
            window.__recoverySuppressedAt = "";
            reply({ structuredContent: { attempted: false, epoch: 1, executionActive: false, executionEpoch: 0, mode: "automatic", pending: false, resumed: true } });
            return;
        }
        reply({ structuredContent: { attempted: window.__recoveryAttempted, epoch: 0, executionActive: false, executionEpoch: 0, pending: !!window.__recoveryReentryClaimId } });
        return;
    }
});
`;

const RESUME_BRIDGE_SCRIPT = String.raw`
window.__workspaceCalls = [];
window.__modelMessages = [];
window.__taskStatus = "in_progress";
window.__taskRevision = 1;
window.__waitWindowInterrupted = false;
window.__waitWindowRecovered = false;
window.__waitRecoveryDisabled = false;
window.__resumeReentryClaimId = "";
window.__resumeGoalMode = false;
window.__resumeGoalBlocked = false;
window.__resumeSourceKind = "";
window.__resumeSourceId = "";
window.__resumeAttempted = false;
window.__resumeReports = [];

function resumeModelContext(continuation) {
    var snap = resumeSnapshot();
    var state = { background: snap.background, continuation: continuation, ctxId: snap.ctxId, goal: snap.goal, instance: snap.instance, tasks: snap.tasks };
    return {
        content: [{ type: "text", text: "portable-devshell durable Workspace state:\n" + JSON.stringify(state, null, 2) }],
        structuredContent: { portableDevshellWorkspace: state }
    };
}

function resumeDelivery(args) {
    var associatedSourceReady = window.__resumeGoalMode ? !window.__resumeGoalBlocked : window.__taskStatus === "in_progress";
    var resolvedWait = window.__waitWindowInterrupted && !window.__waitWindowRecovered && !window.__waitRecoveryDisabled && associatedSourceReady;
    if (resolvedWait) {
        var result = { interrupted: true, task: { id: "tmux-resume", status: "running" } };
        var continuation = {
            kind: "wait",
            reason: "tmux-wait-interrupted",
            result: result,
            suspendedOperation: { kind: "tmux-wait", taskId: "tmux-resume" },
            nextOperation: { kind: "tool", taskId: "tmux-resume", tool: "tmux_read" },
            constraints: { restartTask: false },
            wait: { kind: "tmux", targetId: "tmux-resume", waitId: "wait-resume" }
        };
        return {
            kind: "wait",
            sourceId: "wait-resume",
            message: "Resume the existing execution from the Workspace continuation context.\n\nPerform the continuation operation, then continue the suspended work from its result.",
            modelContext: resumeModelContext(continuation)
        };
    }
    if (args.intent === "task-resume") {
        return {
            kind: "explicit",
            sourceId: args.sourceId,
            message: "The user resumed this Workspace task. Continue the task immediately from its current durable state.",
            modelContext: resumeModelContext({ kind: "explicit", reason: "task-resume", taskId: args.sourceId })
        };
    }
    if (args.intent === "goal-resume") {
        return {
            kind: "explicit",
            sourceId: args.sourceId,
            message: "The user resumed the active Workspace Goal. Continue the Goal immediately from its current durable state; do not restart completed work.",
            modelContext: resumeModelContext({ goalId: args.sourceId, kind: "explicit", reason: "goal-resume" })
        };
    }
    return null;
}

function resumeSnapshot() {
    return {
        activity: [], approvals: [], questions: [], waits: [],
        background: window.__waitWindowRecovered ? [] : [{
            detachedAt: new Date().toISOString(),
            goalId: window.__resumeGoalMode ? "goal-resume" : undefined,
            recoveryDisabledAt: window.__waitRecoveryDisabled ? new Date().toISOString() : undefined,
            status: window.__waitWindowInterrupted ? "resolved" : "detached",
            taskId: window.__resumeGoalMode ? undefined : "task-resume",
            tmuxTaskId: "tmux-resume",
            updatedAt: "2026-08-19T01:00:02.000Z",
            waitId: "wait-resume"
        }],
        ctxId: "ctx-resume",
        cursor: 1,
        goal: window.__resumeGoalMode ? {
            autoContinueExhausted: false,
            continuationCount: 0,
            continuationDue: false,
            continuationDueAt: "2099-08-20T01:00:00.000Z",
            continuationPending: false,
            createdAt: "2026-08-19T01:00:00.000Z",
            goalId: "goal-resume",
            lastAgentActivityAt: "2026-08-19T01:00:00.000Z",
            lastProgressAt: "2026-08-19T01:00:00.000Z",
            maxContinuations: 10,
            note: window.__resumeGoalBlocked ? "Waiting for background result" : undefined,
            objective: "Resume one Goal",
            revision: window.__resumeGoalBlocked ? 1 : 2,
            status: window.__resumeGoalBlocked ? "blocked" : "active",
            steps: [{ id: "continue", status: "active", text: "Continue work" }],
            updatedAt: "2026-08-19T01:00:00.000Z"
        } : null,
        instance: "browser-instance",
        reentry: { claimId: window.__resumeReentryClaimId || undefined, epoch: 0, pending: !!window.__resumeReentryClaimId },
        tasks: window.__resumeGoalMode ? [] : [{
            checkpoint: {
                summary: "Resume from this checkpoint",
                updatedAt: "2026-08-19T01:00:00.000Z"
            },
            completed: 1,
            currentItem: "Continue work",
            revision: window.__taskRevision,
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
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
                _meta: { "portable-devshell/workspace": { token: "resume-secret-token" } },
                content: [{ type: "text", text: "portable-devshell Workspace opened." }],
                structuredContent: { ctxId: "ctx-resume", instance: "browser-instance" }
            }
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
    if (call.name === "workspace_snapshot" || call.name === "workspace_reconnect") {
        reply({
            _meta: { "portable-devshell/workspace": { token: "resume-secret-token" } },
            structuredContent: resumeSnapshot()
        });
        return;
    }
    if (call.name === "workspace_watch") return;
    if (call.name === "workspace_reentry") {
        var action = call.arguments.action;
        if (action === "claim") {
            var delivery = resumeDelivery(call.arguments || {});
            var claimed = !!delivery && !window.__resumeReentryClaimId;
            if (claimed) {
                window.__resumeReentryClaimId = call.arguments.claimId;
                window.__resumeSourceKind = delivery.kind === "wait" ? "wait" : call.arguments.intent;
                window.__resumeSourceId = delivery.sourceId;
            }
            reply({ structuredContent: { attempted: false, claimId: call.arguments.claimId, claimed: claimed, delivery: claimed ? delivery : undefined, epoch: 0, executionActive: false, executionEpoch: 0, pending: !!window.__resumeReentryClaimId, sourceId: claimed ? window.__resumeSourceId : undefined, sourceKind: claimed ? window.__resumeSourceKind : undefined } });
            return;
        }
        if (action === "validate") {
            reply({ structuredContent: { attempted: window.__resumeAttempted, claimId: window.__resumeReentryClaimId || undefined, epoch: 0, executionActive: false, executionEpoch: 0, pending: !!window.__resumeReentryClaimId, sourceId: window.__resumeSourceId || undefined, sourceKind: window.__resumeSourceKind || undefined, valid: window.__resumeReentryClaimId === call.arguments.claimId } });
            return;
        }
        if (action === "attempt") {
            window.__resumeAttempted = window.__resumeReentryClaimId === call.arguments.claimId;
            reply({ structuredContent: { attempted: window.__resumeAttempted, claimId: window.__resumeReentryClaimId || undefined, epoch: 0, executionActive: false, executionEpoch: 0, pending: !!window.__resumeReentryClaimId, sourceId: window.__resumeSourceId || undefined, sourceKind: window.__resumeSourceKind || undefined } });
            return;
        }
        if (action === "report") {
            window.__resumeReports.push(call.arguments);
            if (window.__resumeSourceKind === "wait") window.__waitWindowRecovered = true;
            window.__resumeReentryClaimId = "";
            window.__resumeSourceKind = "";
            window.__resumeSourceId = "";
            window.__resumeAttempted = false;
            reply({ structuredContent: { attempted: false, epoch: 0, executionActive: call.arguments.outcome !== "rejected", executionEpoch: 1, outcome: call.arguments.outcome, pending: false, reported: true } });
            return;
        }
        if (action === "release") {
            if (!window.__resumeAttempted && window.__resumeReentryClaimId === call.arguments.claimId) {
                window.__resumeReentryClaimId = "";
                window.__resumeSourceKind = "";
                window.__resumeSourceId = "";
            }
            reply({ structuredContent: { attempted: false, epoch: 0, executionActive: false, executionEpoch: 0, pending: false, released: true } });
            return;
        }
        reply({ structuredContent: { attempted: window.__resumeAttempted, epoch: 0, executionActive: false, executionEpoch: 0, pending: !!window.__resumeReentryClaimId } });
        return;
    }
    if (call.name === "workspace_interrupt") {
        window.__waitWindowInterrupted = true;
        reply({ structuredContent: {
            detached: true,
            interrupted: true,
            status: "resolved",
            taskId: window.__resumeGoalMode ? undefined : "task-resume",
            tmuxTaskId: "tmux-resume",
            waitId: "wait-resume"
        } });
        return;
    }
    if (call.name === "workspace_task") {
        if (call.arguments.action === "resume") window.__taskStatus = "in_progress";
        window.__taskRevision += 1;
        reply({ structuredContent: {
            items: [],
            revision: window.__taskRevision,
            summary: { completed: 1, total: 2 },
            taskId: "task-resume",
            title: "Resume task"
        } });
        return;
    }
    if (call.name === "workspace_resume") {
        window.__resumeGoalBlocked = false;
        reply({ structuredContent: { goal: resumeSnapshot().goal } });
        return;
    }
});
`;
const DETACHED_INTERACTION_BRIDGE_SCRIPT = String.raw`
window.__modelMessages = [];
window.__detachedModelContextUpdates = [];
window.__questionAnswered = false;
window.__detachedReentryClaimId = "";
window.__detachedRecovered = false;
window.__detachedAttempted = false;
window.__detachedReports = [];

function detachedDelivery() {
    if (!window.__questionAnswered || window.__detachedRecovered) return null;
    var continuation = {
        kind: "wait",
        reason: "question-answered",
        result: { answer: "Continue" },
        suspendedOperation: { kind: "workspace-question", waitId: "wait-question-detached" },
        nextOperation: { kind: "resume-with-answer" },
        wait: { kind: "question", targetId: "question-detached", taskId: "task-detached", waitId: "wait-question-detached" }
    };
    var snap = detachedInteractionSnapshot();
    var state = { background: snap.background, continuation: continuation, ctxId: snap.ctxId, instance: snap.instance, tasks: snap.tasks };
    return {
        kind: "wait",
        sourceId: "wait-question-detached",
        message: "Resume the existing execution from the Workspace continuation context.\n\nPerform the continuation operation, then continue the suspended work from its result.",
        modelContext: {
            content: [{ type: "text", text: "portable-devshell durable Workspace state:\n" + JSON.stringify(state, null, 2) }],
            structuredContent: { portableDevshellWorkspace: state }
        }
    };
}

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
        reentry: { claimId: window.__detachedReentryClaimId || undefined, epoch: 0, pending: !!window.__detachedReentryClaimId },
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
        source.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
                _meta: { "portable-devshell/workspace": { token: "detached-secret-token" } },
                content: [{ type: "text", text: "portable-devshell Workspace opened." }],
                structuredContent: { ctxId: "ctx-detached", instance: "browser-instance" }
            }
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
        window.__detachedModelContextUpdates.push(message.params || {});
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
    if (call.name === "workspace_snapshot" || call.name === "workspace_reconnect") {
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
    if (call.name === "workspace_reentry") {
        var action = call.arguments.action;
        if (action === "claim") {
            var delivery = detachedDelivery();
            var claimed = !!delivery && !window.__detachedReentryClaimId;
            if (claimed) window.__detachedReentryClaimId = call.arguments.claimId;
            reply({ structuredContent: { attempted: false, claimId: call.arguments.claimId, claimed: claimed, delivery: claimed ? delivery : undefined, epoch: 0, executionActive: false, executionEpoch: 0, pending: !!window.__detachedReentryClaimId, sourceId: claimed ? "wait-question-detached" : undefined, sourceKind: claimed ? "wait" : undefined } });
            return;
        }
        if (action === "validate") {
            reply({ structuredContent: { attempted: window.__detachedAttempted, claimId: window.__detachedReentryClaimId || undefined, epoch: 0, executionActive: false, executionEpoch: 0, pending: !!window.__detachedReentryClaimId, sourceId: window.__detachedReentryClaimId ? "wait-question-detached" : undefined, sourceKind: window.__detachedReentryClaimId ? "wait" : undefined, valid: window.__detachedReentryClaimId === call.arguments.claimId && !window.__detachedRecovered } });
            return;
        }
        if (action === "attempt") {
            window.__detachedAttempted = window.__detachedReentryClaimId === call.arguments.claimId;
            reply({ structuredContent: { attempted: window.__detachedAttempted, claimId: window.__detachedReentryClaimId || undefined, epoch: 0, executionActive: false, executionEpoch: 0, pending: !!window.__detachedReentryClaimId, sourceId: "wait-question-detached", sourceKind: "wait" } });
            return;
        }
        if (action === "report") {
            window.__detachedReports.push(call.arguments);
            window.__detachedRecovered = true;
            window.__detachedAttempted = false;
            window.__detachedReentryClaimId = "";
            reply({ structuredContent: { attempted: false, epoch: 0, executionActive: call.arguments.outcome !== "rejected", executionEpoch: 1, outcome: call.arguments.outcome, pending: false, reported: true } });
            return;
        }
        if (action === "release") {
            if (!window.__detachedAttempted && window.__detachedReentryClaimId === call.arguments.claimId) window.__detachedReentryClaimId = "";
            reply({ structuredContent: { attempted: false, epoch: 0, executionActive: false, executionEpoch: 0, pending: false, released: true } });
            return;
        }
        reply({ structuredContent: { attempted: window.__detachedAttempted, epoch: 0, executionActive: false, executionEpoch: 0, pending: !!window.__detachedReentryClaimId } });
        return;
    }
    if (call.name === "workspace_answer") {
        window.__questionAnswered = true;
        reply({ structuredContent: {
            answer: call.arguments.answer,
            detached: true,
            taskId: "task-detached",
            waitId: "wait-question-detached"
        } });
        return;
    }
});
`;
