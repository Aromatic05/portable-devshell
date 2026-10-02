import {
    createError,
    errorCodes,
    type JsonValue,
    type McpContextRecord,
    type ToolCallContext,
} from "@portable-devshell/shared";

import type { ContextRegistryPort } from "@portable-devshell/shared";
import type { ContextEnvironmentPort, ContextCleanupPort } from "../../../context/Port.js";
import type { McpContextExternalBinding } from "@portable-devshell/shared";
import type { McpContextSelector } from "../../../context/Selector.js";
import type { McpInstanceGateway } from "../../Port.js";
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
} from "../../Port.js";
import {
    callMcpEndpointToolOperation,
    mcpEndpointToolNotExposed,
    requireMcpEndpointEnvironment,
} from "../../dispatch/Support.js";

interface BoundContextLookup {
    bindings: McpContextExternalBinding[];
    record?: McpContextRecord;
}

export interface McpEnvironmentHandlerResult {
    ctxId: string;
    structuredContent: JsonValue;
}

export class McpEndpointHandlerEnvironment {
    readonly #cleanup: ContextCleanupPort;
    readonly #contextRegistry: ContextRegistryPort;
    readonly #contextSelector: McpContextSelector;
    readonly #gateway?: McpInstanceGateway;
    readonly #instanceName: string;
    readonly #environment: ContextEnvironmentPort;
    readonly #worker: McpEndpointWorkerPort;

    constructor(options: {
        cleanup: ContextCleanupPort;
        contextRegistry: ContextRegistryPort;
        environment: ContextEnvironmentPort;
        contextSelector: McpContextSelector;
        gateway?: McpInstanceGateway;
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

    async #remoteEnvironmentCommand(
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
    ): Promise<McpEnvironmentHandlerResult> {
        if (this.#gateway === undefined) {
            throw mcpEndpointToolNotExposed(
                mcpRemoteEnvironmentToolName,
                this.#instanceName,
            );
        }
        const commandInput = readMcpRemoteEnvironmentInput(input, {
            allowContextId: this.#contextSelector.requiresExplicitContextId,
        });
        let resolution = await this.#resolveEnvironmentContext(
            commandInput.ctxId === undefined
                ? {}
                : { ctxId: commandInput.ctxId },
            requestContext,
            { touch: false },
        );
        let record = resolution.record;
        const workspace = contextWorkspace(record, this.#instanceName);
        const context: ToolCallContext = {
            ctxId: record.ctxId,
            requestId: requestContext.requestId,
            source: "mcp",
            ...(workspace === undefined ? {} : { workspace }),
        };
        let resultCtxId = record.ctxId;
        const structuredContent = await callMcpEndpointToolOperation({
            context,
            gateway: this.#gateway,
            input,
            localInstance: this.#instanceName,
            operation: async () => {
                if (!resolution.created) {
                    record = await this.#touchEnvironmentContext(
                        record,
                        requestContext,
                    );
                    resolution = { ...resolution, record };
                }
                resultCtxId = record.ctxId;
                await this.#worker.appendMcpToolCalled(
                    mcpRemoteEnvironmentToolName,
                    {
                        ctxId: record.ctxId,
                        requestId: requestContext.requestId,
                    },
                );
                const base = this.#contextSelector.expose(record);
                switch (commandInput.command) {
                    case "help":
                        assertRemoteArguments(commandInput, {
                            handle: false,
                            workspace: false,
                        });
                        return {
                            ...base,
                            command: "help",
                            details: {
                                commands: remoteEnvironmentCommandCatalog(),
                            },
                            message: "Current environ_remote command catalog.",
                        };
                    case "attach": {
                        assertRemoteArguments(commandInput, {
                            handle: true,
                            workspace: "optional",
                        });
                        const details = await this.#environment.attachRemote(
                            record.ctxId,
                            commandInput.handle!,
                            commandInput.workspace,
                            signal,
                        );
                        return {
                            ...base,
                            command: "attach",
                            details: isJsonRecord(details)
                                ? details
                                : { result: details },
                            message:
                                "Remote environment attached to the current Context.",
                        };
                    }
                    case "mask": {
                        assertRemoteArguments(commandInput, {
                            handle: true,
                            workspace: false,
                        });
                        const details = await this.#environment.maskRemote(
                            record.ctxId,
                            commandInput.handle!,
                        );
                        return {
                            ...base,
                            command: "mask",
                            details,
                            message:
                                "Remote instance is permanently masked for the lifetime of the current Context.",
                        };
                    }
                    default:
                        throw createError({
                            code: errorCodes.targetInvalid,
                            message: `Unknown environ_remote command ${JSON.stringify(commandInput.command)}. Use command='help' for the current command catalog.`,
                            retryable: false,
                        });
                }
            },
            signal,
            targetInstance: this.#instanceName,
            toolName: mcpRemoteEnvironmentToolName,
            worker: this.#worker,
        });
        return { ctxId: resultCtxId, structuredContent };
    }

    async #environmentInfo(
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
    ): Promise<McpEnvironmentHandlerResult> {
        const environmentInput = readMcpEnvironmentInfoInput(input, {
            allowContextId: this.#contextSelector.requiresExplicitContextId,
        });
        let resolution = await this.#resolveEnvironmentContext(
            environmentInput,
            requestContext,
            { touch: false },
        );
        let record = resolution.record;
        const previousWorkspace = contextWorkspace(record, this.#instanceName);
        const workspace = environmentInput.workspace ?? previousWorkspace;
        if (workspace === undefined) {
            throw contextWorkspaceRequired(record.ctxId, this.#instanceName);
        }
        const context: ToolCallContext = {
            ctxId: record.ctxId,
            requestId: requestContext.requestId,
            source: "mcp",
            workspace,
        };
        let attachedCtxId = record.ctxId;
        let committed = false;
        let alertCleanupWorkspace: string | undefined;
        try {
            const structuredContent = await callMcpEndpointToolOperation({
                context,
                gateway: this.#gateway,
                input,
                localInstance: this.#instanceName,
                operation: async () => {
                    await this.#cleanup.reconcile(record.ctxId);
                    if (!resolution.created) {
                        record = await this.#touchEnvironmentContext(
                            record,
                            requestContext,
                        );
                        resolution = { ...resolution, record };
                    }

                    const { alerts, environment, prepared, skillsDirectory } =
                        await this.#prepareEnvironment(
                            record.ctxId,
                            workspace,
                            resolution.bindings.length === 0
                                ? undefined
                                : { bindings: resolution.bindings, principal: requestContext.principal },
                            signal,
                            (prepared) => {
                                alertCleanupWorkspace = prepared;
                            },
                        );
                    committed = true;
                    await this.#worker.appendMcpToolCalled(
                        mcpEnvironmentToolName,
                        {
                            ctxId: record.ctxId,
                            requestId: requestContext.requestId,
                        },
                    );
                    const result = {
                        ...this.#contextSelector.expose(record),
                        expiresAt: record.expiresAt,
                        status: record.status,
                        comment: [
                            ...(prepared.projectMemoryPresent !== false
                                ? [
                                      `Read ${prepared.projectMemoryAgentFile} before resuming existing work; for a selected task, treat its state.json as authoritative.`,
                                  ]
                                : []),
                            `Use ${prepared.workspace}/var/agent-work/ for durable task memory; keep INDEX.md as the task index and each task's state.json as authoritative current state.`,
                            `Use ${prepared.temporaryDirectory} only for small disposable temporary files; temporary storage is limited to 2 GiB per workspace.`,
                            `Put large working data and anything that must persist in ${prepared.workspace}/var/.`,
                            ...modelDevshellComments(
                                this.#gateway?.modelCommands?.(
                                    this.#instanceName,
                                ) ?? [],
                            ),
                            ...alerts.map((advice) => advice.text),
                        ],
                        instance: this.#instanceName,
                        platform: {
                            arch: environment.platform.arch,
                            ...(environment.platform.distribution === undefined
                                ? {}
                                : {
                                      distribution:
                                          environment.platform.distribution,
                                  }),
                            os: environment.platform.os,
                            ...(environment.platform.packageManager === undefined
                                ? {}
                                : {
                                      packageManager:
                                          environment.platform.packageManager,
                                  }),
                            ...(environment.platform.shell === undefined
                                ? {}
                                : { shell: environment.platform.shell.kind }),
                        },
                        ...(prepared.projectMemoryPresent !== false
                            ? {
                                  projectMemoryAgentFile:
                                      prepared.projectMemoryAgentFile,
                                  projectMemoryDirectory:
                                      prepared.projectMemoryDirectory,
                              }
                            : {}),
                        ...(this.#gateway === undefined
                            ? {}
                            : {
                                  remoteEnvironment: {
                                      commands: remoteEnvironmentCommandHints(),
                                  },
                              }),
                        skillsDirectory,
                        temporaryDirectory: prepared.temporaryDirectory,
                        workspace: prepared.workspace,
                    };

                    attachedCtxId = record.ctxId;
                    await this.#cleanup.reconcile(record.ctxId);
                    return result;
                },
                signal,
                targetInstance: this.#instanceName,
                toolName: mcpEnvironmentToolName,
                worker: this.#worker,
            });
            return {
                ctxId: attachedCtxId,
                structuredContent,
            };
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            if (resolution.created) {
                await this.#environment.rollbackUndisclosed(
                    record.ctxId,
                    this.#instanceName,
                    committed ? alertCleanupWorkspace : undefined,
                ).catch((cleanupError) => cleanupFailures.push(cleanupError));
            } else if (committed) {
                throw error;
            }
            if (cleanupFailures.length > 0) {
                throw new AggregateError(
                    [error, ...cleanupFailures],
                    `Environment preparation failed and cleanup was incomplete for ${record.ctxId}.`,
                );
            }
            throw error;
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
                throw createError({
                    code: errorCodes.mcpContextInvalid,
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
    return createError({
        code: errorCodes.mcpContextWorkspaceRequired,
        details: { ctxId, instance },
        message: `No workspace is attached to ${instance} for ${ctxId}. Use environ_remote command='attach' with its handle and an absolute workspace.`,
        retryable: false,
    });
}

function conflictingExternalBindings() {
    return createError({
        code: errorCodes.mcpContextInvalid,
        message:
            "Stable external identities on this request resolve to different Contexts.",
        retryable: false,
    });
}

function unboundContext(requireExplicitContextId: boolean) {
    return createError({
        code: errorCodes.mcpContextInvalid,
        message: requireExplicitContextId
            ? "No Context is bound to this request. Call environ_info with workspace or provide ctxId."
            : "No Context is bound to this request. Call environ_info with workspace.",
        retryable: false,
    });
}

function extensionResourcePreparationUnavailable(instance: string) {
    return createError({
        code: errorCodes.coreWorkerHandshakeFailed,
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
        throw createError({
            code: errorCodes.targetInvalid,
            message:
                "This environ_remote command requires handle. Use command='help' for the current command catalog.",
            retryable: false,
        });
    }
    if (!expected.handle && input.handle !== undefined) {
        throw createError({
            code: errorCodes.targetInvalid,
            message:
                "handle is not valid for this environ_remote command. Use command='help' for the current command catalog.",
            retryable: false,
        });
    }
    if (expected.workspace === false && input.workspace !== undefined) {
        throw createError({
            code: errorCodes.targetInvalid,
            message:
                "workspace is not valid for this environ_remote command. Use command='help' for the current command catalog.",
            retryable: false,
        });
    }
}

function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
