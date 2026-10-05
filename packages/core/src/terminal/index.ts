import type { WorkerInstance } from "../instance/runtime/index.js";
import { WorkerTerminalBackend, type TerminalBackend } from "./Backend.js";

export function createInstanceTerminalBackend(
    worker: WorkerInstance,
): TerminalBackend {
    return new WorkerTerminalBackend({ worker });
}
