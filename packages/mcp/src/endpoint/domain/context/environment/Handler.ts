import {
    controlErrorCodes,
    createRemoteError,
    contextErrorCodes,
    runtimeErrorCodes,
    type JsonValue,
    type McpContextRecord,
    type ToolCallContext,
} from "@portable-devshell/shared";

import type { ContextRegistryPort } from "@portable-devshell/shared";
import type { ContextEnvironmentPort, ContextCleanupPort } from "../../../../context/Port.js";
import type { McpContextExternalBinding } from "@portable-devshell/shared";
import type { McpContextSelector } from "../../../../context/Selector.js";
import type {
    McpInstancePort,
    McpToolCallPort,
} from "../../../../instance/Gateway.js";
import {
    mcpEnvironmentToolName,
    mcpRemoteEnvironmentToolName,
} from "./Catalog.js";
import {
    readMcpEnvironmentInfoInput,
    readMcpRemoteEnvironmentInput,
} from "./Input.js";
import type {
    McpEndpointCallContext,
    McpEndpointWorkerPort,
} from "../../../call/Port.js";
import {
    mcpEndpointToolNotExposed,
    requireMcpEndpointEnvironment,
} from "../../../call/Boundary.js";

interface BoundContextLookup {
    bindings: McpContextExternalBinding[];
    record?: McpContextRecord;
}

type McpEnvironmentGateway = McpToolCallPort &
    Pick<McpInstancePort, "modelCommands">;

export interface McpEnvironmentHandlerResult {
    ctxId: string;
    structuredContent: JsonValue;
}

export class McpEndpointHandlerEnvironment {
    readonly #cleanup: ContextCleanupPort;
    readonly #contextRegistry: ContextRegistryPort;
    readonly #contextSelector: McpContextSelector;
    readonly #gateway?: McpEnvironmentGateway;
    readonly #instanceName: string;
    readonly #environment: ContextEnvironmentPort;
    readonly #worker: McpEndpointWorkerPort;

    constructor(options: {
        cleanup: ContextCleanupPort;
        contextRegistry: ContextRegistryPort;
        environment: ContextEnvironmentPort;
        contextSelector: McpContextSelector;
        gateway?: McpEnvironmentGateway;
        instanceName: string;
        worker: McpEndpointWorkerPort;
    }) {
        this.#contextRegistry = options.contextRegistry;
        this.#contextSelector = options.contextSelector;
        this.#gateway = options.gateway;
        this.#instanceName = options.instanceName;
        this.#cleanup = options.cleanup;
        this.#environment = options.environment;
        this.#worker = options.worker;
    }

    async call(
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        exposed: boolean,
        signal?: AbortSignal,
    ): Promise<McpEnvironmentHandlerResult> {
        if (!exposed) {
            throw mcpEndpointToolNotExposed(toolName, this.#instanceName);
        }
        switch (toolName) {
            case mcpEnvironmentToolName:
                return await this.#environmentInfo(
                    input,
                    requestContext,
                    signal,
                );
            case mcpRemoteEnvironmentToolName:
                return await this.#remoteEnvironmentCommand(
                    input,
                    requestContext,
                    signal,
                );
            default:
                throw mcpEndpointToolNotExposed(toolName, this.#instanceName);
        }
    }



    async #resolveEnvironmentContext(
        input: { ctxId?: string; workspace?: string },
        requestContext: McpEndpointCallContext,
        options: { touch?: boolean } = {},
    ): Promise<{
        bindings: McpContextExternalBinding[];
        created: boolean;
        record: McpContextRecord;
    }> {
        if (input.ctxId !== undefined) {
            if (!this.#contextSelector.requiresExplicitContextId) {
                throw createRemoteError({
                    code: contextErrorCodes.invalid,
                    message:
                        "ctxId is internal when Context authority is externally bound.",
                    retryable: false,
                });
            }
            const record = await this.#contextRegistry.lookup(input.ctxId, {
                principal: requestContext.principal,
            });
            if (record.status === "disabled") {
                await this.#contextRegistry.validate(record.ctxId, {
                    principal: requestContext.principal,
                });
            }
            return {
                bindings: [],
                created: false,
                record:
                    options.touch === false
                        ? record
                        : record.status === "expired"
                          ? await this.#contextRegistry.renewForPrincipal(
                                record.ctxId,
                                {
                                    principal: requestContext.principal,
                                },
                            )
                          : await this.#contextRegistry.validateAndTouch(
                                record.ctxId,
                                {
                                    principal: requestContext.principal,
                                },
                            ),
            };
        }

        const bound = await this.#lookupBoundContext(requestContext);
        if (bound.record?.status === "active") {
            return {
                bindings: bound.bindings,
                created: false,
                record:
                    options.touch === false
                        ? bound.record
                        : await this.#contextRegistry.validateAndTouch(
                              bound.record.ctxId,
                              {
                                  principal: requestContext.principal,
                              },
                          ),
            };
        }
        if (bound.record?.status === "expired") {
            return {
                bindings: bound.bindings,
                created: false,
                record:
                    options.touch === false
                        ? bound.record
                        : await this.#contextRegistry.renewForPrincipal(
                              bound.record.ctxId,
                              {
                                  principal: requestContext.principal,
                              },
                          ),
            };
        }

        const workspace =
            input.workspace ??
            (bound.record === undefined
                ? undefined
                : contextWorkspace(bound.record, this.#instanceName));
        if (workspace === undefined)
            throw unboundContext(
                this.#contextSelector.requiresExplicitContextId,
            );

        return {
            bindings: bound.bindings,
            created: true,
            record: await this.#contextRegistry.create({
                principal: requestContext.principal,
                environments: [{ instance: this.#instanceName }],
            }),
        };
    }

    async #touchEnvironmentContext(
        record: McpContextRecord,
        requestContext: McpEndpointCallContext,
    ): Promise<McpContextRecord> {
        return record.status === "expired"
            ? await this.#contextRegistry.renewForPrincipal(record.ctxId, {
                  principal: requestContext.principal,
              })
            : await this.#contextRegistry.validateAndTouch(record.ctxId, {
                  principal: requestContext.principal,
              });
    }

    async #lookupBoundContext(
        requestContext: McpEndpointCallContext,
    ): Promise<BoundContextLookup> {
        const bindings = this.#contextSelector.bindings(requestContext);
        let record: McpContextRecord | undefined;
        for (const binding of bindings) {
            const candidate = await this.#contextRegistry.lookupExternal(
                binding,
                {
                    principal: requestContext.principal,
                },
            );
            if (candidate === undefined) continue;
            if (record !== undefined && record.ctxId !== candidate.ctxId) {
                throw conflictingExternalBindings();
            }
            record = candidate;
        }
        return { bindings, record };
    }

    async #prepareEnvironment(
        ctxId: string,
        workspace: string,
        external: { bindings: readonly McpContextExternalBinding[]; principal: string } | undefined,
        signal: AbortSignal | undefined,
        onAlertsAcquiring?: (workspace: string) => void,
    ) {
        const environment = requireMcpEndpointEnvironment(
            this.#worker,
            this.#instanceName,
        );
        const prepareExtensionResource = this.#worker.prepareExtensionResource;
        if (prepareExtensionResource === undefined) {
            throw extensionResourcePreparationUnavailable(this.#instanceName);
        }
        let skillsDirectory = "";
        let alerts: Array<{ code: string; text: string }> = [];
        const prepared = await this.#environment.prepareLocal(
            ctxId,
            this.#instanceName,
            workspace,
            {
                external,
                beforeCommit: async (facts) => {
                    const skills = await prepareExtensionResource.call(this.#worker, {
                        collection: "managed",
                        extensionId: "skill",
                    });
                    skillsDirectory = skills.directory;
                    onAlertsAcquiring?.(facts.workspace);
                    alerts = (await this.#worker.readAlerts(facts.workspace)).advice;
                },
                signal,
            },
        );
        return {
            alerts,
            environment,
            prepared,
            skillsDirectory,
        };
    }

}

function contextWorkspace(
    record: McpContextRecord,
    instance: string,
): string | undefined {
    return record.environments.find(
        (environment) => environment.instance === instance,
    )?.workspace;
}

function contextWorkspaceRequired(ctxId: string, instance: string) {
    return createRemoteError({
        code: contextErrorCodes.workspaceRequired,
        details: { ctxId, instance },
        message: `No workspace is attached to ${instance} for ${ctxId}. Use environ_remote command='attach' with its handle and an absolute workspace.`,
        retryable: false,
    });
}

function conflictingExternalBindings() {
    return createRemoteError({
        code: contextErrorCodes.invalid,
        message:
            "Stable external identities on this request resolve to different Contexts.",
        retryable: false,
    });
}

function unboundContext(requireExplicitContextId: boolean) {
    return createRemoteError({
        code: contextErrorCodes.invalid,
        message: requireExplicitContextId
            ? "No Context is bound to this request. Call environ_info with workspace or provide ctxId."
            : "No Context is bound to this request. Call environ_info with workspace.",
        retryable: false,
    });
}

function extensionResourcePreparationUnavailable(instance: string) {
    return createRemoteError({
        code: runtimeErrorCodes.workerHandshakeFailed,
        details: { instance },
        message: `Extension resource preparation is unavailable for ${instance}.`,
        retryable: true,
    });
}

function modelDevshellComments(commands: readonly string[]): string[] {
    if (commands.length === 0) return [];
    return [
        `Model devshell commands available through bash_run/tmux_run: ${commands.join(", ")}.`,
        "Use devshell --help or devshell <command> --help to inspect the allowed model command surface.",
    ];
}

function remoteEnvironmentCommandHints(): string[] {
    return ["help", "attach handle [workspace]", "mask handle"];
}

function remoteEnvironmentCommandCatalog(): JsonValue[] {
    return [
        {
            command: "help",
            summary:
                "Return the authoritative current environ_remote command catalog.",
            usage: "help",
        },
        {
            command: "attach",
            summary:
                "Attach a remote managed instance and optional absolute workspace to the current Context.",
            usage: "attach handle [workspace]",
        },
        {
            command: "mask",
            summary:
                "Permanently hide a remote instance from this Context and revoke any existing attachment.",
            usage: "mask handle",
        },
    ];
}

function assertRemoteArguments(
    input: { handle?: string; workspace?: string },
    expected: { handle: boolean; workspace: boolean | "optional" },
): void {
    if (expected.handle && input.handle === undefined) {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message:
                "This environ_remote command requires handle. Use command='help' for the current command catalog.",
            retryable: false,
        });
    }
    if (!expected.handle && input.handle !== undefined) {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message:
                "handle is not valid for this environ_remote command. Use command='help' for the current command catalog.",
            retryable: false,
        });
    }
    if (expected.workspace === false && input.workspace !== undefined) {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message:
                "workspace is not valid for this environ_remote command. Use command='help' for the current command catalog.",
            retryable: false,
        });
    }
}

function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
