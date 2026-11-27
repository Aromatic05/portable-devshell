import "./style.css";
import { RemoteBrowser, type Target, type State } from "./RemoteBrowser.js";
import { BrowserInput } from "./Input.js";
import { FrameView } from "./FrameView.js";
import { Management, get, options, type Instance } from "./Management.js";
import { Tabs } from "./Tabs.js";
import type { BrowserSource } from "../src/Source.js";

const instance = get<HTMLSelectElement>("instance");
const profile = get<HTMLSelectElement>("profile");
const url = get<HTMLInputElement>("url");
const screen = get<HTMLCanvasElement>("screen");
const status = get("status");
const api = new RemoteBrowser();
let target: Target | undefined;
let queue = Promise.resolve();
let instances: Instance[] = [];
let selectedSource: BrowserSource = { kind: "managed" };
let opening = false;
let refreshing = false;
const busy = new Set<string>();

function message(text: string, tone = "normal") {
    status.textContent = text;
    status.parentElement!.dataset.tone = tone;
}
function report(error: unknown) { message(String(error), "error"); }
function selection(): Target { return { instance: instance.value, profile: profile.value || "default" }; }
function input(args: unknown) {
    const current = target;
    if (!current) return Promise.resolve();
    queue = queue.then(async () => { if (target === current) await api.request("input", current, args); }).catch(report);
    return queue;
}

function renderChrome() {
    const connected = target !== undefined;
    document.body.dataset.connection = opening && !connected ? "opening" : connected ? "connected" : "idle";
    get("connection-label").textContent = opening && !connected ? "Connecting" : connected ? "Connected" : "Disconnected";
    get("session-identity").textContent = connected ? target!.instance + " / " + target!.profile : "";
    get("empty-title").textContent = opening ? "Connecting to browser" : connected ? "Waiting for the first frame" : "Your remote browser";
    get("empty-description").textContent = opening ? (selectedSource.kind === "extension" ? "Approve the connection in the existing Chrome or Edge window." : "Opening the selected browser profile.") : connected ? "The live browser view will appear here." : "Choose a Worker and profile, then connect to open or resume a browser session.";
    for (const id of ["back", "forward", "refresh", "go", "newtab", "detach"])
        get<HTMLButtonElement>(id).disabled = !connected || busy.has(id);
    url.disabled = !connected;
    get<HTMLButtonElement>("open").hidden = connected;
    get<HTMLButtonElement>("open").disabled = opening || !instance.value || busy.has("open");
    get<HTMLButtonElement>("close").disabled = !instance.value || opening || busy.has("close");
    const close = get<HTMLButtonElement>("close");
    close.title = selectedSource.kind === "extension" ? "Disconnect from existing browser (keep its tabs open)" : "Close browser session";
    close.setAttribute("aria-label", selectedSource.kind === "extension" ? "Disconnect browser" : "Close browser");
    instance.disabled = profile.disabled = opening;
}
const controller = new BrowserInput(screen, get<HTMLTextAreaElement>("keyboard"), input);
const frameView = new FrameView(screen, (width, height) => {
    controller.dimensions(width, height);
    get("frame-size").textContent = width + " × " + height;
}, report);
const tabs = new Tabs(get("tabs"),
    async index => { await input({ type: "tab", index }); await state(); },
    async index => { await input({ type: "closeTab", index }); await state(); },
    report,
);

async function refresh(preferredProfile?: string) {
    instances = await api.request<Instance[]>("runtimes");
    options(instance, instances.map(value => ({ value: value.instance, label: value.instance + (value.installed ? "" : " (no runtime)") })));
    const current = instance.value;
    if (!current) { renderChrome(); return; }
    const names = await api.request<string[]>("profiles", { instance: current });
    if (current !== instance.value) return;
    options(profile, [...new Set(["default", ...names])].map(name => ({ value: name, label: name })));
    if (preferredProfile && names.includes(preferredProfile)) profile.value = preferredProfile;
    await refreshSource();
    renderChrome();
}
async function refreshSource() {
    const selected = selection();
    if (!selected.instance) return;
    const source = await api.request<BrowserSource>("profile-source", selected);
    if (selected.instance !== instance.value || selected.profile !== profile.value) return;
    selectedSource = source;
    renderChrome();
}
async function state() {
    const current = target;
    if (!current || refreshing) return;
    refreshing = true;
    try {
        const value = await api.request<State | null>("state", current);
        if (target !== current) return;
        if (!value) { stop(); message("Browser session ended."); return; }
        tabs.render(value);
        if (document.activeElement !== url) url.value = value.tabs.find(tab => tab.index === value.active)?.url || "";
    } finally { refreshing = false; }
}
function stop() {
    controller.release();
    api.stop(); target = undefined; controller.dimensions(0, 0);
    frameView.clear();
    tabs.render();
    url.value = "";
    get("frame-size").textContent = "";
    renderChrome();
}
async function open() {
    if (opening) return;
    opening = true;
    try {
        const selected = selection();
        if (!instances.find(item => item.instance === selected.instance)?.installed) throw new Error("Install a runtime for this instance in Manage.");
        await refreshSource();
        stop();
        message(selectedSource.kind === "extension" ? "Approve the connection in your browser…" : "Opening browser…");
        await api.request("command", selected, ["open"]);
        if (selected.instance !== instance.value || selected.profile !== profile.value) return;
        target = selected;
        renderChrome();
        await state();
        if (target !== selected) return;
        message("Connected — click the page to interact.");
        void api.watch(selected, frame => {
            if (target === selected) frameView.push(frame);
        }).then(() => {
            if (target === selected) { stop(); message("Viewer disconnected. Reattach to continue."); }
        }).catch(error => { if (target === selected) { stop(); report(error); } });
    } finally { opening = false; renderChrome(); }
}
function bind(id: string, fn: () => Promise<void>) {
    get<HTMLButtonElement>(id).addEventListener("click", () => {
        busy.add(id); renderChrome();
        void fn().catch(report).finally(() => { busy.delete(id); renderChrome(); });
    });
}
async function command(args: string[]) { if (target) await api.request("command", target, args); await state(); }
bind("open", open);
bind("detach", async () => { stop(); message("Viewer detached. Browser remains open."); });
bind("close", async () => { const current = target || selection(); stop(); message(await api.request<string>("command", current, ["close"])); });
bind("newtab", async () => { await input({ type: "newTab" }); await state(); });
bind("back", () => command(["go-back"]));
bind("forward", () => command(["go-forward"]));
bind("refresh", () => command(["reload"]));
get<HTMLFormElement>("navigate").addEventListener("submit", event => { event.preventDefault(); void command(["goto", url.value]).catch(report); });
instance.addEventListener("change", () => { stop(); message("Select a profile and connect."); void refresh().catch(report); });
profile.addEventListener("change", () => { stop(); message("Select a profile and connect."); void refreshSource().catch(report); });
window.addEventListener("pagehide", stop);
setInterval(() => { if (target) void state().catch(report); }, 1500);
new Management(api, selection, refresh, stop);
renderChrome();
void refresh().catch(report);
