import type { WorkerInstance } from "../instance/Api.js";
import { WorkerTerminalBackend } from "./Backend.js";
import { TerminalSessionService } from "./Service.js";
import type {
    TerminalRuntime,
    TerminalSessionRuntime,
    TerminalSessionRuntimeOptions,
} from "./Api.js";

export function createTerminalRuntime(worker: WorkerInstance): TerminalRuntime {
    return {
        api: new WorkerTerminalBackend({ worker: worker.execution.terminal }),
        sessions: createTerminalSessionRuntime(),
    };
}

export function createTerminalSessionRuntime(
    options: TerminalSessionRuntimeOptions = {},
): TerminalSessionRuntime {
    const service = new TerminalSessionService(options);
    return { api: service, close: () => service.close() };
}
