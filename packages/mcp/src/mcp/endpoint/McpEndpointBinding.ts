import { McpEndpointSession } from "./McpEndpointSession.js";
import { McpEndpointWorker } from "./McpEndpointWorker.js";

export class McpEndpointBinding {
    readonly #sessions = new Map<string, McpEndpointSession>();
    readonly #worker: McpEndpointWorker;

    constructor(worker: McpEndpointWorker) {
        this.#worker = worker;
    }

    get instanceName(): string {
        return this.#worker.instanceName;
    }

    createSession(): McpEndpointSession {
        const session = new McpEndpointSession();
        this.#sessions.set(session.id, session);
        return session;
    }

    getSession(sessionId: string | undefined): McpEndpointSession | undefined {
        if (sessionId === undefined) {
            return undefined;
        }

        return this.#sessions.get(sessionId);
    }

    get worker(): McpEndpointWorker {
        return this.#worker;
    }
}
