import {
    createError,
    errorCodes,
    type JsonValue,
    type McpContextRecord,
    type ToolCallContext,
} from "@portable-devshell/shared";

import {
    McpContextRegistry,
    type McpContextExternalBinding,
} from "../../../context/registry/Registry.js";
import {
    McpContextEnvironmentCleanupService,
    McpContextRemoteEnvironment,
} from "../../../context/Environment.js";
import type { McpContextSelector } from "../../../context/Selector.js";
import { isMcpGoalGateway, type McpInstanceGateway } from "../../Port.js";
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
    readonly #cleanup: McpContextEnvironmentCleanupService;
    readonly #contextRegistry: McpContextRegistry;
    readonly #contextSelector: McpContextSelector;
    readonly #gateway?: McpInstanceGateway;
    readonly #instanceName: string;
    readonly #remoteEnvironment?: McpContextRemoteEnvironment;
    readonly #worker: McpEndpointWorkerPort;

    constructor(options: {
        cleanup?: McpContextEnvironmentCleanupService;
        contextRegistry: McpContextRegistry;
        contextSelector: McpContextSelector;
        gateway?: McpInstanceGateway;
        instanceName: string;
        worker: McpEndpointWorkerPort;
    }) {
        this.#contextRegistry = options.contextRegistry;
        this.#contextSelector = options.contextSelector;
        this.#gateway = options.gateway;
        this.#instanceName = options.instanceName;
        this.#cleanup =
            options.cleanup ??
            new McpContextEnvironmentCleanupService({
                contextRegistry: this.#contextRegistry,
                gateway: () => options.gateway,
                releaseLocalAlerts: async (instance, workspace) => {
                    if (instance !== options.instanceName) {
                        throw new Error(
                            `Instance ${instance} is unavailable for local alert cleanup.`,
                        );
                    }
                    await options.worker.releaseAlerts?.(workspace);
                },
            });
        this.#remoteEnvironment =
            options.gateway === undefined
                ? undefined
                : new McpContextRemoteEnvironment({
                      cleanup: this.#cleanup,
                      contextRegistry: this.#contextRegistry,
                      gateway: () => options.gateway,
                  });
        this.#worker = options.worker;
    }

    async call(
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        exposed: boolean,
        signal?: AbortSignal,
        onFeedback?: (feedback: readonly string[]) => void,
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
                    onFeedback,
                );
            case mcpRemoteEnvironmentToolName:
                return await this.#remoteEnvironmentCommand(
                    input,
                    requestContext,
                    signal,
                    onFeedback,
                );
            default:
                throw mcpEndpointToolNotExposed(toolName, this.#instanceName);
        }
    }

    async #remoteEnvironmentCommand(
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
        onFeedback?: (feedback: readonly string[]) => void,
    ): Promise<McpEnvironmentHandlerResult> {
        const remote = this.#remoteEnvironment;
        if (remote === undefined) {
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
        const workspace =
            contextWorkspace(record, this.#instanceName) ?? record.workspace;
        const context: ToolCallContext = {
            ctxId: record.ctxId,
            requestId: requestContext.requestId,
            source: "mcp",
            ...(workspace === undefined ? {} : { workspace }),
        };
        let resultCtxId = record.ctxId;
        const structuredContent = await callMcpEndpointToolOperation({
            context,
            input,
            localInstance: this.#instanceName,
            onFeedback,
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
                        const details = await remote.attach(
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
                        const details = await remote.mask(
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
        onFeedback?: (feedback: readonly string[]) => void,
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
        let preparedWorkspace: string | undefined;
        let alertCleanupWorkspace: string | undefined;
        try {
            const structuredContent = await callMcpEndpointToolOperation({
                context,
                input,
                localInstance: this.#instanceName,
                onFeedback,
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
                            workspace,
                            (prepared) => {
                                preparedWorkspace = prepared;
                            },
                            (prepared) => {
                                alertCleanupWorkspace = prepared;
                            },
                        );
                    if (
                        !resolution.created &&
                        previousWorkspace !== undefined &&
                        previousWorkspace !== prepared.workspace
                    ) {
                        await this.#assertWorkspaceSwitchAvailable(
                            record.ctxId,
                            previousWorkspace,
                        );
                    }
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
                                      `Read ${prepared.projectMemoryAgentFile} before working.`,
                                      `Use ${prepared.projectMemoryDirectory} for durable project memory; keep it useful for future sessions.`,
                                  ]
                                : []),
                            `Use ${prepared.temporaryDirectory} for all temporary files.`,
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
                        ...(this.#remoteEnvironment === undefined
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

                    const attached = await this.#contextRegistry.attachEnvironment(
                        record.ctxId,
                        {
                            instance: this.#instanceName,
                            temporaryDirectory: prepared.temporaryDirectory,
                            workspace: prepared.workspace,
                        },
                        resolution.bindings.length === 0
                            ? undefined
                            : {
                                  bindings: resolution.bindings,
                                  principal: requestContext.principal,
                              },
                    );
                    committed = true;
                    attachedCtxId = attached.ctxId;
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
                await this.#rollbackUndisclosedContext(
                    record.ctxId,
                    alertCleanupWorkspace,
                ).catch((cleanupError) => cleanupFailures.push(cleanupError));
            } else if (committed) {
                throw error;
            } else if (alertCleanupWorkspace !== undefined) {
                const cleanupWorkspace = alertCleanupWorkspace;
                await this.#releaseAlertsIfUnused(
                    this.#instanceName,
                    cleanupWorkspace,
                ).catch(async (cleanupError) => {
                    cleanupFailures.push(cleanupError);
                    await this.#contextRegistry
                        .recordEnvironmentCleanup(record.ctxId, {
                            instance: this.#instanceName,
                            kind: "alerts",
                            workspace: cleanupWorkspace,
                        })
                        .catch((debtError) => cleanupFailures.push(debtError));
                });
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

    async #assertWorkspaceSwitchAvailable(
        ctxId: string,
        previousWorkspace: string,
    ): Promise<void> {
        const gateway = this.#gateway;
        if (gateway === undefined) return;
        if (isMcpGoalGateway(gateway)) {
            const goal = await gateway.readGoal(this.#instanceName, ctxId);
            if (goal?.status === "active" || goal?.status === "blocked") {
                throw new Error(
                    `Workspace Goal ${goal.goalId} is still ${goal.status} in ${goal.workspace ?? previousWorkspace}; finish or stop it before switching workspace.`,
                );
            }
        }
        if (gateway.listWaits !== undefined) {
            const waits = await gateway.listWaits(this.#instanceName);
            const blocking = waits.find(
                (wait) =>
                    wait.createdByCtxId === ctxId &&
                    (wait.workspace === undefined ||
                        wait.workspace === previousWorkspace) &&
                    wait.automaticRecovery !== false &&
                    wait.recoveryDisabledAt === undefined &&
                    wait.status !== "consumed" &&
                    wait.status !== "cancelled",
            );
            if (blocking !== undefined) {
                throw new Error(
                    `Workspace wait ${blocking.waitId} is still attached to ${previousWorkspace}; finish or stop its owner before switching workspace.`,
                );
            }
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
                : (contextWorkspace(bound.record, this.#instanceName) ??
                  bound.record.workspace));
        if (workspace === undefined)
            throw unboundContext(
                this.#contextSelector.requiresExplicitContextId,
            );

        return {
            bindings: bound.bindings,
            created: true,
            record: await this.#contextRegistry.create({
                instance: this.#instanceName,
                principal: requestContext.principal,
                workspace,
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
        workspace: string,
        onPrepared?: (workspace: string) => void,
        onAlertsAcquiring?: (workspace: string) => void,
    ) {
        const environment = requireMcpEndpointEnvironment(
            this.#worker,
            this.#instanceName,
        );
        const prepareWorkspace = this.#worker.prepareWorkspace;
        if (prepareWorkspace === undefined) {
            throw workspacePreparationUnavailable(this.#instanceName);
        }
        const prepareExtensionResource = this.#worker.prepareExtensionResource;
        if (prepareExtensionResource === undefined) {
            throw extensionResourcePreparationUnavailable(this.#instanceName);
        }
        const prepared = await prepareWorkspace.call(this.#worker, workspace);
        onPrepared?.(prepared.workspace);
        const skills = await prepareExtensionResource.call(this.#worker, {
            collection: "managed",
            extensionId: "skill",
        });
        onAlertsAcquiring?.(prepared.workspace);
        const alerts = (await this.#worker.readAlerts(prepared.workspace))
            .advice;
        return {
            alerts,
            environment,
            prepared,
            skillsDirectory: skills.directory,
        };
    }

    async #rollbackUndisclosedContext(
        ctxId: string,
        workspace?: string,
    ): Promise<void> {
        if (workspace === undefined) {
            await this.#contextRegistry.discard(ctxId);
            return;
        }
        const now = Date.now();
        const hasOtherActiveContext = (await this.#contextRegistry.list()).some(
            (context) =>
                context.ctxId !== ctxId &&
                context.status === "active" &&
                Date.parse(context.expiresAt) > now &&
                context.environments.some(
                    (environment) =>
                        environment.instance === this.#instanceName &&
                        environment.workspace === workspace,
                ),
        );
        await this.#contextRegistry.disable(ctxId);
        if (!hasOtherActiveContext && this.#worker.releaseAlerts !== undefined) {
            try {
                await this.#worker.releaseAlerts(workspace);
            } catch (error) {
                const failures: unknown[] = [error];
                await this.#contextRegistry
                    .recordEnvironmentCleanup(ctxId, {
                        instance: this.#instanceName,
                        kind: "alerts",
                        workspace,
                    })
                    .catch((debtError) => failures.push(debtError));
                if (failures.length === 1) throw failures[0];
                throw new AggregateError(
                    failures,
                    `Undisclosed Context ${ctxId} cleanup was incomplete.`,
                );
            }
        }
        await this.#contextRegistry.discard(ctxId);
    }

    async #releaseAlertsIfUnused(
        instance: string,
        workspace: string,
    ): Promise<void> {
        const now = Date.now();
        const inUse = (await this.#contextRegistry.list()).some(
            (context) =>
                context.status === "active" &&
                Date.parse(context.expiresAt) > now &&
                context.environments.some(
                    (environment) =>
                        environment.instance === instance &&
                        environment.workspace === workspace,
                ),
        );
        if (inUse) return;
        if (this.#gateway !== undefined) {
            await this.#gateway.releaseAlerts(instance, workspace);
            return;
        }
        if (instance === this.#instanceName) {
            await this.#worker.releaseAlerts?.(workspace);
        }
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

function workspacePreparationUnavailable(instance: string) {
    return createError({
        code: errorCodes.coreWorkerHandshakeFailed,
        details: { instance },
        message: `Workspace preparation is unavailable for ${instance}.`,
        retryable: true,
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
