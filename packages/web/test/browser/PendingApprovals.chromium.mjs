import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { build, preview } from "vite";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
    Endpoint, LocalChannel, createApprovalTransport, createConfigTransport,
    createServerTransport, createToolTransport,
} from "@portable-devshell/shared";
import { resolveControlSocketPath } from "@portable-devshell/shared/testing";
import { createAcceptanceFixture, runCli } from "../../../../acceptance/AcceptanceSupport.mjs";
import { resolveChromiumExecutable } from "../../../../scripts/testspace/TestspaceWebSmoke.mjs";

const require = createRequire(new URL("../../../control/package.json", import.meta.url));
const { chromium } = require("playwright");

async function until(read, predicate, label) {
    const deadline = Date.now() + 20_000;
    let value;
    do {
        value = await read();
        if (predicate(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error(`${label}: ${JSON.stringify(value)}`);
}

// Run separately from Vitest using the repository's source package loader.
// The CLI, Worker, MCP, approval service and Web RPC are real, isolated under
// a temporary HOME. Only static assets are served from this source build.
test("Chromium can approve and deny pre-execution MCP requests with no matching ToolCall history", { timeout: 120_000 }, async (t) => {
    const fixture = await createAcceptanceFixture();
    const instance = "web-approval-local";
    let browser, mcp, endpoint, page, web;
    t.after(async () => {
        await browser?.close();
        await web?.close();
        await mcp?.close(); endpoint?.close();
        runCli(["instance", "stop", instance], fixture.env, { allowFailure: true });
        await fixture.cleanup();
    });
    const directory = join(fixture.home, ".devshell", "control", "instances");
    const original = join(directory, "aromatic-pc.toml"), target = join(directory, `${instance}.toml`);
    await rename(original, target);
    await writeFile(target, (await readFile(target, "utf8")).replaceAll("aromatic-pc", instance));
    delete fixture.env.PORTABLE_DEVSHELL_CONTROL_URL;
    delete fixture.env.PORTABLE_DEVSHELL_CONTROL_TOKEN;
    fixture.env.XDG_CONFIG_HOME = join(fixture.home, ".config");
    fixture.env.XDG_CACHE_HOME = join(fixture.home, ".cache");
    fixture.env.XDG_DATA_HOME = join(fixture.home, ".local", "share");
    fixture.env.TMPDIR = fixture.runtime;
    delete fixture.env.DEVSHELL_WORKER_INTERNAL_INSTANCE;
    delete fixture.env.DEVSHELL_WORKER_INTERNAL_SECURITY_MODE;
    delete fixture.env.DEVSHELL_WORKER_INTERNAL_WORKSPACE;
    const assets = join(fixture.root, "web-assets");
    await build({ root: new URL("../../", import.meta.url).pathname, base: "/web/",
        build: { emptyOutDir: true, outDir: assets }, logLevel: "silent" });
    runCli(["start"], fixture.env);
    runCli(["instance", "start", instance], fixture.env);
    endpoint = new Endpoint({ connectChannel: (signal) => LocalChannel.connect(
        resolveControlSocketPath(fixture.runtime, process.platform, fixture.env), { signal },
    ) });
    await createServerTransport(endpoint, { clientKind: "cli" }).hello();
    const approvals = createApprovalTransport(endpoint, instance), tools = createToolTransport(endpoint, instance);
    mcp = new Client({ name: "web-approval-browser", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${fixture.port}/${instance}/mcp`)));
    const context = await mcp.callTool({ name: "environ_info", arguments: { workspace: fixture.workspace } });
    assert.notEqual(context.isError, true);
    const ctxId = context.structuredContent.ctxId;
    assert.equal(typeof ctxId, "string");
    await createConfigTransport(endpoint).update({ instance: { instanceName: instance, patch: {
        approvalPolicy: { mode: "allow", rules: [{ decision: "ask", match: "exact", source: "mcp", toolName: "bash_run" }] },
    } } });
    const command = resolveChromiumExecutable(); assert.equal(typeof command, "string");
    const executable = execFileSync(process.platform === "win32" ? "where" : "which", [command], { encoding: "utf8" }).trim().split(/\r?\n/u)[0];
    browser = await chromium.launch({ executablePath: executable, headless: true });
    page = await browser.newPage();
    const pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error.message));
    const backend = `http://127.0.0.1:${fixture.webPort}`;
    web = await preview({ root: new URL("../../", import.meta.url).pathname, base: "/web/",
        build: { outDir: assets }, logLevel: "silent", preview: {
            host: "127.0.0.1", port: 0,
            proxy: {
                "/web/session": { target: backend, changeOrigin: true, headers: { origin: backend } },
                "/web/rpc": { target: backend, changeOrigin: true, ws: true, rewriteWsOrigin: true },
            },
        } });
    const address = web.httpServer.address();
    assert.equal(typeof address, "object");
    const webOrigin = `http://127.0.0.1:${address.port}`;
    const effectFile = join(fixture.workspace, "approval-browser-effect.txt");
    await writeFile(effectFile, "initial\n");
    const invoke = () => mcp.callTool({ name: "bash_run", arguments: {
        ctxId, command: "printf 'executed\\n' >> approval-browser-effect.txt", timeoutMs: 10_000,
    } }).then((value) => ({ value }), (error) => ({ error }));
    const pendingApproval = async () => (await until(() => approvals.snapshot({ pendingOnly: true }),
        (value) => value.approvals.some((item) => item.ctxId === ctxId && item.toolName === "bash_run"), "MCP pending approval"))
        .approvals.find((item) => item.ctxId === ctxId && item.toolName === "bash_run");
    const operation = invoke();
    const approval = await pendingApproval();
    assert.equal((await tools.listCalls({ callIds: [approval.callId] })).length, 0);
    assert.equal(await readFile(effectFile, "utf8"), "initial\n");
    await page.goto(`${webOrigin}/web/#/audit`);
    const approve = page.locator(".approval-record").getByRole("button", { name: "Approve", exact: true });
    await approve.waitFor({ state: "visible" }); assert.equal(await approve.isEnabled(), true);
    assert.equal(await page.locator(".tool-call-record").filter({ hasText: approval.callId }).count(), 0);
    // This is the exact existence/disabled condition used by L03's click helper.
    assert.equal(await page.evaluate(() => [...globalThis.document.querySelectorAll("button")].some((button) =>
        button.textContent?.trim() === "Approve" && !button.disabled && !button.closest('[role="dialog"]'))), true);
    await approve.click();
    await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
    const settled = await operation;
    assert.equal(settled.error, undefined); assert.notEqual(settled.value.isError, true);
    assert.equal(settled.value.structuredContent.exitCode, 0);
    assert.equal(await readFile(effectFile, "utf8"), "initial\nexecuted\n");
    const approved = await approvals.get(approval.approvalId);
    assert.equal(approved.status, "approved"); assert.equal(approved.decision.decidedBy, "web");
    await until(() => tools.listCalls({ callIds: [approval.callId] }),
        (rows) => rows.length === 1 && rows[0].status === "completed", "completed real ToolCall");
    await page.goto(`${webOrigin}/web/#/audit/context/${instance}/${encodeURIComponent(ctxId)}/call/${encodeURIComponent(approval.callId)}`);
    await page.reload();
    await page.locator(".tool-call-record .result").getByText("completed", { exact: true }).waitFor();
    await page.goto(`${webOrigin}/web/#/audit`);
    await page.getByRole("heading", { name: "Audit", exact: true }).waitFor();
    await page.locator(".tool-call-record").first().waitFor();
    const deniedOperation = invoke(), denial = await pendingApproval();
    assert.equal((await tools.listCalls({ callIds: [denial.callId] })).length, 0);
    await page.locator(".approval-record").getByRole("button", { name: "Deny", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Deny", exact: true }).click();
    const deniedResult = await deniedOperation;
    assert.equal(deniedResult.error?.data?.code, "core.toolCallRejected");
    const denied = await approvals.get(denial.approvalId);
    assert.equal(denied.status, "denied"); assert.equal(denied.decision.decidedBy, "web");
    assert.equal(await readFile(effectFile, "utf8"), "initial\nexecuted\n");
    assert.deepEqual(pageErrors, []);
    t.diagnostic(JSON.stringify({ instance, zeroHistoryBeforeReview: true, approve: approved.status,
        deny: denied.status, decidedBy: approved.decision.decidedBy, hardReloadCompletedAudit: true, sideEffects: "exactly one execution" }));
});
