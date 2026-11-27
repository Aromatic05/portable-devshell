import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BrowserSession } from "../dist/Session.js";
import { WireDecoder, WireKind, decodeFrame } from "../dist/Wire.js";

const runtime = process.argv[2];
if (!runtime) throw new Error("Usage: node test/Runtime.test.mjs <prepared-runtime-directory>");
const root = resolve(runtime);
const profile = await mkdtemp(join(tmpdir(), "devshell-browser-test-"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const requests = [];
const page = '<title>Browser control probe</title><button style="width:180px;height:100px" onclick="document.title=\'clicked\'">Click</button><input id="credential" type="password">';
const origin = "http://browser-extension.invalid/";
const navigate = ["run-code", "async page => { await page.route(" + JSON.stringify(origin + "**") +
    ", route => route.fulfill({ status: 200, contentType: 'text/html', body: " + JSON.stringify(page) +
    " })); await page.goto(" + JSON.stringify(origin) + "); }"];

function start() {
    const child = spawn(join(root, process.platform === "win32" ? "bin/node.exe" : "bin/node"),
        [join(root, "helper.mjs"), profile], { stdio: ["pipe", "pipe", "pipe"] });
    const output = child.stdout[Symbol.asyncIterator]();
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    let closing;
    const processHandle = {
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
    };
    return new BrowserSession(processHandle, async event => { requests.push(event); }, error => console.error(error));
}

let session;
const controller = new AbortController();
try {
    session = start();
    const initial = await session.request("open", { credentials: "LAB_PASSWORD=only-for-test-324\n" });
    assert.equal(initial.tabs.length, 1);
    console.log("open and native Playwright CLI attach: OK");

    await session.request("cli", navigate);
    const snapshot = await session.request("cli", ["snapshot"]);
    assert.match(snapshot, /button "Click"/);
    assert.ok(requests.some(event => event.url === origin && event.method === "GET" && event.status === 200));
    console.log("Playwright command, snapshot and request events: OK");

    const viewer = session.frames(controller.signal);
    const first = await viewer.next();
    assert.equal(first.done, false);
    const record = new WireDecoder().push(first.value)[0];
    assert.equal(record.kind, WireKind.frame);
    const frame = decodeFrame(record.data);
    assert.deepEqual([...frame.jpeg.subarray(0, 2)], [255, 216]);
    console.log("binary screencast:", frame.width, frame.height, frame.jpeg.length);

    const waiting = session.request("cli", ["run-code", 'async page => { await page.waitForFunction(() => document.title === "clicked"); }']);
    await sleep(300);
    await session.request("input", { type: "down", x: 40, y: 40, button: "left" });
    await session.request("input", { type: "up", x: 40, y: 40, button: "left" });
    await waiting;
    assert.equal((await session.request("state")).tabs[0].title, "clicked");
    console.log("viewer pointer input during pending model command: OK");

    const output = await session.request("cli", ["fill", "#credential", "LAB_PASSWORD"]);
    assert.ok(!output.includes("only-for-test-324"));
    const verify = await session.request("cli", ["eval", '() => document.querySelector("#credential").value === "only-for-test-324"']);
    assert.match(verify, /true/);
    console.log("credential substitution: OK");

    await session.request("cli", ["run-code", 'async page => { await page.evaluate(() => { localStorage.setItem("devshell-profile", "persistent"); document.cookie = "profile=kept; max-age=3600"; }); }']);
    controller.abort();
    await viewer.return();
    await session.close();
    session = start();
    await session.request("open", {});
    await session.request("cli", navigate);
    const persisted = await session.request("cli", ["eval", '() => localStorage.getItem("devshell-profile") === "persistent" && document.cookie.includes("profile=kept")']);
    assert.match(persisted, /true/);
    console.log("persistent profile storage and cookies after close/reopen: OK");
    await session.close();
    session = undefined;
    console.log("cast and browser close: OK");
} finally {
    controller.abort();
    await session?.close();
    await rm(profile, { recursive: true, force: true });
}
