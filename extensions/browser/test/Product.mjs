import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { assertTestspaceLifecycleEnvironment } from "../../../scripts/testspace/TestspaceNamespace.mjs";
import { withTestspaceControlConnection } from "../../../scripts/testspace/TestspaceReverse.mjs";

const root = process.env.DEVSHELL_TESTSPACE_ROOT;
assertTestspaceLifecycleEnvironment(root, process.env);
const runtime = resolve(process.argv[2] ?? "");
const instance = process.argv[3] ?? "testspace-local";
assert.ok(["testspace-local", "testspace-reverse"].includes(instance));
const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
const workspace = join(root, instance === "testspace-local" ? "workspace" : "reverse-workspace");
await withTestspaceControlConnection(state.runtimeDirectory, async (shared, endpoint) => {
    await shared.createInstanceTransport(endpoint).updateInstance({
        instanceName: instance,
        patch: { extensions: { model: ["artifact", "comment", "instance", "mcp", "recall", "secret", "skill", "browser"] } },
    });
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const client = new Client({ name: "browser-product", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
let connected = false;
let ctxId;
for (let attempt = 0; attempt < 20; attempt++) {
    try {
        if (!connected) {
            await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + state.mcpPort + "/" + instance + "/mcp/explicit")));
            connected = true;
        }
        const environment = await client.callTool({ name: "environ_info", arguments: { workspace } });
        ctxId = environment.structuredContent?.ctxId;
        if (!environment.isError && typeof ctxId === "string") break;
    } catch (error) {
        if (attempt === 19) throw error;
    }
    await sleep(500);
}
assert.equal(typeof ctxId, "string");
const schema = (await client.listTools()).tools.find(tool => tool.name === "bash_run").inputSchema.properties;
const sh = value => "'" + value.replaceAll("'", "'\\''") + "'";
const browser = async (...argv) => {
    const command = ["devshell", "browser", "--profile", "product", ...argv].map(sh).join(" ");
    const args = { command, ctxId };
    if ("waitMs" in schema) args.waitMs = 30000;
    if ("timeoutMs" in schema) args.timeoutMs = 30000;
    const result = await client.callTool({ name: "bash_run", arguments: args });
    const data = result.structuredContent ?? {};
    assert.equal(data.exitCode, 0, command + ": " + JSON.stringify(result).slice(0, 1500));
    return String(data.stdout ?? "");
};
process.env.PLAYWRIGHT_BROWSERS_PATH = join(runtime, "browsers");
const { chromium } = await import(pathToFileURL(join(runtime, "node_modules/playwright/index.mjs")).href);
let viewer;
try {
    console.log("model command:", (await browser("open")).slice(0, 200));
    const html = '<title>Product acceptance</title><button style="width:180px;height:100px" onclick="document.title=&quot;clicked&quot;">Click</button><input id="credential" type="password">';
    const origin = "http://browser-product.invalid/";
    const navigate = "async page => { await page.route(" + JSON.stringify(origin + "**") + ", route => route.fulfill({ status: 200, contentType: 'text/html', body: " + JSON.stringify(html) + " })); await page.goto(" + JSON.stringify(origin) + "); }";
    await browser("run-code", navigate);
    assert.match(await browser("snapshot"), /button "Click"/);
    console.log("model command and snapshot: OK");
    viewer = await chromium.launch({ headless: true });
    const page = await viewer.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    page.on("pageerror", error => console.error("Viewer error:", error.message));
    await page.goto("http://127.0.0.1:" + state.webPort + "/web/extensions/browser/");
    await page.locator('#instance option[value="' + instance + '"]').waitFor({ state: "attached", timeout: 15000 });
    await page.locator("#instance").selectOption(instance);
    await page.locator('#profile option[value="product"]').waitFor({ state: "attached" });
    await page.locator("#profile").selectOption("product");
    await page.locator("#open").click();
    await page.waitForFunction(() => globalThis.document.querySelector("#screen").dataset.ready === "true", { timeout: 15000 });
    assert.match(await page.locator("#status").innerText(), /Connected/);
    console.log("actual WebUI binary JPEG rendering: OK");
    const waiting = browser("run-code", 'async page => { await page.waitForFunction(() => document.title === "clicked"); }');
    await sleep(400);
    const box = await page.locator("#screen").boundingBox();
    await page.mouse.click(box.x + box.width * 40 / 1280, box.y + box.height * 40 / 800);
    await waiting;
    assert.match(await browser("eval", "() => document.title"), /clicked/);
    console.log("actual user pointer during pending model command: OK");
    await page.locator("#settings").click();
    await page.waitForFunction(() => globalThis.document.querySelector("#credentials").textContent.includes("No stored credentials"));
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#credential-file").setInputFiles({ name: "test.env", mimeType: "text/plain", buffer: Buffer.from("LAB_PASSWORD=only-for-product-test\n") });
    await page.locator("#credential-import").click();
    await page.waitForFunction(() => globalThis.document.querySelector("#credentials").textContent.includes("LAB_PASSWORD"));
    await page.locator("#settings-close").click();
    await browser("run-code", 'async page => { await page.evaluate(() => { localStorage.setItem("product-state", "retained"); document.cookie = "product=kept; max-age=3600"; }); }');
    await browser("close");
    await browser("open");
    await browser("run-code", navigate);
    assert.match(await browser("eval", '() => localStorage.getItem("product-state") === "retained" && document.cookie.includes("product=kept")'), /true/);
    const filled = await browser("fill", "#credential", "LAB_PASSWORD");
    assert.ok(!filled.includes("only-for-product-test"));
    assert.match(await browser("eval", '() => document.querySelector("#credential").value === "only-for-product-test"'), /true/);
    console.log("WebUI credential import, model credential substitution and profile persistence: OK");
    await browser("screenshot", "--filename=product.png");
    const files = await browser("files", "list");
    assert.match(files, /product\.png/);
    const listed = JSON.parse(files);
    const file = listed.find(entry => entry.path.endsWith("product.png")).path;
    await browser("files", "export", file, "./product-output.png");
    assert.deepEqual([...((await readFile(join(workspace, "product-output.png"))).subarray(0, 8))], [137,80,78,71,13,10,26,10]);
    console.log("model screenshot file export into its authorized workspace: OK");
    await page.locator("#settings").click();
    await page.locator("#files-refresh").click();
    const row = page.locator(".file-row").filter({ hasText: "product.png" }).first();
    await row.waitFor();
    const download = page.waitForEvent("download", { timeout: 15000 });
    await row.getByRole("button", { name: "Download" }).click();
    const downloaded = await download;
    assert.equal(await downloaded.failure(), null);
    assert.ok((await stat(await downloaded.path())).size > 0);
    await page.locator("#requests").click();
    await page.locator("#activity").getByText(origin, { exact: false }).first().waitFor();
    await page.locator("#actions").click();
    await page.locator("#activity").getByText("screenshot", { exact: false }).first().waitFor();
    await page.locator("#settings-close").click();
    console.log("actual WebUI file download and independent browser logs: OK");
    await browser("close");
    await page.locator("#settings").click();
    await page.waitForFunction(() => !globalThis.document.querySelector("#settings").disabled);
    await page.locator('[data-section="profile-section"]').click();
    await page.locator("#profile-source-kind").selectOption("extension");
    await page.locator("#profile-source-channel").selectOption("msedge");
    await page.locator("#profile-source-directory").fill("Profile 1");
    await page.locator("#profile-source-save").click();
    await page.waitForFunction(() => globalThis.document.querySelector("#management-status").textContent === "Browser source saved.");
    assert.deepEqual(JSON.parse(await browser("profile", "source")), {
        kind: "extension", channel: "msedge", profileDirectory: "Profile 1",
    });
    await page.locator("#settings-close").click();
    await page.locator("#settings").click();
    await page.waitForFunction(() => !globalThis.document.querySelector("#settings").disabled);
    await page.locator('[data-section="profile-section"]').click();
    assert.equal(await page.locator("#profile-source-kind").inputValue(), "extension");
    assert.equal(await page.locator("#profile-source-channel").inputValue(), "msedge");
    assert.equal(await page.locator("#profile-source-directory").inputValue(), "Profile 1");
    await page.locator("#profile-source-kind").selectOption("managed");
    await page.locator("#profile-source-save").click();
    await page.waitForFunction(() => globalThis.document.querySelector("#management-status").textContent === "Browser source saved.");
    assert.deepEqual(JSON.parse(await browser("profile", "source")), { kind: "managed" });
    console.log("user WebUI attached profile configuration, model read and switch back to managed: OK");
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#delete-profile").click();
    await page.waitForFunction(() => ![...globalThis.document.querySelector("#profile").options].some(option => option.value === "product"));
    console.log("user profile deletion: OK");
} finally {
    await viewer?.close();
    await client.close();
}
