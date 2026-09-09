import {
    defineExtensionPoint,
    type ExtensionJsonValue,
    type ExtensionPointDeclaration
} from "../ExtensionApi.js";

export interface CliCommandDeclaration extends ExtensionPointDeclaration {
    readonly id: string;
    readonly summary?: string;
    readonly title: string;
    readonly usage?: string;
}

export type CliCommandResult =
    | { kind: "json"; value: ExtensionJsonValue }
    | { kind: "text"; text: string };

export interface CliCommandInputOptions {
    readonly raw?: boolean;
}

/** Bidirectional I/O owned by one CLI command invocation. */
export interface CliCommandIo {
    readInput(): Promise<Uint8Array | undefined>;
    requestInput(options?: CliCommandInputOptions): Promise<void>;
    writeStderr(chunk: string): Promise<void>;
    writeStdout(chunk: string): Promise<void>;
}

/** Invocation state for a human/native CLI command. */
export interface CliNativeCommandInvocationContext {
    readonly io?: CliCommandIo;
    /** True only for a request authenticated as the local Control owner. */
    readonly localOwner: boolean;
    readonly requestId: string;
    readonly signal: AbortSignal;
    /** Native CLI working directory on the Control host, when supplied. */
    readonly workingDirectory?: string;
}

/** Invocation state for a model-facing command. Builtin CLI authority is intentionally absent. */
export interface CliModelCommandInvocationContext {
    /** Authoritative managed instance resolved by the model command broker. */
    readonly instance: string;
    readonly io?: CliCommandIo;
    readonly requestId: string;
    readonly signal: AbortSignal;
    /** Authoritative Workspace bound to the originating MCP Context. */
    readonly workspace: string;
}

export type CliNativeCommandBinding = (
    argv: readonly string[],
    context: CliNativeCommandInvocationContext
) => CliCommandResult | Promise<CliCommandResult>;

export type CliModelCommandBinding = (
    argv: readonly string[],
    context: CliModelCommandInvocationContext
) => CliCommandResult | Promise<CliCommandResult>;

/** Commands that may overlay the native builtin CLI command tree. */
export const nativeCommands = defineExtensionPoint<CliCommandDeclaration, CliNativeCommandBinding>(
    "cli.native-commands"
);

/** Commands visible to the restricted model-facing devshell command state. */
export const modelCommands = defineExtensionPoint<CliCommandDeclaration, CliModelCommandBinding>(
    "cli.model-commands"
);
