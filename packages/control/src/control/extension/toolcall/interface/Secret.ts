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
                        if (requestInput !== undefined) {
                            throw new TypeError(
                                `${secretRewriteInterfaceOperation} does not accept Extension-provided input.`,
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
                        return environment;
                    },
                }),
        });
    }

    #environment(instanceName: string): ExtensionJsonValue {
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
