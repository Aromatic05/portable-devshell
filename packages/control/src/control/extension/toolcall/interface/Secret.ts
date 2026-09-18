import type { ExtensionJsonValue } from "@portable-devshell/extension";
import { secretRewriteInterfaceOperation } from "@portable-devshell/extension/secret";
import type {
    ToolCallRewriteContext,
    ToolCallRewriteInvocation,
} from "@portable-devshell/extension/toolcall";
import {
    createError,
    errorCodes,
    type ControlConfig,
} from "@portable-devshell/shared";

export interface ToolCallSecretRewriteScope {
    context(input: ToolCallRewriteInvocation): ToolCallRewriteContext;
}

export class ToolCallSecretRewrite {
    readonly #config?: () => ControlConfig;

    constructor(config?: () => ControlConfig) {
        this.#config = config;
    }

    scope(
        extensionId: string | undefined,
        instanceName: string,
    ): ToolCallSecretRewriteScope {
        const environment =
            extensionId === "secret" && this.#config !== undefined
                ? this.#environment(instanceName)
                : undefined;
        const used = new Set<string>();
        return Object.freeze({
            context: (input: ToolCallRewriteInvocation): ToolCallRewriteContext =>
                Object.freeze({
                    requestInterface: async (
                        operation: string,
                        requestInput?: ExtensionJsonValue,
                    ): Promise<ExtensionJsonValue | undefined> => {
                        if (
                            extensionId !== "secret" ||
                            operation !== secretRewriteInterfaceOperation
                        ) {
                            throw new TypeError(
                                `Unsupported ToolCall rewrite interface operation for Extension ${extensionId ?? "unknown"}: ${operation}.`,
                            );
                        }
                        if (input.context.instance !== instanceName) {
                            throw new TypeError(
                                "ToolCall Secret rewrite invocation instance changed within one Boundary lease.",
                            );
                        }
                        if (environment === undefined) {
                            throw new Error(
                                "ToolCall Secret rewrite interface is unavailable.",
                            );
                        }
                        if (input.direction === "inbound") {
                            const names = readRequestedNames(requestInput);
                            const selected: Record<string, string> = {};
                            for (const name of names) {
                                if (!input.text.includes(`\${SECRET:${name}}`)) {
                                    throw new TypeError(
                                        `Secret ${name} is not present in the current ToolCall text.`,
                                    );
                                }
                                const value = environment[name];
                                if (value === undefined) continue;
                                selected[name] = value;
                                used.add(name);
                            }
                            return Object.freeze(selected);
                        }
                        if (requestInput !== undefined) {
                            throw new TypeError(
                                "outbound Secret rewrite does not accept input.",
                            );
                        }
                        return Object.freeze(
                            Object.fromEntries(
                                [...used]
                                    .filter(
                                        (name) => environment[name] !== undefined,
                                    )
                                    .map((name) => [name, environment[name]!]),
                            ),
                        );
                    },
                }),
        });
    }

    #environment(instanceName: string): Readonly<Record<string, string>> {
        const config = this.#config?.();
        if (config === undefined)
            throw new Error("ToolCall Secret rewrite interface is unavailable.");
        const instance = config.instances.find(
            (candidate) => candidate.name === instanceName,
        );
        if (instance === undefined) {
            throw createError({
                code: errorCodes.instanceMissing,
                details: { instance: instanceName },
                message: `Instance ${instanceName} was not found or is disabled.`,
                retryable: false,
            });
        }
        return Object.freeze({ ...(instance.env ?? {}) });
    }
}

function readRequestedNames(input: ExtensionJsonValue | undefined): readonly string[] {
    if (
        typeof input !== "object" ||
        input === null ||
        Array.isArray(input) ||
        !Array.isArray(input.names)
    ) {
        throw new TypeError(
            `${secretRewriteInterfaceOperation} inbound request requires referenced secret names.`,
        );
    }
    const names: string[] = [];
    for (const value of input.names) {
        if (typeof value !== "string" || value.length === 0) {
            throw new TypeError(
                `${secretRewriteInterfaceOperation} names must be non-empty strings.`,
            );
        }
        if (!names.includes(value)) names.push(value);
    }
    return names;
}
