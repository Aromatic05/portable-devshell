import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromiumLaunchArguments } from "../../scripts/testspace/TestspaceWebSmoke.mjs";

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function within(operation, label, timeout = 25_000) {
    let timer;
    try {
        return await Promise.race([operation, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout);
        })]);
    } finally { clearTimeout(timer); }
}

export async function until(read, predicate, label, timeout = 25_000) {
    const deadline = Date.now() + timeout;
    let value;
    do {
        value = await read();
        if (predicate(value)) return value;
        await delay(100);
    } while (Date.now() < deadline);
    throw new Error(`${label}: ${JSON.stringify(value)}`);
}

export async function loopbackPort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.equal(typeof address, "object");
    return address.port;
}

// CDP controls an actual browser. No Web domain/store or server RPC is mocked.
export async function launchBrowser(executable, fixture) {
    const port = await loopbackPort();
    const processHandle = spawn(executable, [
        ...chromiumLaunchArguments({ environment: fixture.env }),
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${join(fixture.root, "chromium")}`, "about:blank",
    ], { env: fixture.env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    processHandle.stderr.on("data", (chunk) => { stderr += chunk; });
    let cdp;
    const close = async () => {
        cdp?.close();
        const exited = new Promise((resolve) => processHandle.once("exit", resolve));
        if (processHandle.exitCode === null && processHandle.signalCode === null) {
            processHandle.kill("SIGTERM");
            await Promise.race([exited, delay(1_000)]);
            if (processHandle.exitCode === null && processHandle.signalCode === null) {
                processHandle.kill("SIGKILL");
                await within(exited, "Chromium cleanup", 5_000);
            }
        }
    };
    try {
        // Readiness retries only; no acceptance assertion is swallowed here.
        const deadline = Date.now() + 20_000;
        let targets;
        while (Date.now() < deadline) {
            try {
                const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1_000) });
                if (response.ok) { targets = await response.json(); break; }
            } catch (error) {
                if (processHandle.exitCode !== null) throw new Error(`Chromium exited: ${stderr}`, { cause: error });
            }
            await delay(100);
        }
        const page = targets?.find((target) => target.type === "page");
        assert.equal(typeof page?.webSocketDebuggerUrl, "string", `Missing CDP page: ${stderr}`);
        cdp = await connectCdp(page.webSocketDebuggerUrl);
        await cdp.send("Page.enable");
        await cdp.send("Runtime.enable");
        await cdp.send("Network.enable");
        // Fail exactly one real browser WebSocket send before it reaches Control.
        // Subsequent requests use the original native send; no response is fabricated.
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
            globalThis.__crossClientFault = { armed: false, hits: 0 };
            const send = WebSocket.prototype.send;
            WebSocket.prototype.send = function(data) {
                const fault = globalThis.__crossClientFault;
                if (fault.armed && this.url.includes('/web/rpc')) {
                    fault.armed = false;
                    fault.hits++;
                    this.close(4000, 'crossclient injected disconnect');
                    throw new DOMException('crossclient injected RPC send failure', 'NetworkError');
                }
                return send.call(this, data);
            };
        ` });
        const evaluate = async (expression) => {
            const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
            assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
            return result.result?.value;
        };
        const wait = (expression, label) => until(() => evaluate(expression), (value) => value === true, label);
        const body = () => evaluate("document.body?.innerText ?? ''");
        const visit = async (hash) => {
            await cdp.send("Page.navigate", { url: `http://127.0.0.1:${fixture.webPort}/web/${hash}` });
            await wait("document.body?.innerText.includes('Online') === true", "Web online");
        };
        const reload = async () => {
            const origin = await evaluate("performance.timeOrigin");
            await cdp.send("Page.reload", { ignoreCache: true });
            await wait(`performance.timeOrigin !== ${origin} && document.body?.innerText.includes('Online') === true`, "hard reload and reconnect");
        };
        const click = (label, insideDialog = false) => wait(`(() => {
            const target = [...document.querySelectorAll('button')].find(button =>
                button.textContent?.trim() === ${JSON.stringify(label)} &&
                (button.closest('[role="dialog"]') !== null) === ${insideDialog});
            if (!target || target.disabled) return false;
            target.click(); return true;
        })()`, `click ${insideDialog ? "dialog " : ""}${label}`);
        return { cdp, evaluate, wait, body, visit, reload, click, close };
    } catch (error) {
        await close();
        throw error;
    }
}

async function connectCdp(url) {
    const socket = new WebSocket(url);
    await within(new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
    }), "CDP connect");
    const pending = new Map();
    const events = [];
    let id = 0;
    const rejectPending = () => {
        for (const waiter of pending.values()) waiter.reject(new Error("CDP closed"));
        pending.clear();
    };
    socket.addEventListener("close", rejectPending);
    socket.addEventListener("message", ({ data }) => {
        const message = JSON.parse(String(data));
        const waiter = pending.get(message.id);
        if (waiter) {
            pending.delete(message.id);
            if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
            else waiter.resolve(message.result);
        } else events.push(message);
    });
    return {
        events,
        close() { rejectPending(); socket.close(); },
        send(method, params = {}) {
            const requestId = ++id;
            const operation = new Promise((resolve, reject) => {
                pending.set(requestId, { resolve, reject });
                socket.send(JSON.stringify({ id: requestId, method, params }));
            });
            return within(operation, `CDP ${method}`);
        },
    };
}
