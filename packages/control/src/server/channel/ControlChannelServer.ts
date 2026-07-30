import {
    Codec,
    PrefixRoute,
    type FrameChannel,
    type PrefixRouteSnapshot
} from "@portable-devshell/shared";

export interface ControlChannelRouteProvider {
    connectionClosed(connectionId: string): void;
    snapshot(): PrefixRouteSnapshot;
}

export interface ControlChannelProvider {
    start(accept: (channel: FrameChannel) => void): Promise<void>;
    close(): Promise<void>;
}

export interface ControlChannelServerOptions {
    providers: readonly ControlChannelProvider[];
    routes: ControlChannelRouteProvider;
}

export class ControlChannelServer {
    readonly #providers: readonly ControlChannelProvider[];
    readonly #routes: ControlChannelRouteProvider;
    readonly #connections = new Map<string, PrefixRoute>();
    readonly #startedProviders: ControlChannelProvider[] = [];
    #closePromise?: Promise<void>;
    #startPromise?: Promise<void>;
    #started = false;
    #stopping = false;

    constructor(options: ControlChannelServerOptions) {
        if (options.providers.length === 0) {
            throw new Error("Control channel server requires at least one provider.");
        }
        this.#providers = [...options.providers];
        this.#routes = options.routes;
    }

    async start(): Promise<void> {
        if (this.#startPromise !== undefined) {
            return await this.#startPromise;
        }
        if (this.#closePromise !== undefined) {
            await this.#closePromise;
        }
        if (this.#started) {
            return;
        }
        if (this.#startedProviders.length > 0) {
            await this.#closeProviders();
        }
        if (this.#startPromise !== undefined) {
            return await this.#startPromise;
        }
        const start = this.#startInternal();
        this.#startPromise = start;
        try {
            await start;
        } finally {
            if (this.#startPromise === start) {
                this.#startPromise = undefined;
            }
        }
    }

    async close(): Promise<void> {
        this.#stopping = true;
        if (this.#closePromise !== undefined) {
            return await this.#closePromise;
        }
        const close = this.#closeAfterStart();
        this.#closePromise = close;
        try {
            await close;
        } finally {
            if (this.#closePromise === close) {
                this.#closePromise = undefined;
            }
        }
    }

    async #startInternal(): Promise<void> {
        this.#stopping = false;
        try {
            for (const provider of this.#providers) {
                await provider.start((channel) => this.#accept(channel));
                this.#startedProviders.push(provider);
            }
            this.#started = true;
        } catch (error) {
            this.#stopping = true;
            this.#closeConnections();
            try {
                await this.#closeProviders();
            } catch (closeError) {
                throw new AggregateError(
                    [error, closeError],
                    "Control channel server failed to start and clean up."
                );
            }
            throw error;
        }
    }

    async #closeAfterStart(): Promise<void> {
        await this.#startPromise?.catch(() => undefined);
        await this.#closeInternal();
    }

    #accept(channel: FrameChannel): void {
        if (this.#stopping) {
            channel.close(new Error("Control channel server is stopping."));
            return;
        }
        try {
            const route = new PrefixRoute(new Codec(channel, { local: "server" }), {
                eventIdPrefix: "server",
                getSnapshot: () => this.#routes.snapshot()
            });
            this.#connections.set(route.connectionId, route);
            channel.onClose(() => {
                this.#connections.delete(route.connectionId);
                this.#routes.connectionClosed(route.connectionId);
            });
        } catch (error) {
            channel.close(error instanceof Error ? error : new Error(String(error)));
        }
    }

    async #closeInternal(): Promise<void> {
        this.#stopping = true;
        this.#closeConnections();
        try {
            await this.#closeProviders();
        } finally {
            this.#started = false;
        }
    }

    #closeConnections(): void {
        for (const route of this.#connections.values()) {
            route.close();
        }
        this.#connections.clear();
    }

    async #closeProviders(): Promise<void> {
        const failures: unknown[] = [];
        const providers = this.#startedProviders.splice(0);
        const failed = new Set<ControlChannelProvider>();
        for (const provider of [...providers].reverse()) {
            await provider.close().catch((error) => {
                failed.add(provider);
                failures.push(error);
            });
        }
        for (const provider of providers) {
            if (failed.has(provider)) {
                this.#startedProviders.push(provider);
            }
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, "Control channel providers failed to close.");
        }
    }
}
