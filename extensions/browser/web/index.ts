import "./style.css";
import { RemoteBrowser, type Target, type State } from "./RemoteBrowser.js";
import { BrowserInput } from "./Input.js";
import { FrameView } from "./FrameView.js";
import { Management, get, options, type Instance } from "./Management.js";

const instance = get<HTMLSelectElement>("instance");
const profile = get<HTMLSelectElement>("profile");
const tabs = get<HTMLSelectElement>("tabs");
const url = get<HTMLInputElement>("url");
const screen = get<HTMLCanvasElement>("screen");
const status = get("status");
const api = new RemoteBrowser();
let target: Target | undefined;
let queue = Promise.resolve();
let instances: Instance[] = [];
let opening = false;
let refreshing = false;

function report(error: unknown) { status.textContent = String(error); }
function selection(): Target { return { instance: instance.value, profile: profile.value || "default" }; }
function input(args: unknown) {
    const current = target;
    if (!current) return Promise.resolve();
    queue = queue.then(async () => { if (target === current) await api.request("input", current, args); }).catch(report);
    return queue;
}
const controller = new BrowserInput(screen, get<HTMLTextAreaElement>("keyboard"), input);
const frameView = new FrameView(screen, (width, height) => controller.dimensions(width, height), report);
async function refresh() {
    instances = await api.request<Instance[]>("runtimes");
    options(instance, instances.map(value => ({ value: value.instance, label: value.instance + (value.installed ? "" : " (no runtime)") })));
    const current = instance.value;
    if (!current) return;
    const names = await api.request<string[]>("profiles", { instance: current });
    if (current !== instance.value) return;
    options(profile, [...new Set(["default", ...names])].map(name => ({ value: name, label: name })));
}
async function state() {
    const current = target;
    if (!current || refreshing) return;
    refreshing = true;
    try {
        const value = await api.request<State | null>("state", current);
        if (target !== current) return;
        if (!value) { stop(); status.textContent = "Browser closed."; return; }
        options(tabs, value.tabs.map(tab => ({ value: String(tab.index), label: tab.title || tab.url || "New tab" })));
        tabs.value = String(value.active);
        if (document.activeElement !== url) url.value = value.tabs.find(tab => tab.index === value.active)?.url || "";
    } finally { refreshing = false; }
}
function stop() {
    controller.release();
    api.stop(); target = undefined; controller.dimensions(0, 0);
    frameView.clear();
}
async function open() {
    if (opening) return;
    opening = true;
    try {
        const selected = selection();
        if (!instances.find(item => item.instance === selected.instance)?.installed) throw new Error("Install a runtime for this instance in Manage.");
        stop();
        status.textContent = "Opening browser…";
        await api.request("command", selected, ["open"]);
        if (selected.instance !== instance.value || selected.profile !== profile.value) return;
        target = selected;
        await state();
        if (target !== selected) return;
        status.textContent = "Connected — click the page to interact.";
        void api.watch(selected, frame => {
            if (target !== selected) return;
            frameView.push(frame);
        }).then(() => {
            if (target === selected) { stop(); status.textContent = "Viewer disconnected. Reattach to continue."; }
        }).catch(error => { if (target === selected) { stop(); report(error); } });
    } finally { opening = false; }
}
function bind(id: string, fn: () => Promise<void>) {
    get<HTMLButtonElement>(id).addEventListener("click", () => {
        const button = get<HTMLButtonElement>(id); button.disabled = true;
        void fn().catch(report).finally(() => { button.disabled = false; });
    });
}
async function command(args: string[]) { if (target) await api.request("command", target, args); await state(); }
bind("open", open);
bind("detach", async () => { stop(); status.textContent = "Viewer detached. Browser remains open."; });
bind("close", async () => { const current = target || selection(); stop(); await api.request("command", current, ["close"]); status.textContent = "Browser closed."; });
bind("newtab", async () => { await input({ type: "newTab" }); await state(); });
bind("closetab", async () => { await input({ type: "closeTab", index: Number(tabs.value) }); await state(); });
bind("back", () => command(["go-back"]));
bind("forward", () => command(["go-forward"]));
bind("refresh", () => command(["reload"]));
tabs.addEventListener("change", () => void input({ type: "tab", index: Number(tabs.value) }).then(state).catch(report));
get<HTMLFormElement>("navigate").addEventListener("submit", event => { event.preventDefault(); void command(["goto", url.value]).catch(report); });
instance.addEventListener("change", () => { stop(); void refresh().catch(report); });
profile.addEventListener("change", stop);
window.addEventListener("pagehide", stop);
setInterval(() => { if (target) void state().catch(report); }, 1500);
new Management(api, selection, refresh, stop);
void refresh().catch(report);
