import {
    createError,
    errorCodes,
    type ArtifactShareInput,
    type ArtifactTransferStartInput,
    type JsonValue
} from "@portable-devshell/shared";
import type { McpOAuthApprovalService } from "@portable-devshell/mcp";

import type { ArtifactService } from "../../artifact/ArtifactService.js";
import type { ControlConfigEditorService } from "../../control/editor/ConfigEditorService.js";
import type { ControlInstanceCreateService } from "../../control/ControlInstanceCreateService.js";
import type { ControlRpcConnection } from "../../control/rpc/ControlRpcConnection.js";
import type { InstanceRegistry } from "../../instance/registry/InstanceRegistry.js";
import type { ReverseControlService } from "../../reverse/ReverseControlService.js";

export interface RouteHandlerControlOptions {
    artifactService?: ArtifactService;
    configEditorService?: ControlConfigEditorService;
    instanceCreateService?: ControlInstanceCreateService;
    instanceRegistry: InstanceRegistry;
    getOAuthApprovals?: () => McpOAuthApprovalService | undefined;
    getMcpStatus?: () => JsonValue;
    reverseControlService?: ReverseControlService;
}

export class RouteHandlerControl {
    readonly #artifactService?: ArtifactService;
    readonly #configEditorService?: ControlConfigEditorService;
    readonly #instanceCreateService?: ControlInstanceCreateService;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #getOAuthApprovals: () => McpOAuthApprovalService | undefined;
    readonly #getMcpStatus: () => JsonValue;
    readonly #reverseControlService?: ReverseControlService;

    constructor(options: RouteHandlerControlOptions) {
        this.#artifactService = options.artifactService;
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
            case "control.artifact.createShare": {
                const input = readArtifactShareInput(params);
                return (await this.#requireArtifactService().createShare(input, readDefaultInstance(params))) as unknown as JsonValue;
            }
            case "control.artifact.listShares":
                return this.#requireArtifactService().listShares() as unknown as JsonValue;
            case "control.artifact.revokeShare":
                return (await this.#requireArtifactService().revokeShare(readShareId(params))) as unknown as JsonValue;
            case "control.artifact.startTransfer": {
                const input = readArtifactTransferStartInput(params);
                return (await this.#requireArtifactService().startTransfer(input, readDefaultInstance(params))) as unknown as JsonValue;
            }
            case "control.artifact.getTransfer":
                return this.#requireArtifactService().getTransfer(readTransferId(params)) as unknown as JsonValue;
            case "control.artifact.listTransfers":
                return this.#requireArtifactService().listTransfers() as unknown as JsonValue;
            case "control.artifact.cancelTransfer":
                return (await this.#requireArtifactService().cancelTransfer(readTransferId(params))) as unknown as JsonValue;
            default:
                throw createError({
                    code: errorCodes.envelopeInvalid,
                    message: `Method ${method} was not found.`,
                    retryable: false
                });
        }
    }

    #requireArtifactService(): ArtifactService {
        return requireService(this.#artifactService, "Artifact service is not available.");
    }

    #requireInstanceCreateService(): ControlInstanceCreateService {
        return requireService(this.#instanceCreateService, "Instance creation is not available.");
    }

    #requireConfigEditorService(): ControlConfigEditorService {
        return requireService(this.#configEditorService, "Config editing is not available.");
    }

    #requireOAuthApprovals(): McpOAuthApprovalService {
        return requireService(this.#getOAuthApprovals(), "OAuth approvals are not available.");
    }

    #requireReverseControlService(): ReverseControlService {
        return requireService(this.#reverseControlService, "Reverse connection management is not available.");
    }
}

function requireService<T>(service: T | undefined, message: string): T {
    if (service !== undefined) {
        return service;
    }
    throw createError({ code: errorCodes.envelopeInvalid, message, retryable: false });
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

function readArtifactShareInput(params?: JsonValue): ArtifactShareInput {
    if (!isRecord(params)) {
        throw invalidArtifactParams("control.artifact.createShare requires parameters.");
    }
    const rawExpiresInSeconds = params.expiresInSeconds;
    let expiresInSeconds: number | undefined;
    if (rawExpiresInSeconds !== undefined) {
        if (
            typeof rawExpiresInSeconds !== "number" ||
            !Number.isInteger(rawExpiresInSeconds) ||
            rawExpiresInSeconds < 1
        ) {
            throw invalidArtifactParams("expiresInSeconds must be a positive integer.");
        }
        expiresInSeconds = rawExpiresInSeconds;
    }
    const instance = readOptionalString(params.instance, "instance");
    const handle = readOptionalString(params.handle, "handle");
    const path = readOptionalString(params.path, "path");
    if ((handle === undefined) === (path === undefined)) {
        throw invalidArtifactParams("Exactly one of handle or path is required.");
    }
    return handle === undefined
        ? { ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }), ...(instance === undefined ? {} : { instance }), path: path! }
        : { ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }), handle, ...(instance === undefined ? {} : { instance }) };
}

function readArtifactTransferStartInput(params?: JsonValue): ArtifactTransferStartInput {
    if (!isRecord(params)) {
        throw invalidArtifactParams("control.artifact.startTransfer requires parameters.");
    }
    const instance = readOptionalString(params.instance, "instance");
    const handle = readOptionalString(params.handle, "handle");
    const sourcePath = readOptionalString(params.sourcePath, "sourcePath");
    const targetInstance = readRequiredString(params.targetInstance, "targetInstance");
    const targetPath = readRequiredString(params.targetPath, "targetPath");
    if ((handle === undefined) === (sourcePath === undefined)) {
        throw invalidArtifactParams("Exactly one of handle or sourcePath is required.");
    }
    if (params.overwrite !== undefined && typeof params.overwrite !== "boolean") {
        throw invalidArtifactParams("overwrite must be a boolean.");
    }
    const common = {
        operation: "start" as const,
        ...(instance === undefined ? {} : { instance }),
        ...(params.overwrite === undefined ? {} : { overwrite: params.overwrite }),
        targetInstance,
        targetPath
    };
    return handle === undefined ? { ...common, sourcePath: sourcePath! } : { ...common, handle };
}

function readDefaultInstance(params?: JsonValue): string {
    if (!isRecord(params)) {
        throw invalidArtifactParams("Artifact request requires a source instance.");
    }
    const explicitDefault = readOptionalString(params.defaultInstance, "defaultInstance");
    const sourceInstance = readOptionalString(params.instance, "instance");
    if (explicitDefault !== undefined) {
        return explicitDefault;
    }
    if (sourceInstance !== undefined) {
        return sourceInstance;
    }
    throw invalidArtifactParams("Artifact request requires instance or defaultInstance.");
}

function readShareId(params?: JsonValue): string {
    if (!isRecord(params)) {
        throw invalidArtifactParams("Artifact share request requires shareId.");
    }
    return readRequiredString(params.shareId, "shareId");
}

function readTransferId(params?: JsonValue): string {
    if (!isRecord(params)) {
        throw invalidArtifactParams("Artifact transfer request requires transferId.");
    }
    return readRequiredString(params.transferId, "transferId");
}

function readRequiredString(value: JsonValue | undefined, field: string): string {
    const result = readOptionalString(value, field);
    if (result === undefined) {
        throw invalidArtifactParams(`${field} is required.`);
    }
    return result;
}

function readOptionalString(value: JsonValue | undefined, field: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string" || value.length === 0) {
        throw invalidArtifactParams(`${field} must be a non-empty string.`);
    }
    return value;
}

function invalidArtifactParams(message: string) {
    return createError({ code: errorCodes.targetInvalid, message, retryable: false });
}