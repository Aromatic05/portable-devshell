import type { JsonValue } from "@portable-devshell/shared";

import type { PiSessionLike } from "../runtime/Sdk.js";
import type { DevshellPiToolSession } from "./Bridge.js";

export interface PiToolExposureDomain {
    readonly expanded: readonly string[];
    readonly expandOnTools?: readonly string[];
    readonly gateway: readonly string[];
}

export const PI_TMUX_TOOL_NAMES = Object.freeze([
    "tmux_input",
    "tmux_inspect",
    "tmux_manage",
    "tmux_read",
    "tmux_run",
] as const);

export const PI_TMUX_TOOL_DOMAIN: PiToolExposureDomain = Object.freeze({
    expanded: PI_TMUX_TOOL_NAMES,
    expandOnTools: ["tmux_run"],
    gateway: ["tmux_run"],
});

export class PiToolExposureController {
    readonly #baseTools: readonly string[];
    readonly #domains: Readonly<Record<string, PiToolExposureDomain>>;
    readonly #expanded = new Map<string, boolean>();
    readonly #session: PiSessionLike;
    readonly #supported: boolean;
    #unsubscribe?: () => void;

    constructor(
        session: PiSessionLike,
        domains: Readonly<Record<string, PiToolExposureDomain>>,
    ) {
        this.#session = session;
        this.#domains = domains;
        const getActive = session.getActiveToolNames;
        const setActive = session.setActiveToolsByName;
        this.#supported =
            typeof getActive === "function" && typeof setActive === "function";
        const controlled = new Set(
            Object.values(domains).flatMap((domain) => domain.expanded),
        );
        this.#baseTools =
            typeof getActive === "function" && typeof setActive === "function"
                ? getActive.call(session).filter(
                      (name) => !controlled.has(name),
                  )
                : [];
        for (const name of Object.keys(domains)) this.#expanded.set(name, false);
        this.#apply();
        if (this.#supported && session.subscribe !== undefined) {
            this.#unsubscribe = session.subscribe((event) => this.#observe(event));
        }
    }

    get supported(): boolean {
        return this.#supported;
    }

    isExpanded(domain: string): boolean {
        return this.#expanded.get(domain) === true;
    }

    setExpanded(domain: string, expanded: boolean): void {
        if (!(domain in this.#domains))
            throw new Error(`Unknown Pi tool exposure domain: ${domain}.`);
        if (this.#expanded.get(domain) === expanded) return;
        this.#expanded.set(domain, expanded);
        this.#apply();
    }

    close(): void {
        this.#unsubscribe?.();
        this.#unsubscribe = undefined;
    }

    #apply(): void {
        if (!this.#supported) return;
        const tools = new Set(this.#baseTools);
        for (const [name, domain] of Object.entries(this.#domains)) {
            const selected =
                this.#expanded.get(name) === true
                    ? domain.expanded
                    : domain.gateway;
            for (const toolName of selected) tools.add(toolName);
        }
        this.#session.setActiveToolsByName?.([...tools]);
    }

    #observe(value: unknown): void {
        const event = asRecord(value);
        if (
            event?.type !== "tool_execution_end" ||
            event.isError === true ||
            typeof event.toolName !== "string"
        )
            return;
        for (const [name, domain] of Object.entries(this.#domains)) {
            if (domain.expandOnTools?.includes(event.toolName) === true)
                this.setExpanded(name, true);
        }
    }
}

export async function hasExpandedPiTmuxResources(
    tools: DevshellPiToolSession,
): Promise<boolean> {
    if (!tools.tools.some((tool) => tool.name === "tmux_manage")) return false;
    try {
        const result = asRecord(
            await tools.callTool(
                "tmux_manage",
                { command: "list" },
                "pi-tool-exposure-tmux-list",
            ),
        );
        if (!Array.isArray(result?.panes)) return false;
        return result.panes.some((value) => {
            const pane = asRecord(value);
            if (pane === undefined) return false;
            if (typeof pane.name === "string" && pane.name !== "main") return true;
            return asRecord(pane.task) !== undefined;
        });
    } catch {
        return false;
    }
}

function asRecord(value: unknown): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, JsonValue>)
        : undefined;
}
