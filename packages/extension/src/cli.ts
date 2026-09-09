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

export function parseCliCommandDeclaration(value: ExtensionPointDeclaration): CliCommandDeclaration {
    const record = value as ExtensionPointDeclaration & Record<string, ExtensionJsonValue | undefined>;
    assertOnlyKeys(record, ["id", "summary", "title", "usage"]);
    return Object.freeze({
        id: value.id,
        ...(record.summary === undefined ? {} : { summary: readString(record.summary, "summary") }),
        title: readString(record.title, "title"),
        ...(record.usage === undefined ? {} : { usage: readString(record.usage, "usage") })
    });
}

function assertOnlyKeys(value: ExtensionPointDeclaration, allowed: readonly string[]): void {
    const allowedSet = new Set(allowed);
    const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
    if (unknown !== undefined) throw new TypeError(`cli.commands declaration has unknown field ${unknown}.`);
}

function readString(value: ExtensionJsonValue | undefined, field: string): string {
    if (typeof value === "string" && value.length > 0 && value.trim() === value) return value;
    throw new TypeError(`cli.commands declaration ${field} must be a non-empty trimmed string.`);
}
