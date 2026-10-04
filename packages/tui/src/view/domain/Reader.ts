import type { TuiDomainSession } from "../../app/control/Client.js";
import type { TuiRenderSource } from "../../app/Render.js";

/**
 * Read-time bridge from TUI presentation/commands to domain ViewModels.
 *
 * It owns no remote state and exposes no aggregate snapshot. Every accessor
 * returns the current state owned by the underlying domain ViewModel. The only
 * lifecycle it owns is render-source attachment so domain changes schedule a
 * repaint without copying those snapshots into TuiAppState.
 */
export class TuiDomainReader {
    readonly domains: TuiDomainSession;
    readonly #attach: (source: TuiRenderSource) => () => void;
    readonly #attached = new WeakSet<object>();
    readonly #detach = new Set<() => void>();

    constructor(
        domains: TuiDomainSession,
        attach: (source: TuiRenderSource) => () => void,
    ) {
        this.domains = domains;
        this.#attach = attach;
        this.#attachSource(domains.server);
        this.#attachSource(domains.config);
        this.#attachSource(domains.overview);
        this.#attachSource(domains.mcp);
        this.#attachSource(domains.extension);
        this.#attachSource(domains.instances);
        this.#attachSource(domains.artifact);
        this.#attachSource(domains.context);
        this.#attachSource(domains.messageHistory);
        this.#attachSource(domains.messagePreferences);
        this.#attachSource(domains.messages);
        this.#attachSource(domains.goals);
        this.#attachSource(domains.toolCalls);
    }

    get server() {
        return this.domains.server.state;
    }

    get config() {
        return this.domains.config.state;
    }

    get overview() {
        return this.domains.overview.state;
    }

    get mcp() {
        return this.domains.mcp.state;
    }

    get extension() {
        return this.domains.extension.state;
    }

    get instances() {
        return this.domains.instances.state;
    }

    get artifact() {
        return this.domains.artifact.state;
    }

    get context() {
        return this.domains.context.state;
    }

    get messageHistory() {
        return this.domains.messageHistory.state;
    }

    get messagePreferences() {
        return this.domains.messagePreferences.state;
    }

    get messages() {
        return this.domains.messages.state;
    }

    get goals() {
        return this.domains.goals.state;
    }

    get toolCalls() {
        return this.domains.toolCalls.state;
    }

    runtime(instance: string) {
        const viewModel = this.domains.runtime(instance);
        this.#attachSource(viewModel);
        return viewModel.state;
    }

    approval(instance: string) {
        const viewModel = this.domains.approval(instance);
        this.#attachSource(viewModel);
        return viewModel.state;
    }

    todo(instance: string) {
        const viewModel = this.domains.todo(instance);
        this.#attachSource(viewModel);
        return viewModel.state;
    }

    dispose(): void {
        for (const detach of this.#detach) detach();
        this.#detach.clear();
    }

    #attachSource(source: TuiRenderSource): void {
        if (this.#attached.has(source as object)) return;
        this.#attached.add(source as object);
        this.#detach.add(this.#attach(source));
    }
}
