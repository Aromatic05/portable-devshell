import { randomUUID } from "node:crypto";

export class McpEndpointSession {
    readonly #id = randomUUID();
    #initialized = false;

    initialize(): void {
        this.#initialized = true;
    }

    get id(): string {
        return this.#id;
    }

    get initialized(): boolean {
        return this.#initialized;
    }
}
