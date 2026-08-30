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
} from "../../context/McpContextRegistry.js";
import type { McpContextSelector } from "../../context/McpContextSelector.js";
import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import {
    mcpContextAcquireToolName,
    mcpContextRenewToolName,
    mcpEnvironmentToolName,
} from "../../tool/catalog/McpToolCatalogEnvironment.js";
import {
    readMcpContextRenewInput,
    readMcpEnvironmentInfoInput,
    readMcpWorkspace,
} from "../McpEndpointInput.js";
import type {
    McpEndpointCallContext,
    McpEndpointWorkerPort,
} from "../McpEndpointPort.js";
import {
    auditMcpEndpointTool,
    mcpEndpointToolNotExposed,
    requireMcpEndpointEnvironment,
} from "./McpEndpointHandlerSupport.js";

interface BoundContextLookup {
    bindings: McpContextExternalBinding[];
    record?: McpContextRecord;
}

export class McpEndpointHandlerEnvironment {
    readonly #contextRegistry: McpContextRegistry;
    readonly #contextSelector: McpContextSelector;
    readonly #gateway?: McpInstanceGateway;
    readonly #instanceName: string;
    readonly #worker: McpEndpointWorkerPort;

    constructor(options: {
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
        this.#worker = options.worker;
    }

    async call(
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        exposed: boolean,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        if (!exposed) {
            throw mcpEndpointToolNotExposed(toolName, this.#instanceName);
        }
        switch (toolName) {
            case mcpContextAcquireToolName:
                return await this.#acquireContext(
                    input,
                    requestContext,
                    signal,
                );
            case mcpContextRenewToolName:
                return await this.#renewContext(input, requestContext, signal);
            case mcpEnvironmentToolName:
                return await this.#environmentInfo(
                    input,
                    requestContext,
                    signal,
                );
            default:
                throw mcpEndpointToolNotExposed(toolName, this.#instanceName);
        }
    }

    async #acquireContext(
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        const requestedWorkspace = readMcpWorkspace(
            input,
            mcpContextAcquireToolName,
        );
        const bound = await this.#lookupBoundContext(requestContext);
        let record = bound.record;
        let created = false;

        if (record?.status === "active") {
            record = await this.#contextRegistry.validateAndTouch(
                record.ctxId,
                {
                    principal: requestContext.principal,
                },
            );
        } else if (record === undefined || record.status === "disabled") {
            record = await this.#contextRegistry.create({
                instance: this.#instanceName,
                principal: requestContext.principal,
                workspace: requestedWorkspace,
            });
            created = true;
        }

        const attachedWorkspace = contextWorkspace(record, this.#instanceName);
        const shouldAttachWorkspace =
            record.status === "active" && attachedWorkspace === undefined;
        const outputWorkspace = attachedWorkspace ?? requestedWorkspace;

        try {
            const result = await this.#auditIdentityTool(
                mcpContextAcquireToolName,
                input,
                record,
                outputWorkspace,
                requestContext,
                signal,
            );
            if (record.status === "active") {
                if (!created && shouldAttachWorkspace) {
                    record = await this.#contextRegistry.attachEnvironment(
                        record.ctxId,
                        {
                            instance: this.#instanceName,
                            workspace: requestedWorkspace,
                        },
                    );
                }
                for (const binding of bound.bindings) {
                    await this.#contextRegistry.bindExternal(
                        record.ctxId,
                        binding,
                        {
                            principal: requestContext.principal,
                        },
                    );
                }
            }
            return result;
        } catch (error) {
            if (created) {
                await this.#contextRegistry
                    .discard(record.ctxId)
                    .catch(() => undefined);
            }
            throw error;
        }
    }

    async #renewContext(
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        const renewInput = readMcpContextRenewInput(input);
        let record: McpContextRecord;
        if (renewInput.ctxId !== undefined) {
            record = await this.#contextRegistry.lookup(renewInput.ctxId, {
                principal: requestContext.principal,
            });
        } else {
            const bound = await this.#lookupBoundContext(requestContext);
            if (bound.record === undefined) throw unboundContext();
            record = bound.record;
        }
        const renewed = await this.#contextRegistry.renewForPrincipal(
            record.ctxId,
            {
                principal: requestContext.principal,
            },
        );
        return await this.#auditIdentityTool(
            mcpContextRenewToolName,
            input,
            renewed,
            contextWorkspace(renewed, this.#instanceName) ?? renewed.workspace,
            requestContext,
            signal,
            false,
        );
    }

    async #environmentInfo(
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        const environmentInput = readMcpEnvironmentInfoInput(input);
        const resolution = await this.#resolveEnvironmentContext(
            environmentInput,
            requestContext,
        );
        const record = resolution.record;
        const previousWorkspace = contextWorkspace(record, this.#instanceName);
        const workspace = environmentInput.workspace ?? previousWorkspace;
        if (workspace === undefined) {
            throw contextWorkspaceRequired(record.ctxId, this.#instanceName);
        }

        const { alerts, environment, prepared } =
            await this.#prepareEnvironment(workspace);
        try {
            await this.#worker.appendMcpToolCalled(mcpEnvironmentToolName, {
                ctxId: record.ctxId,
                requestId: requestContext.requestId,
            });
            const context: ToolCallContext = {
                ctxId: record.ctxId,
                requestId: requestContext.requestId,
                source: "mcp",
                workspace: prepared.workspace,
            };
            const result = await auditMcpEndpointTool({
                context,
                input: {},
                localInstance: this.#instanceName,
                operation: async () => ({
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
                              projectMemoryAgentFile: prepared.projectMemoryAgentFile,
                              projectMemoryDirectory: prepared.projectMemoryDirectory,
                          }
                        : {}),
                    skillsDirectory: environment.skillsDirectory,
                    temporaryDirectory: prepared.temporaryDirectory,
                    workspace: prepared.workspace,
                }),
                signal,
                targetInstance: this.#instanceName,
                toolName: mcpEnvironmentToolName,
                worker: this.#worker,
            });

            const attached = await this.#contextRegistry.attachEnvironment(
                record.ctxId,
                {
                    instance: this.#instanceName,
                    temporaryDirectory: prepared.temporaryDirectory,
                    workspace: prepared.workspace,
                },
            );
            for (const binding of resolution.bindings) {
                await this.#contextRegistry.bindExternal(
                    attached.ctxId,
                    binding,
                    {
                        principal: requestContext.principal,
                    },
                );
            }
            if (
                !resolution.created &&
                previousWorkspace !== undefined &&
                previousWorkspace !== prepared.workspace
            ) {
                await this.#releaseAlertsIfUnused(
                    this.#instanceName,
                    previousWorkspace,
                ).catch(() => undefined);
            }
            return result;
        } catch (error) {
            if (resolution.created) {
                await this.#rollbackUndisclosedContext(
                    record.ctxId,
                    prepared.workspace,
                ).catch(() => undefined);
            } else {
                await this.#releaseAlertsIfUnused(
                    this.#instanceName,
                    prepared.workspace,
                ).catch(() => undefined);
            }
            throw error;
        }
    }

    async #resolveEnvironmentContext(
        input: { ctxId?: string; workspace?: string },
        requestContext: McpEndpointCallContext,
    ): Promise<{
        bindings: McpContextExternalBinding[];
        created: boolean;
        record: McpContextRecord;
    }> {
        if (input.ctxId !== undefined) {
            return {
                bindings: [],
                created: false,
                record: await this.#contextRegistry.validateAndTouch(
                    input.ctxId,
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
                record: await this.#contextRegistry.validateAndTouch(
                    bound.record.ctxId,
                    {
                        principal: requestContext.principal,
                    },
                ),
            };
        }
        if (bound.record !== undefined) {
            return {
                bindings: bound.bindings,
                created: false,
                record: await this.#contextRegistry.validateAndTouch(
                    bound.record.ctxId,
                    {
                        principal: requestContext.principal,
                    },
                ),
            };
        }
        if (bound.bindings.length > 0 || input.workspace === undefined) {
            throw unboundContext();
        }

        return {
            bindings: [],
            created: true,
            record: await this.#contextRegistry.create({
                instance: this.#instanceName,
                principal: requestContext.principal,
                workspace: input.workspace,
            }),
        };
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

    async #auditIdentityTool(
        toolName: string,
        input: JsonValue,
        record: McpContextRecord,
        workspace: string,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
        includeWorkspace = true,
    ): Promise<JsonValue> {
        await this.#worker.appendMcpToolCalled(toolName, {
            ctxId: record.ctxId,
            requestId: requestContext.requestId,
        });
        const context: ToolCallContext = {
            ctxId: record.ctxId,
            requestId: requestContext.requestId,
            source: "mcp",
            workspace,
        };
        return await auditMcpEndpointTool({
            context,
            input,
            localInstance: this.#instanceName,
            operation: async () => ({
                ctxId: record.ctxId,
                expiresAt: record.expiresAt,
                status: record.status,
                ...(includeWorkspace
                    ? { instance: this.#instanceName, workspace }
                    : {}),
            }),
            signal,
            targetInstance: this.#instanceName,
            toolName,
            worker: this.#worker,
        });
    }

    async #prepareEnvironment(workspace: string) {
        const environment = requireMcpEndpointEnvironment(
            this.#worker,
            this.#instanceName,
        );
        const prepareWorkspace = this.#worker.prepareWorkspace;
        if (prepareWorkspace === undefined) {
            throw workspacePreparationUnavailable(this.#instanceName);
        }
        const prepared = await prepareWorkspace.call(this.#worker, workspace);
        const alerts = (await this.#worker.readAlerts(prepared.workspace))
            .advice;
        return { alerts, environment, prepared };
    }

    async #rollbackUndisclosedContext(
        ctxId: string,
        workspace: string,
    ): Promise<void> {
        await this.#contextRegistry.discard(ctxId);
        const now = Date.now();
        const hasOtherActiveContext = (await this.#contextRegistry.list()).some(
            (context) =>
                context.status === "active" &&
                Date.parse(context.expiresAt) > now &&
                context.environments.some(
                    (environment) =>
                        environment.instance === this.#instanceName &&
                        environment.workspace === workspace,
                ),
        );
        if (hasOtherActiveContext) return;
        await this.#worker.releaseAlerts?.(workspace);
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
        message: `No workspace is attached to ${instance} for ${ctxId}. Call context_acquire or instance_connect with an absolute workspace.`,
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

function unboundContext() {
    return createError({
        code: errorCodes.mcpContextInvalid,
        message:
            "No Context is bound to this request. Call context_acquire or provide ctxId.",
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
