export interface PiToolExposureSurface {
    getActiveToolNames(): string[];
    setActiveToolsByName(toolNames: readonly string[]): void;
    subscribe?(listener: (event: unknown) => void): () => void;
}

export interface PiToolExposureDomain {
    readonly expanded: readonly string[];
    readonly expandOnResult?: (toolName: string, details: unknown) => boolean;
    readonly gateway: readonly string[];
}

export const PI_PROCESS_TOOL_NAMES = Object.freeze([
    "task_input",
    "task_inspect",
    "task_manage",
] as const);

export const PI_PROCESS_TOOL_DOMAIN: PiToolExposureDomain = Object.freeze({
    expanded: PI_PROCESS_TOOL_NAMES,
    expandOnResult(toolName: string, details: unknown) {
        if (toolName === "bash_run") return true;
        if (toolName !== "task_manage") return false;
        const result = asRecord(details);
        // Pi's completion event has no input. Expand when create returns a task
        // and cursor, or when list returns at least one existing task.
        return (
            (typeof asRecord(result?.task)?.id === "string" &&
                typeof result?.cursor === "string") ||
            (Array.isArray(result?.tasks) && result.tasks.length > 0)
        );
    },
    gateway: ["task_manage"],
});

export class PiToolExposureController {
    readonly #baseTools: readonly string[];
    readonly #domains: Readonly<Record<string, PiToolExposureDomain>>;
    readonly #expanded = new Map<string, boolean>();
    readonly #surface: PiToolExposureSurface;
    #unsubscribe?: () => void;

    constructor(
        surface: PiToolExposureSurface,
        domains: Readonly<Record<string, PiToolExposureDomain>>,
    ) {
        this.#surface = surface;
        this.#domains = domains;
        const controlled = new Set(
            Object.values(domains).flatMap((domain) => domain.expanded),
        );
        this.#baseTools = surface
            .getActiveToolNames()
            .filter((name) => !controlled.has(name));
        for (const name of Object.keys(domains)) this.#expanded.set(name, false);
        this.#apply();
        if (surface.subscribe !== undefined) {
            this.#unsubscribe = surface.subscribe((event) => this.#observe(event));
        }
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
        const tools = new Set(this.#baseTools);
        for (const [name, domain] of Object.entries(this.#domains)) {
            const selected =
                this.#expanded.get(name) === true
                    ? domain.expanded
                    : domain.gateway;
            for (const toolName of selected) tools.add(toolName);
        }
        this.#surface.setActiveToolsByName([...tools]);
    }

    #observe(value: unknown): void {
        const event = asRecord(value);
        if (
            event?.type !== "tool_execution_end" ||
            typeof event.toolName !== "string" ||
            event.isError !== false
        )
            return;
        const details = asRecord(event.result)?.details;
        for (const [name, domain] of Object.entries(this.#domains)) {
            if (domain.expandOnResult?.(event.toolName, details) === true)
                this.setExpanded(name, true);
        }
    }
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
