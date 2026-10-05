import type { WorkerInstance } from "../instance/runtime/index.js";
import { WorkerTerminalBackend, type TerminalBackend } from "./Backend.js";

export interface TerminalRuntime {
    readonly api: TerminalBackend;
}

export function createTerminalRuntime(worker: WorkerInstance): TerminalRuntime {
    return {
        api: new WorkerTerminalBackend({ worker }),
    };
}
