import type {
    CliCommandBinding,
    CliCommandDeclaration
} from "@portable-devshell/extension/cli";

/**
 * Control-resident provider for a built-in Extension command surface.
 *
 * It participates in the same cli.commands namespace and carries an Extension
 * identity, while the binding may call Control-owned domain APIs directly.
 */
export interface CliExtensionCommandProvider {
    readonly binding: CliCommandBinding;
    readonly declaration: CliCommandDeclaration;
    readonly extensionId: string;
}
