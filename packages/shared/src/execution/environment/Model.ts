export interface WorkerWorkspacePrepareResult {
    projectMemoryAgentFile: string;
    projectMemoryDirectory: string;
    projectMemoryPresent?: boolean;
    temporaryDirectory: string;
    workspace: string;
}

export interface WorkerExtensionResourcePrepareInput {
    collection: string;
    extensionId: string;
}

export interface WorkerExtensionResourcePrepareResult {
    directory: string;
}

export interface WorkerAlertAdvice {
    code: string;
    text: string;
}

export interface WorkerAlertsReadResult {
    advice: WorkerAlertAdvice[];
}
