import { WorkerTerminalBackend } from "./Backend.js";
import { TerminalSessionService } from "./Service.js";
import type {
    TerminalRuntime,
    TerminalSessionRuntime,
    TerminalSessionRuntimeOptions,
    WorkerTerminalPort,
} from "./Api.js";

export function createTerminalRuntime(
    worker: WorkerTerminalPort,
    options: TerminalSessionRuntimeOptions = {},
): TerminalRuntime {
    return {
        api: new WorkerTerminalBackend({ worker }),
        sessions: createTerminalSessionRuntime(options),
    };
}

export function createTerminalSessionRuntime(
    options: TerminalSessionRuntimeOptions = {},
): TerminalSessionRuntime {
    const service = new TerminalSessionService(options);
    return { api: service, close: () => service.close() };
}
