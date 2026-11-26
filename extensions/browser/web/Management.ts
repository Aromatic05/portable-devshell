import type { RemoteBrowser, Target } from "./RemoteBrowser.js";

export interface Instance { instance: string; ready: boolean; installed: boolean }
export const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export function options(select: HTMLSelectElement, values: { value: string; label: string }[]) {
    const current = select.value;
    select.replaceChildren(...values.map(value => new Option(value.label, value.value)));
    if (values.some(value => value.value === current)) select.value = current;
}

export class Management {
    constructor(private api: RemoteBrowser, private selection: () => Target, private refresh: () => Promise<void>, private detach: () => void) {
        this.bind("settings", async () => { get<HTMLDialogElement>("management").showModal(); await this.load(); });
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
            await this.refresh(); get<HTMLSelectElement>("profile").value = name;
            get<HTMLInputElement>("new-profile").value = "";
            await this.load();
        });
        this.bind("delete-profile", async () => {
            const target = this.selection();
            if (!confirm("Delete profile " + target.profile + " and its browser data?")) return;
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

    async load() {
        const target = this.selection();
        const [instances, bundles, names] = await Promise.all([
            this.api.request<Instance[]>("runtimes"),
            this.api.request<string[]>("bundles"),
            this.api.request<string[]>("credentials", target),
        ]);
        const instance = instances.find(item => item.instance === target.instance);
        get("runtime-status").textContent = instance?.installed ? "Runtime installed" : "No runtime installed";
        options(get<HTMLSelectElement>("bundles"), bundles.map(value => ({ value, label: value.slice(0, 16) })));
        get("credentials").textContent = names.length ? names.join(", ") : "No stored credentials";
        get("files").replaceChildren();
        get("activity").replaceChildren();
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
            const download = document.createElement("button"); download.textContent = "Download";
            download.addEventListener("click", () => {
                void this.api.request<{ url: string; name: string }>("file-share", target, file.path).then(result => {
                    const link = document.createElement("a"); link.href = result.url; link.download = result.name; link.click();
                }).catch(error => { get("management-status").textContent = String(error); });
            });
            row.append(name, download); root.append(row);
        }
        if (!entries.length) root.textContent = "No browser output files.";
    }

    private async activity(op: "actions" | "requests") {
        const values = await this.api.request<Record<string, string | number | null>[]>(op, this.selection());
        const root = get("activity"); root.replaceChildren();
        for (const value of values) {
            const row = document.createElement("div"); row.className = "activity-row";
            const time = new Date(Number(value.at)).toLocaleString();
            row.textContent = op === "actions" ? time + " · " + value.action + " · " + (value.ok ? "OK" : "Failed")
                : time + " · " + value.method + " " + value.status + " " + value.url;
            root.append(row);
        }
        if (!values.length) root.textContent = "No records.";
    }
}
