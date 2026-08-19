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
    await app.getByText("bash_run", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("task-browser", { exact: true }).waitFor({ state: "visible" });
    await app.getByText("Continue the task?", { exact: true }).waitFor({ state: "visible" });

    await app.getByRole("button", { name: "Continue" }).click();
    await page.waitForFunction("(window.__workspaceCalls || []).some(call => call.name === 'workspace_question_answer')");

    const calls = await page.evaluate("window.__workspaceCalls || []") as Array<{
        arguments?: Record<string, unknown>;
        name?: string;
    }>;
    const snapshotCall = calls.find((call) => call.name === "workspace_snapshot");
    const watchCall = calls.find((call) => call.name === "workspace_watch");
    const answerCall = calls.find((call) => call.name === "workspace_question_answer");

    assert.equal(snapshotCall?.arguments?.token, undefined);
    assert.equal(watchCall?.arguments?.token, undefined);
    assert.equal(answerCall?.arguments?.token, "browser-secret-token");
    assert.equal(answerCall?.arguments?.ctxId, "ctx-browser");
    assert.equal(answerCall?.arguments?.waitId, "wait-question");
    assert.deepEqual(browserFailures, []);
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
window.__workspaceWatchCount = 0;

function snapshot(withQuestion) {
    return {
        activity: [{
            callId: "call-1",
            inputSummary: "bash_run command",
            startedAt: "2026-08-19T01:00:00.000Z",
            status: "running",
            toolName: "bash_run"
        }],
        approvals: [],
        background: [{
            detachedAt: "2026-08-19T01:00:01.000Z",
            status: "detached",
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
            completed: 1,
            currentItem: "Implement live Workspace",
            status: "in_progress",
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
    if (message.method !== "tools/call") return;

    var call = message.params || {};
    window.__workspaceCalls.push(call);
    if (call.name === "workspace_snapshot") {
        reply({
            _meta: { "portable-devshell/workspace": { token: "browser-secret-token" } },
            structuredContent: window.__workspaceQuestionAnswered ? snapshot(false) : Object.assign(snapshot(false), {
                activity: [],
                background: [],
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
        }
        return;
    }
    if (call.name === "workspace_question_answer") {
        window.__workspaceQuestionAnswered = true;
        reply({ structuredContent: { answer: "Continue", waitId: "wait-question" } });
    }
});
`;
