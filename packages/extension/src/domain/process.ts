import type { ExtensionJsonValue } from "../ExtensionCore.js";

export interface ExtensionProcessExit {
    readonly code?: number;
    readonly signal?: string;
}

/** Input for a Control-owned process. The process remains generation-owned. */
export interface ExtensionProcessStartInput {
    readonly args?: readonly string[];
    readonly command: string;
    readonly cwd?: string;
    readonly environment?: Readonly<Record<string, string>>;
    /** Request a structured JSON message channel in addition to process lifetime management. */
    readonly messages?: boolean;
}

export interface ExtensionManagedProcess {
    readonly closed: Promise<ExtensionProcessExit>;
    onMessage(listener: (message: ExtensionJsonValue) => void): () => void;
    onStderr(listener: (chunk: string) => void): () => void;
    onStdout(listener: (chunk: string) => void): () => void;
    send(message: ExtensionJsonValue): Promise<void>;
    terminate(signal?: string): Promise<void>;
}

export interface ExtensionProcessCapability {
    start(input: ExtensionProcessStartInput): Promise<ExtensionManagedProcess>;
}
