import {
    defineExtensionPoint,
    type ExtensionJsonValue,
    type ExtensionPointDeclaration
} from "./ExtensionApi.js";

export interface CliCommandDeclaration extends ExtensionPointDeclaration {
    readonly id: string;
    readonly summary?: string;
    readonly title: string;
    readonly usage?: string;
}

export type CliCommandResult =
    | { kind: "json"; value: ExtensionJsonValue }
    | { kind: "text"; text: string };

export interface CliCommandInvocationContext {
    /** True only for a request authenticated as the local Control owner. */
    readonly localOwner: boolean;
    readonly requestId: string;
    readonly signal: AbortSignal;
    /** Local-owner CLI working directory on the Control host, when supplied. */
    readonly workingDirectory?: string;
}

export type CliCommandBinding = (
    argv: readonly string[],
    context: CliCommandInvocationContext
) => CliCommandResult | Promise<CliCommandResult>;

export const commands = defineExtensionPoint<CliCommandDeclaration, CliCommandBinding>("cli.commands");
