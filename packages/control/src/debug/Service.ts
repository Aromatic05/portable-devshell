import type {
    Instance,
    InstanceRegistry,
    InstanceRuntime,
} from "@portable-devshell/core";
import type { DebugPatchLoadRequest, JsonValue } from "@portable-devshell/shared";
import { DebugPatchManager } from "./Patch.js";
import type { DebugRuntime } from "./Api.js";

type ToolCallDispatchRequest = Parameters<InstanceRuntime["callTool"]>[0];

export class DebugPatchService implements DebugRuntime {
    readonly #manager = new DebugPatchManager();
    readonly #registered = new Set<string>();

    constructor(
        private readonly instances: InstanceRegistry,
        private readonly target: (instance: Instance) => object,
    ) {}

    listTargets() {
        this.#sync();
        return this.#manager.listTargets();
    }

    listPatches() { return this.#manager.listPatches(); }

    async load(request: DebugPatchLoadRequest) {
        this.#sync();
        if (request.target.startsWith("worker:") && request.scope?.ctxId === undefined)
            throw new TypeError("Worker debug patches require a ctxId scope.");
        return await this.#manager.load(request);
    }

    release(patchId: string) { return this.#manager.release(patchId); }
    async unload(patchId: string) { return await this.#manager.unload(patchId); }

    async retireInstance(name: string): Promise<void> {
        await this.#manager.unregisterTarget(`worker:${name}`);
        this.#registered.delete(name);
    }

    async close(): Promise<void> { await this.#manager.dispose(); }

    #sync(): void {
        for (const instance of this.instances.list()) {
            if (this.#registered.has(instance.name)) continue;
            this.#manager.registerTarget(`worker:${instance.name}`, this.target(instance), {
                callTool: {
                    project: (args) => {
                        const request = args[0] as ToolCallDispatchRequest;
                        return JSON.parse(JSON.stringify({ input: request.value.payload, callContext: request.value.context, toolName: request.value.toolName })) as JsonValue;
                    },
                    scope: (args) => {
                        const request = args[0] as ToolCallDispatchRequest;
                        return request.value.context.ctxId === undefined ? undefined : { ctxId: request.value.context.ctxId, toolName: request.value.toolName };
                    },
                    signal: (args) => (args[0] as ToolCallDispatchRequest).signal,
                },
            });
            this.#registered.add(instance.name);
        }
    }
}
