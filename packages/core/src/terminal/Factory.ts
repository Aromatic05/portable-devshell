import type { WorkerInstance } from "../worker/instance/Instance.js";
import { WorkerTerminalBackend, type TerminalBackend } from "./Backend.js";

export function createInstanceTerminalBackend(
    worker: WorkerInstance,
): TerminalBackend {
    return new WorkerTerminalBackend({ worker });
}
