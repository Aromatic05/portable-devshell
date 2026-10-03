import { randomUUID } from "node:crypto";

import type {
    ExtensionManagedProcess,
    ExtensionProcessCapability,
} from "@portable-devshell/extension/process";

import type {
    ExtensionHostToSandboxMessage,
    ExtensionSandboxProcessDescriptor,
    SandboxProcessSendInput,
    SandboxProcessStartInput,
    SandboxProcessTerminateInput,
} from "./Protocol.js";

interface SandboxManagedProcess {
    process: ExtensionManagedProcess;
    removeMessageListener: () => void;
    removeStderrListener: () => void;
    removeStdoutListener: () => void;
}

export class ExtensionSandboxProcessBridge {
    readonly #acceptanceError: () => Error | undefined;
    readonly #capability: ExtensionProcessCapability;
    readonly #processes = new Map<string, SandboxManagedProcess>();
    readonly #send: (message: ExtensionHostToSandboxMessage) => void;

    constructor(options: {
        acceptanceError: () => Error | undefined;
        capability: ExtensionProcessCapability;
        send: (message: ExtensionHostToSandboxMessage) => void;
    }) {
        this.#acceptanceError = options.acceptanceError;
        this.#capability = options.capability;
        this.#send = options.send;
    }

    async start(
        input: SandboxProcessStartInput,
    ): Promise<ExtensionSandboxProcessDescriptor> {
        const started = await this.#capability.start(input);
        const acceptanceError = this.#acceptanceError();
        if (acceptanceError !== undefined) {
            await started.terminate();
            throw acceptanceError;
        }
        const processId = randomUUID();
        const registration: SandboxManagedProcess = {
            process: started,
            removeMessageListener: started.onMessage((message) => {
                this.#send({ message, processId, type: "processMessage" });
            }),
            removeStderrListener: started.onStderr((chunk) => {
                this.#send({ chunk, processId, type: "processStderr" });
            }),
            removeStdoutListener: started.onStdout((chunk) => {
                this.#send({ chunk, processId, type: "processStdout" });
            }),
        };
        this.#processes.set(processId, registration);
        void started.closed
            .then((exit) => {
                if (this.#processes.get(processId) !== registration) return;
                this.#processes.delete(processId);
                registration.removeMessageListener();
                registration.removeStderrListener();
                registration.removeStdoutListener();
                this.#send({ exit, processId, type: "processClosed" });
            })
            .catch(() => undefined);
        return { processId };
    }

    async send(input: SandboxProcessSendInput): Promise<void> {
        await this.#require(input.processId).send(input.message);
    }

    async terminate(input: SandboxProcessTerminateInput): Promise<void> {
        await this.#require(input.processId).terminate(input.signal);
    }

    releaseSubscriptions(): void {
        for (const registration of this.#processes.values()) {
            registration.removeMessageListener();
            registration.removeStderrListener();
            registration.removeStdoutListener();
        }
        this.#processes.clear();
    }

    #require(id: string): ExtensionManagedProcess {
        const process = this.#processes.get(id)?.process;
        if (process !== undefined) return process;
        throw new Error(
            `Extension sandbox managed process is unavailable: ${id}.`,
        );
    }
}
