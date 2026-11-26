export interface PiToolExposureSurface {
    getActiveToolNames(): string[];
    setActiveToolsByName(toolNames: readonly string[]): void;
}

interface PiToolExposureDomain {
    readonly expanded: readonly string[];
    readonly gateway: readonly string[];
}

export class PiToolExposureController {
    readonly #domain: PiToolExposureDomain;
    readonly #controlledTools: ReadonlySet<string>;
    readonly #allowedTools: ReadonlySet<string>;
    readonly #surface: PiToolExposureSurface;
    #expanded = false;

    constructor(
        surface: PiToolExposureSurface,
        domain: PiToolExposureDomain,
    ) {
        this.#surface = surface;
        this.#domain = domain;
        this.#controlledTools = new Set(domain.expanded);
        this.#allowedTools = new Set(
            surface.getActiveToolNames().filter((name) => this.#controlledTools.has(name)),
        );
        this.#apply();
    }

    setExpanded(expanded: boolean): void {
        if (this.#expanded === expanded) return;
        this.#expanded = expanded;
        this.#apply();
    }

    #apply(): void {
        const otherTools = this.#surface
            .getActiveToolNames()
            .filter((name) => !this.#controlledTools.has(name));
        const selected = this.#expanded ? this.#domain.expanded : this.#domain.gateway;
        this.#surface.setActiveToolsByName([
            ...otherTools,
            ...selected.filter((name) => this.#allowedTools.has(name)),
        ]);
    }
}
