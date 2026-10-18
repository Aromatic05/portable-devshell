import { toRemoteError } from "@portable-devshell/shared";

import {
    createTuiDomainSession,
    type TuiDomainSession,
} from "./Client.js";
import { TuiAppStore } from "../../state/store/App.js";
import { TuiDomainReader } from "./Reader.js";

export interface TuiControlSessionOptions {
    domains?: TuiDomainSession;
    store?: TuiAppStore;
}

/**
 * Owns the control connection lifecycle only: it binds domain change streams to
 * the connection store and drives start/stop/reconnect. Domain and page data
 * refresh lives on the domain ViewModels and their consumers.
 */
export class TuiControlSession {
    readonly domains: TuiDomainSession;
    readonly #store: TuiAppStore;
    readonly #offServer: () => void;
    #started = false;

    constructor(options: TuiControlSessionOptions = {}) {
        this.domains = options.domains ?? createTuiDomainSession();
        this.#store =
            options.store ??
            new TuiAppStore({
                domains: new TuiDomainReader(
                    this.domains,
                    () => () => undefined,
                ),
            });
        this.#offServer = this.domains.server.subscribe(() =>
            this.#syncConnection(),
        );
        this.#syncConnection();
    }

    get store(): TuiAppStore {
        return this.#store;
    }

    async start(): Promise<void> {
        if (this.#started) return;
        this.#started = true;
        this.#store.setConnectionState("connecting");
        try {
            await this.domains.load();
            this.#syncConnection();
        } catch (error) {
            this.#applyConnectionFailure(error);
        }
    }

    async stop(): Promise<void> {
        if (!this.#started) return;
        this.#started = false;
        this.#offServer();
        this.domains.close();
    }

    async reconnect(): Promise<void> {
        if (!this.#started) return;
        this.#store.setConnectionState("connecting");
        try {
            await this.domains.reconnect();
            this.#syncConnection();
        } catch (error) {
            this.#applyConnectionFailure(error);
            throw error;
        }
    }

    #syncConnection(): void {
        const server = this.domains.server.state;
        if (server.status === "online") {
            this.#store.setConnectionState("connected");
            return;
        }
        if (server.status === "connecting") {
            this.#store.setConnectionState("connecting");
            return;
        }
        if (server.failure !== undefined) {
            const error = toRemoteError(server.failure);
            this.#store.setConnectionState("error", {
                code: error.code,
                message: error.message,
            });
            return;
        }
        this.#store.setConnectionState("disconnected");
    }

    #applyConnectionFailure(error: unknown): void {
        const failure = toRemoteError(error);
        this.#store.setConnectionState("error", {
            code: failure.code,
            message: failure.message,
        });
        this.#store.setPanelError("control", failure);
    }
}
