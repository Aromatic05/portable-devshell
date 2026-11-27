import { Browser } from "./Browser.mjs";
import { WireDecoder, decodeMessage, encodeMessage, encodeFrame } from "./Wire.js";

const profile = process.argv[2];
if (!profile) throw new Error("Browser profile directory is required.");
const send = bytes => new Promise((resolve, reject) => {
    process.stdout.write(bytes, error => error ? reject(error) : resolve());
});
let latest;
let sendingFrame = false;
let closed = false;
const output = {
    message: value => { if (!closed) void send(encodeMessage(value)).catch(() => {}); },
    disconnected: () => { void stop().catch(error => console.error(error.message)); },
    frame: frame => {
        if (closed) return;
        latest = frame;
        if (sendingFrame) return;
        sendingFrame = true;
        void (async () => {
            try {
                while (latest && !closed) {
                    const current = latest;
                    latest = undefined;
                    await send(encodeFrame(current.viewportWidth, current.viewportHeight, current.data));
                }
            } finally { sendingFrame = false; }
        })().catch(() => { closed = true; });
    },
};
const browser = new Browser(import.meta.dirname, profile, output);
const decoder = new WireDecoder();
let stopping;
function stop() {
    closed = true;
    stopping ??= browser.close().finally(() => process.stdin.destroy());
    return stopping;
}
process.on("SIGTERM", () => { void stop().catch(error => console.error(error.message)); });
process.on("SIGINT", () => { void stop().catch(error => console.error(error.message)); });
async function dispatch({ id, op, args }) {
    try {
        let result;
        switch (op) {
            case "capabilities": result = ["managed", "extension"]; break;
            case "probe": result = await browser.probe(); break;
            case "files": result = await browser.files(); break;
            case "profile-delete": result = await browser.removeProfile(); break;
            case "open": result = await browser.open(args); break;
            case "cli": result = await browser.cli(args); break;
            case "state": result = await browser.state(); break;
            case "input": result = await browser.input(args); break;
            case "cast": result = await browser.cast(args); break;
            case "close": await browser.close(); result = null; break;
            default: throw new Error("Unknown browser operation.");
        }
        await send(encodeMessage({ id, result }));
        if (op === "close") closed = true;
    } catch (error) {
        await send(encodeMessage({ id, error: error.message }));
    }
}
// Human pointer/keyboard actions must remain usable while Playwright is waiting
// for a page operation. Only commands that manipulate CLI tab state share its lane.
const lanes = { cli: Promise.resolve(), input: Promise.resolve(), view: Promise.resolve() };
function enqueue(request) {
    const lane = request.op === "cli" || (request.op === "input" &&
        ["tab", "newTab", "closeTab"].includes(request.args?.type)) ? "cli"
        : request.op === "input" ? "input" : "view";
    lanes[lane] = lanes[lane].then(() => closed ? undefined : dispatch(request))
        .catch(error => { console.error(error.message); });
}

try {
    for await (const chunk of process.stdin) {
        for (const record of decoder.push(chunk)) {
            const request = decodeMessage(record);
            if (request.op === "open" || request.op === "close") {
                await dispatch(request);
            } else {
                enqueue(request);
            }
            if (closed) break;
        }
        if (closed) break;
    }
} finally {
    closed = true;
    await browser.close();
}
