import type {
    CliCommandDeclaration,
    CliCommandInvocationContext,
    CliCommandResult
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

export interface CliExtensionCommandInvocationContext extends CliCommandInvocationContext {
    readonly io?: CliExtensionCommandIo;
}

export type CliExtensionCommandBinding = (
    argv: readonly string[],
    context: CliExtensionCommandInvocationContext
) => CliCommandResult | Promise<CliCommandResult>;

/**
 * Control-resident provider for a built-in Extension command surface.
 *
 * It participates in the same cli.commands namespace and carries an Extension
 * identity, while the binding may call Control-owned domain APIs directly.
 */
export interface CliExtensionCommandProvider {
    readonly binding: CliExtensionCommandBinding;
    readonly declaration: CliCommandDeclaration;
    readonly extensionId: string;
}
