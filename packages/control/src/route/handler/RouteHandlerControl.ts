import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";
import type { McpOAuthApprovalService } from "@portable-devshell/mcp";

import type { ControlConfigEditorService } from "../../control/ControlConfigEditorService.js";
import type { ControlInstanceCreateService } from "../../control/ControlInstanceCreateService.js";
import type { ControlRpcConnection } from "../../control/rpc/ControlRpcConnection.js";
import type { InstanceRegistry } from "../../instance/registry/InstanceRegistry.js";
import type { ReverseControlService } from "../../reverse/ReverseControlService.js";

export interface RouteHandlerControlOptions {
    configEditorService?: ControlConfigEditorService;
    instanceCreateService?: ControlInstanceCreateService;
    instanceRegistry: InstanceRegistry;
    getOAuthApprovals?: () => McpOAuthApprovalService | undefined;
    getMcpStatus?: () => JsonValue;
    reverseControlService?: ReverseControlService;
}

export class RouteHandlerControl {
    readonly #configEditorService?: ControlConfigEditorService;
    readonly #instanceCreateService?: ControlInstanceCreateService;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #getOAuthApprovals: () => McpOAuthApprovalService | undefined;
    readonly #getMcpStatus: () => JsonValue;
    readonly #reverseControlService?: ReverseControlService;

    constructor(options: RouteHandlerControlOptions) {
        this.#configEditorService = options.configEditorService;
        this.#instanceCreateService = options.instanceCreateService;
        this.#instanceRegistry = options.instanceRegistry;
        this.#getOAuthApprovals = options.getOAuthApprovals ?? (() => undefined);
        this.#getMcpStatus = options.getMcpStatus ?? (() => ({ running: false, reason: "MCP runtime is disabled." }));
        this.#reverseControlService = options.reverseControlService;
    }

    async handle(connection: ControlRpcConnection, method: string, params?: JsonValue): Promise<JsonValue> {
        switch (method) {
            case "control.identifyClient": {
                const clientKind = readDeclaredClientKind(params);

                if (connection.clientKind !== "unknown" && connection.clientKind !== clientKind) {
                    throw createError({
                        code: errorCodes.controlClientIdentityInvalid,
                        message: `Connection is already identified as ${connection.clientKind}.`,
                        retryable: false
                    });
                }

                connection.identifyClient(clientKind);
                return { clientKind, ok: true };
            }
            case "control.ping":
                return { pong: true };
            case "control.getMcpStatus":
                return this.#getMcpStatus();
            case "control.status":
                return {
                    instanceCount: this.#instanceRegistry.list().length,
                    ok: true
                };
            case "control.shutdown":
                return { accepted: true };
            case "control.restart":
                return { accepted: true };
            case "control.listInstances":
                return this.#instanceRegistry.list().map((descriptor) => ({
                    mcpEnabled: descriptor.mcpEnabled,
                    name: descriptor.name,
                    snapshot: descriptor.worker.snapshot()
                })) as unknown as JsonValue;
            case "control.getConfigView":
                return this.#requireConfigEditorService().getConfigView();
            case "control.validateConfigDraft":
                return this.#requireConfigEditorService().validateConfigDraft(params);
            case "control.getInstanceCreateSchema":
                return this.#requireInstanceCreateService().getSchema() as unknown as JsonValue;
            case "control.validateInstanceCreateDraft":
                return this.#requireInstanceCreateService().validateDraft(params) as unknown as JsonValue;
            case "control.createInstance":
                return (await this.#requireInstanceCreateService().createInstance(params)) as unknown as JsonValue;
            case "control.createReverseDeviceCode":
                return (await this.#requireReverseControlService().createDeviceCode(readInstanceName(params))) as unknown as JsonValue;
            case "control.rotateReverseDeviceToken":
                return (await this.#requireReverseControlService().rotateDeviceToken(readInstanceName(params))) as unknown as JsonValue;
            case "control.revokeReverseDeviceToken":
                return (await this.#requireReverseControlService().revokeDeviceToken(readInstanceName(params))) as unknown as JsonValue;
            case "control.updateInstanceConfig":
                return await this.#requireConfigEditorService().updateInstanceConfig(params);
            case "control.updateMcpConfig":
                return await this.#requireConfigEditorService().updateMcpConfig(params);
            case "control.deleteInstance":
                return await this.#requireConfigEditorService().deleteInstance(params);
            case "control.enableInstance":
                return await this.#requireConfigEditorService().enableInstance(params);
            case "control.disableInstance":
                return await this.#requireConfigEditorService().disableInstance(params);
            case "control.applyConfig":
                return this.#requireConfigEditorService().applyConfig();
            case "control.listOAuthApprovals":
                return (await this.#requireOAuthApprovals().list()) as unknown as JsonValue;
            case "control.decideOAuthApproval":
                return (await this.#requireOAuthApprovals().decide(
                    readOAuthApprovalId(params),
                    readOAuthApprovalDecision(params),
                    readOAuthApprovalDecidedBy(connection)
                )) as unknown as JsonValue;
            default:
                throw createError({
                    code: errorCodes.envelopeInvalid,
                    message: `Method ${method} was not found.`,
                    retryable: false
                });
        }
    }

    #requireInstanceCreateService(): ControlInstanceCreateService {
        if (this.#instanceCreateService !== undefined) {
            return this.#instanceCreateService;
        }

        throw createError({
            code: errorCodes.envelopeInvalid,
            message: "Instance creation is not available.",
            retryable: false
        });
    }

    #requireConfigEditorService(): ControlConfigEditorService {
        if (this.#configEditorService !== undefined) {
            return this.#configEditorService;
        }

        throw createError({
            code: errorCodes.envelopeInvalid,
            message: "Config editing is not available.",
            retryable: false
        });
    }

    #requireOAuthApprovals(): McpOAuthApprovalService {
        const approvals = this.#getOAuthApprovals();
        if (approvals !== undefined) {
            return approvals;
        }

        throw createError({
            code: errorCodes.envelopeInvalid,
            message: "OAuth approvals are not available.",
            retryable: false
        });
    }
    #requireReverseControlService(): ReverseControlService {
        if (this.#reverseControlService !== undefined) {
            return this.#reverseControlService;
        }

        throw createError({
            code: errorCodes.envelopeInvalid,
            message: "Reverse connection management is not available.",
            retryable: false
        });
    }

}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDeclaredClientKind(params?: JsonValue): "cli" | "tui" {
    if (!isRecord(params)) {
        throw createError({
            code: errorCodes.controlClientIdentityInvalid,
            message: "control.identifyClient requires clientKind.",
            retryable: false
        });
    }

    if (params.clientKind === "cli" || params.clientKind === "tui") {
        return params.clientKind;
    }

    if (params.clientKind === "mcp") {
        throw createError({
            code: errorCodes.controlClientIdentityInvalid,
            message: "MCP client identity is assigned by the MCP endpoint, not control RPC.",
            retryable: false
        });
    }

    throw createError({
        code: errorCodes.controlClientIdentityInvalid,
        message: "control.identifyClient requires clientKind to be cli or tui.",
        retryable: false
    });
}

function readInstanceName(params?: JsonValue): string {
    if (!isRecord(params) || typeof params.instance !== "string" || params.instance.length === 0) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "Reverse connection method requires instance.",
            retryable: false
        });
    }
    return params.instance;
}

function readOAuthApprovalId(params?: JsonValue): string {
    if (!isRecord(params) || typeof params.approvalId !== "string" || params.approvalId.length === 0) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "control.decideOAuthApproval requires approvalId.",
            retryable: false
        });
    }

    return params.approvalId;
}

function readOAuthApprovalDecision(params?: JsonValue): "approve" | "deny" {
    if (!isRecord(params) || (params.decision !== "approve" && params.decision !== "deny")) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "control.decideOAuthApproval requires decision approve or deny.",
            retryable: false
        });
    }

    return params.decision;
}

function readOAuthApprovalDecidedBy(connection: ControlRpcConnection): "cli" | "tui" {
    if (connection.clientKind === "cli" || connection.clientKind === "tui") {
        return connection.clientKind;
    }

    throw createError({
        code: errorCodes.controlClientIdentityRequired,
        message: "Connection must identify as cli or tui before deciding OAuth approvals.",
        retryable: false
    });
}
