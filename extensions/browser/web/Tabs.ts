import type { State } from "./RemoteBrowser.js";
import { icon } from "./Icons.js";

/** Render real browser tabs; unchanged poll results do not replace focused controls. */
export class Tabs {
    private previous = "";

    constructor(
        private root: HTMLElement,
        private select: (index: number) => Promise<void>,
        private close: (index: number) => Promise<void>,
        private report: (error: unknown) => void,
    ) {}

    render(state?: State) {
        const signature = JSON.stringify(state ?? null);
        if (signature === this.previous) return;
        this.previous = signature;
        if (!state?.tabs.length) {
            const placeholder = document.createElement("span");
            placeholder.className = "tab-placeholder";
            placeholder.textContent = state ? "No open tabs" : "No browser attached";
            this.root.replaceChildren(placeholder);
            return;
        }

        const tabs = state.tabs.map(tab => {
            const active = tab.index === state.active;
            const item = document.createElement("div");
            item.className = "browser-tab" + (active ? " active" : "");

            const select = document.createElement("button");
            select.type = "button";
            select.className = "tab-select";
            select.setAttribute("aria-current", String(active));
            select.title = tab.title || tab.url || "New tab";
            const title = document.createElement("span");
            title.className = "tab-title";
            title.textContent = select.title;
            select.append(icon("globe"), title);
            select.addEventListener("click", () => {
                if (!active) void this.select(tab.index).catch(this.report);
            });

            const close = document.createElement("button");
            close.type = "button";
            close.className = "icon-button tab-close";
            close.title = "Close " + select.title;
            close.setAttribute("aria-label", close.title);
            close.append(icon("close"));
            close.addEventListener("click", () => {
                close.disabled = true;
                void this.close(tab.index).catch(this.report).finally(() => { close.disabled = false; });
            });

            item.append(select, close);
            return item;
        });
        this.root.replaceChildren(...tabs);
        const current = tabs.find(item => item.classList.contains("active"));
        current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
}
