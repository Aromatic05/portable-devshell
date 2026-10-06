import type { DebugPatchLoadRequest } from "@portable-devshell/shared";
import { DebugPatchManager } from "./Patch.js";
import type { DebugRuntime } from "./Api.js";

export class DebugPatchService implements DebugRuntime {
    readonly #manager = new DebugPatchManager();

    listTargets() {
        return this.#manager.listTargets();
    }

    listPatches() {
        return this.#manager.listPatches();
    }

    async load(request: DebugPatchLoadRequest) {
        return await this.#manager.load(request);
    }

    release(patchId: string) {
        return this.#manager.release(patchId);
    }

    async unload(patchId: string) {
        return await this.#manager.unload(patchId);
    }

    async close(): Promise<void> {
        await this.#manager.dispose();
    }
}
