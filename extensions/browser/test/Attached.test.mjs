import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BrowserSession } from "../dist/Session.js";
import { parseSource } from "../dist/Source.js";
import { WireDecoder, WireKind, decodeFrame } from "../dist/Wire.js";

const [runtime, channel, profileDirectory] = process.argv.slice(2);
if (!runtime || !channel) throw new Error("Usage: node test/Attached.test.mjs <runtime> <chrome|msedge> [profile-directory]");
const root = resolve(runtime);
const source = parseSource({ kind: "extension", channel, profileDirectory });
const profile = await mkdtemp(join(tmpdir(), "devshell-attached-browser-test-"));
const marker = randomUUID();
const title = "DevShell Attached Probe " + marker.slice(0, 8);
const path = "/" + marker;
const key = "devshell-attach-" + marker;
const cookie = "devshell_attach_" + marker.replaceAll("-", "");
const html = '<title>' + title + '</title><style>body{margin:0}@keyframes pulse{from{transform:translateX(0)}to{transform:translateX(400px)}}#probe{width:80px;height:80px;background:#369;animation:pulse .5s infinite alternate}</style><button style="width:180px;height:100px" onclick="this.textContent=\'Clicked\'">Probe</button><div id="probe"></div>';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer((request, response) => {
    if (request.url === path) response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
    else response.writeHead(404).end();
});
await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
});
const origin = "http://127.0.0.1:" + server.address().port + path;
const clearMarker = "() => { localStorage.removeItem(" + JSON.stringify(key) +
    "); document.cookie = " + JSON.stringify(cookie + "=; Max-Age=0; Path=" + path) + "; return true; }";

function start() {
    const child = spawn(join(root, process.platform === "win32" ? "bin/node.exe" : "bin/node"),
        [join(root, "helper.mjs"), profile], { stdio: ["pipe", "pipe", "pipe"] });
    const output = child.stdout[Symbol.asyncIterator]();
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    let closing;
    return new BrowserSession({
        async read() { const next = await output.next(); return next.done ? undefined : next.value; },
        write(bytes) { return new Promise((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve())); },
        async finish() { child.stdin.end(); },
        close() {
            return closing ??= new Promise(resolve => {
                if (child.exitCode !== null || child.signalCode !== null) return resolve();
                const timeout = setTimeout(() => child.kill("SIGTERM"), 4000);
                child.once("exit", () => { clearTimeout(timeout); resolve(); });
                child.stdin.end();
            });
        },
    }, async () => {}, error => console.error(error));
}

let session;
let viewer;
const controller = new AbortController();
try {
    console.log("Approve the official connection with NO existing tabs selected (new blank tab only).");
    session = start();
    assert.ok((await session.request("capabilities")).includes("extension"));
    const initial = await session.request("open", { source });
    assert.equal(initial.tabs.length, 1);
    assert.equal(initial.tabs[0].url, "about:blank");
    await assert.rejects(stat(join(profile, "chromium")), { code: "ENOENT" });
    console.log("Attached to the existing browser, without a managed Chromium profile.");

    const navigate = "async page => { await page.goto(" + JSON.stringify(origin) + "); await page.bringToFront(); }";
    await session.request("cli", ["run-code", navigate]);
    assert.match(await session.request("cli", ["snapshot"]), /button "Probe"/);
    viewer = session.frames(AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
    for (let i = 0; i < 2; i++) {
        const next = await viewer.next();
        assert.equal(next.done, false);
        const record = new WireDecoder().push(next.value)[0];
        assert.equal(record.kind, WireKind.frame);
        const frame = decodeFrame(record.data);
        assert.ok(frame.width > 0 && frame.height > 0);
        assert.deepEqual([...frame.jpeg.subarray(0, 2)], [255, 216]);
        console.log("Attached JPEG frame:", frame.width, frame.height, frame.jpeg.length);
    }

    const waiting = session.request("cli", ["run-code", 'async page => { await page.getByRole("button", {name:"Clicked"}).waitFor({timeout:10000}); }']);
    await sleep(300);
    await session.request("input", { type: "down", x: 40, y: 40, button: "left" });
    await session.request("input", { type: "up", x: 40, y: 40, button: "left" });
    await waiting;
    console.log("Viewer pointer and pending CLI command share the existing tab.");

    // Use only a fresh synthetic origin and a test-owned marker, never existing login data.
    await session.request("cli", ["eval", "() => { localStorage.setItem(" + JSON.stringify(key) + "," +
        JSON.stringify(marker) + "); document.cookie = " + JSON.stringify(cookie + "=" + marker +
        "; Max-Age=600; Path=" + path + "; SameSite=Lax") + "; return true; }"]);
    controller.abort();
    await viewer.return();
    viewer = undefined;
    await session.close();
    session = undefined;
    console.log("Detached. Approve the next connection selecting ONLY the tab titled: " + title);

    session = start();
    const reattached = await session.request("open", { source });
    assert.equal(reattached.tabs.length, 1);
    assert.equal(reattached.tabs[0].url, origin);
    const persisted = await session.request("cli", ["eval", "() => localStorage.getItem(" + JSON.stringify(key) + ") === " +
        JSON.stringify(marker) + " && document.cookie.split('; ').includes(" +
        JSON.stringify(cookie + "=" + marker) + ")"]);
    assert.match(persisted, /true/);
    await session.request("cli", ["eval", clearMarker]);
    console.log("The original tab and its synthetic profile marker survive detach and reattach.");
    await session.request("cli", ["tab-close", "0"]);
    await session.close();
    session = undefined;
    console.log("Test-owned tab closed; attached browser session disconnected.");
} finally {
    controller.abort();
    await viewer?.return();
    if (session && !session.closed) {
        const state = await session.request("state").catch(() => null);
        if (state?.tabs.length === 1 && state.tabs[0].url === origin)
            await session.request("cli", ["eval", clearMarker]).catch(() => {});
    }
    await session?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
}
