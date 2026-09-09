import type {
    CliCommandDeclaration,
    CliCommandResult,
    CliModelCommandInvocationContext,
    CliNativeCommandInvocationContext
} from "@portable-devshell/extension/cli";

export interface CliExtensionCommandInputOptions {
    readonly raw?: boolean;
}

/** Control-owned bidirectional I/O available only to resident command providers. */
export interface CliExtensionCommandIo {
    readInput(): Promise<Buffer | undefined>;
    requestInput(options?: CliExtensionCommandInputOptions): Promise<void>;
    writeStderr(chunk: string): Promise<void>;
    writeStdout(chunk: string): Promise<void>;
}

export interface CliNativeExtensionCommandInvocationContext extends CliNativeCommandInvocationContext {
    readonly io?: CliExtensionCommandIo;
    readonly surface: "native";
}

export interface CliModelExtensionCommandInvocationContext extends CliModelCommandInvocationContext {
    readonly io?: CliExtensionCommandIo;
    readonly surface: "model";
}

export type CliExtensionCommandInvocationContext =
    | CliNativeExtensionCommandInvocationContext
    | CliModelExtensionCommandInvocationContext;

export type CliExtensionCommandBinding = (
    argv: readonly string[],
    context: CliExtensionCommandInvocationContext
) => CliCommandResult | Promise<CliCommandResult>;

/** Control-resident implementation participating in exactly one Extension command state. */
export interface CliExtensionCommandProvider {
    readonly binding: CliExtensionCommandBinding;
    readonly declaration: CliCommandDeclaration;
    readonly extensionId: string;
    readonly surface: "model" | "native";
}
