import { randomUUID } from "node:crypto";

import type {
    ExtensionWorkerCapability,
    ExtensionWorkerSession,
} from "@portable-devshell/extension/worker";

import type {
    ExtensionHostToSandboxMessage,
    ExtensionSandboxWorkerSessionDescriptor,
    SandboxWorkerCallInput,
    SandboxWorkerOpenInput,
} from "./Protocol.js";

export class ExtensionSandboxWorkerSessions {
    readonly #acceptanceError: () => Error | undefined;
    #cleanup?: Promise<void>;
    readonly #delegate: ExtensionWorkerCapability;
    readonly #execute: ExtensionWorkerCapability;
    readonly #send: (message: ExtensionHostToSandboxMessage) => void;
    readonly #sessions = new Map<string, ExtensionWorkerSession>();

    get closing(): boolean {
        return this.#cleanup !== undefined;
    }

    constructor(options: {
        acceptanceError: () => Error | undefined;
        delegate: ExtensionWorkerCapability;
        execute: ExtensionWorkerCapability;
        send: (message: ExtensionHostToSandboxMessage) => void;
    }) {
        this.#acceptanceError = options.acceptanceError;
        this.#delegate = options.delegate;
        this.#execute = options.execute;
        this.#send = options.send;
    }

    async open(
        kind: "delegate" | "execute",
        input: SandboxWorkerOpenInput,
    ): Promise<ExtensionSandboxWorkerSessionDescriptor> {
        const capability = kind === "delegate" ? this.#delegate : this.#execute;
        const opened = await capability.openSession(input);
        const acceptanceError =
            this.#acceptanceError() ??
            (this.#cleanup === undefined
                ? undefined
                : new Error(
                      "Extension sandbox stopped accepting Worker sessions.",
                  ));
        if (acceptanceError !== undefined) {
            await opened.close();
            throw acceptanceError;
        }
        const sessionId = randomUUID();
        this.#sessions.set(sessionId, opened);
        void opened.closed
            .then(() => {
                this.#sessions.delete(sessionId);
                this.#send({ sessionId, type: "workerSessionClosed" });
            })
            .catch(() => undefined);
        return {
            environment: opened.environment,
            instance: opened.instance,
            sessionId,
            tools: opened.listTools(),
            workspace: opened.workspace,
        };
    }

    async callTool(
        requestId: string,
        input: SandboxWorkerCallInput,
        signal: AbortSignal,
    ): Promise<unknown> {
        return await this.#require(input.sessionId).callTool(
            input.toolName,
            input.input,
            {
                ...(input.operationId === undefined
                    ? {}
                    : { operationId: input.operationId }),
                onProgress: (progress) =>
                    this.#send({
                        id: requestId,
                        type: "capabilityProgress",
                        value: progress,
                    }),
                signal,
            },
        );
    }

    async close(sessionId: string): Promise<void> {
        const session = this.#sessions.get(sessionId);
        if (session === undefined) return;
        this.#sessions.delete(sessionId);
        await session.close();
    }

    async closeAll(): Promise<void> {
        this.#cleanup ??= this.#closeAllOnce();
        await this.#cleanup;
    }

    async #closeAllOnce(): Promise<void> {
        const sessions = [...this.#sessions.values()];
        this.#sessions.clear();
        const settled = await Promise.allSettled(
            sessions.map(async (session) => await session.close()),
        );
        const failures = settled.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(
                failures,
                "Extension sandbox Worker sessions failed to close.",
            );
        }
    }

    #require(id: string): ExtensionWorkerSession {
        const session = this.#sessions.get(id);
        if (session !== undefined) return session;
        throw new Error(
            `Extension sandbox Worker session is unavailable: ${id}.`,
        );
    }
}
