import { randomUUID } from "node:crypto";
import type {
    ExtensionWorkerProcess, ExtensionWorkerProcessCapability, ExtensionWorkerProcessStartInput,
} from "@portable-devshell/extension/worker";

/** Sandbox-local handles; the capability owns the physical process lifetime. */
export class ExtensionSandboxWorkerProcessBridge {
    readonly #processes = new Map<string, ExtensionWorkerProcess>();
    constructor(private readonly capability: ExtensionWorkerProcessCapability) {}

    async start(input: ExtensionWorkerProcessStartInput, signal: AbortSignal): Promise<string> {
        const process = await this.capability.start(input, signal);
        const id = randomUUID();
        this.#processes.set(id, process);
        return id;
    }
    async read(id: string): Promise<string | undefined> {
        const process = this.#require(id);
        try {
            const bytes = await process.read();
            if (bytes !== undefined) return Buffer.from(bytes).toString("base64");
            await this.close(id);
            return undefined;
        } catch (error) {
            await this.close(id).catch(() => undefined);
            throw error;
        }
    }
    write(id: string, data: string): Promise<void> {
        return this.#require(id).write(Buffer.from(data, "base64"));
    }
    finish(id: string): Promise<void> {
        return this.#require(id).finish();
    }
    async close(id: string): Promise<void> {
        const process = this.#processes.get(id);
        if (process === undefined) return;
        this.#processes.delete(id);
        await process.close();
    }
    #require(id: string): ExtensionWorkerProcess {
        const process = this.#processes.get(id);
        if (process === undefined) throw new Error("Worker process handle is unavailable.");
        return process;
    }
}
