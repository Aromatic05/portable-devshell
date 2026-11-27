import type { RemoteBrowser, Target } from "./RemoteBrowser.js";
import { browserChannels, type BrowserSource } from "../src/Source.js";
import { icon } from "./Icons.js";

export interface Instance { instance: string; ready: boolean; installed: boolean }
export const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export function options(select: HTMLSelectElement, values: { value: string; label: string }[]) {
    const current = select.value;
    select.replaceChildren(...values.map(value => new Option(value.label, value.value)));
    if (values.some(value => value.value === current)) select.value = current;
}

export class Management {
    constructor(private api: RemoteBrowser, private selection: () => Target, private refresh: (preferredProfile?: string) => Promise<void>, private detach: () => void) {
        this.bind("settings", async () => {
            get<HTMLDialogElement>("management").showModal();
            this.section("credentials-section");
            await this.load();
        });
        for (const button of document.querySelectorAll<HTMLButtonElement>("[data-section]")) {
            button.addEventListener("click", () => this.section(button.dataset.section!));
        }
        this.bind("settings-close", async () => get<HTMLDialogElement>("management").close());
        this.bind("runtime-use", async () => {
            const generation = get<HTMLSelectElement>("bundles").value;
            if (!generation) throw new Error("Import a runtime directory first.");
            await this.api.request("runtime-use", this.selection(), generation);
            await this.refresh(); await this.load();
        });
        this.bind("create", async () => {
            const name = get<HTMLInputElement>("new-profile").value.trim();
            if (!name) return;
            await this.api.request("command", this.selection(), ["profile", "create", name]);
            this.detach();
            await this.refresh(name);
            get<HTMLInputElement>("new-profile").value = "";
            await this.load();
        });
        const kind = get<HTMLSelectElement>("profile-source-kind");
        const channel = get<HTMLSelectElement>("profile-source-channel");
        options(channel, browserChannels.map(value => ({ value, label: value.startsWith("msedge") ? "Edge" + value.slice(6) : "Chrome" + value.slice(6) })));
        kind.addEventListener("change", () => this.sourceFields());
        this.bind("profile-source-save", async () => {
            const directory = get<HTMLInputElement>("profile-source-directory").value.trim();
            const source = kind.value === "extension" ? {
                kind: "extension", channel: channel.value, ...(directory ? { profileDirectory: directory } : {}),
            } : { kind: "managed" };
            await this.api.request("profile-source-set", this.selection(), source);
            await this.refresh(); await this.load();
            get("management-status").textContent = "Browser source saved.";
        });
        this.bind("delete-profile", async () => {
            const target = this.selection();
            if (!confirm("Delete DevShell profile " + target.profile + ", its managed data and credentials? External browser data is kept.")) return;
            this.detach(); await this.api.request("profile-delete", target);
            await this.refresh(); await this.load();
        });
        this.bind("credential-import", async () => {
            const input = get<HTMLInputElement>("credential-file");
            const file = input.files?.[0];
            if (!file) throw new Error("Choose a dotenv file.");
            if (file.size > 65536) throw new Error("Credential file exceeds 64 KiB.");
            if (!confirm("Replace this profile's credentials?")) return;
            await this.api.request("credentials-import", this.selection(), await file.text());
            input.value = ""; await this.load();
        });
        this.bind("credential-clear", async () => {
            if (!confirm("Clear this profile's stored credentials?")) return;
            await this.api.request("credentials-clear", this.selection());
            await this.load();
        });
        this.bind("files-refresh", () => this.files());
        this.bind("actions", () => this.activity("actions"));
        this.bind("requests", () => this.activity("requests"));
    }

    private section(id: string) {
        for (const button of document.querySelectorAll<HTMLButtonElement>("[data-section]")) {
            const selected = button.dataset.section === id;
            button.classList.toggle("selected", selected);
            if (selected) button.setAttribute("aria-current", "true");
            else button.removeAttribute("aria-current");
        }
        get(id).scrollIntoView({ block: "start", inline: "nearest" });
    }

    private empty(id: string, text: string) {
        const node = document.createElement("div");
        node.className = "list-empty";
        node.textContent = text;
        get(id).replaceChildren(node);
    }

    private showCredentials(names: string[]) {
        get("credential-count").textContent = String(names.length);
        if (!names.length) { this.empty("credentials", "No stored credentials"); return; }
        get("credentials").replaceChildren(...names.map(name => {
            const row = document.createElement("div");
            row.className = "credential-row";
            const label = document.createElement("code");
            label.textContent = name;
            const hidden = document.createElement("span");
            hidden.className = "credential-hidden";
            hidden.textContent = "••••••";
            hidden.title = "Credential value is not displayed";
            hidden.setAttribute("aria-hidden", "true");
            row.append(icon("key"), label, hidden);
            return row;
        }));
    }

    private sourceFields() {
        get("profile-source-extension").hidden = get<HTMLSelectElement>("profile-source-kind").value !== "extension";
    }

    async load() {
        const target = this.selection();
        get("managed-target").textContent = target.instance + " / " + target.profile;
        const [instances, bundles, names, source] = await Promise.all([
            this.api.request<Instance[]>("runtimes"),
            this.api.request<string[]>("bundles"),
            this.api.request<string[]>("credentials", target),
            this.api.request<BrowserSource>("profile-source", target),
        ]);
        const instance = instances.find(item => item.instance === target.instance);
        const runtimeStatus = get("runtime-status");
        runtimeStatus.textContent = instance?.installed ? "Installed" : "Not installed";
        runtimeStatus.dataset.installed = String(instance?.installed ?? false);
        options(get<HTMLSelectElement>("bundles"), bundles.map(value => ({ value, label: value.slice(0, 16) })));
        get<HTMLSelectElement>("profile-source-kind").value = source.kind;
        get<HTMLSelectElement>("profile-source-channel").value = source.kind === "extension" ? source.channel : "chrome";
        get<HTMLInputElement>("profile-source-directory").value = source.kind === "extension" ? source.profileDirectory ?? "" : "";
        this.sourceFields();
        this.showCredentials(names);
        this.empty("files", "Refresh to load files.");
        this.empty("activity", "Choose a log to view recent records.");
        for (const id of ["actions", "requests"]) get(id).setAttribute("aria-pressed", "false");
    }

    private bind(id: string, action: () => Promise<void>) {
        get<HTMLButtonElement>(id).addEventListener("click", () => {
            const button = get<HTMLButtonElement>(id);
            button.disabled = true; get("management-status").textContent = "";
            void action().catch(error => { get("management-status").textContent = String(error); })
                .finally(() => { button.disabled = false; });
        });
    }

    private async files() {
        const target = this.selection();
        const entries = await this.api.request<{ path: string; bytes: number }[]>("files", target);
        const root = get("files"); root.replaceChildren();
        for (const file of entries) {
            const row = document.createElement("div"); row.className = "file-row";
            const name = document.createElement("span"); name.textContent = file.path + " (" + file.bytes + " bytes)";
            const download = document.createElement("button"); download.className = "button";
            download.append(icon("download"), "Download");
            download.addEventListener("click", () => {
                void this.api.request<{ url: string; name: string }>("file-share", target, file.path).then(result => {
                    const link = document.createElement("a"); link.href = result.url; link.download = result.name; link.click();
                }).catch(error => { get("management-status").textContent = String(error); });
            });
            row.append(name, download); root.append(row);
        }
        if (!entries.length) this.empty("files", "No browser output files.");
    }

    private async activity(op: "actions" | "requests") {
        const values = await this.api.request<Record<string, string | number | null>[]>(op, this.selection());
        for (const id of ["actions", "requests"]) get(id).setAttribute("aria-pressed", String(id === op));
        const root = get("activity"); root.replaceChildren();
        for (const value of values) {
            const row = document.createElement("div"); row.className = "activity-row";
            const time = new Date(Number(value.at)).toLocaleString();
            row.textContent = op === "actions" ? time + " · " + value.action + " · " + (value.ok ? "OK" : "Failed")
                : time + " · " + value.method + " " + value.status + " " + value.url;
            root.append(row);
        }
        if (!values.length) this.empty("activity", "No records.");
    }
}
