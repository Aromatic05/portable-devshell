import {
    createError,
    errorCodes,
    type ExtensionRemoveResult,
    type ExtensionRuntimeRecord,
    type JsonValue,
    type PrefixRouteContext,
    type PrefixRouteModuleDefinition,
} from "@portable-devshell/shared";
import type {
    ExtensionJsonValue,
    ExtensionPointDeclaration,
} from "@portable-devshell/extension";
import {
    routes,
    type ControlRouteBinding,
    type ControlRouteDeclaration,
    type ControlRouteInvocationContext,
    type ControlRouteRequest,
    type ControlRouteScope,
} from "@portable-devshell/extension/control";

import { routeModule } from "../../server/Route.js";
import type { ExtensionHost } from "./Host.js";
import type {
    ExtensionPointDefinition,
    ExtensionPointSandboxBridge,
    ExtensionPointSandboxInvocationContext,
    ExtensionPointValidationContext,
} from "./generation/registration/PointRegistry.js";
import type { ExtensionSandboxPointCodec } from "./generation/sandbox/bridge/PointCodec.js";

export interface ExtensionControlPort {
    disable(id: string): Promise<void>;
    enable(id: string): Promise<void>;
    install(sourcePath: string): Promise<ExtensionRuntimeRecord>;
    list(): Promise<ExtensionRuntimeRecord[]>;
    reload(id: string): Promise<void>;
    remove(id: string, purge: boolean): Promise<ExtensionRemoveResult>;
}

export const controlRoutesExtensionPointDefinition: ExtensionPointDefinition =
    Object.freeze({
        createSandboxBinding: createControlRouteSandboxBinding,
        id: routes.id,
        parseDeclaration: parseControlRouteDeclaration,
        validateBinding(
            binding: unknown,
            context: ExtensionPointValidationContext,
        ) {
            validateControlRouteBinding(binding, context);
        },
    });

export const controlRoutesSandboxCodec: ExtensionSandboxPointCodec =
    Object.freeze({
        describeBinding(
            binding: unknown,
            context: ExtensionPointValidationContext,
        ): ExtensionJsonValue {
            validateControlRouteBinding(binding, context);
            return Object.freeze({ kind: "route" });
        },
        id: routes.id,
        async invokeBinding(
            binding: unknown,
            input: ExtensionJsonValue | undefined,
            signal: AbortSignal,
            context: ExtensionPointSandboxInvocationContext,
        ): Promise<unknown> {
            validateControlRouteBinding(binding, context);
            const value = readExtensionRecord(input, "Control route invocation");
            const request = readControlRouteRequest(value.request);
            const invocation = readExtensionRecord(
                value.context,
                "Control route invocation context",
            );
            return await (binding as ControlRouteBinding)(
                request,
                Object.freeze({
                    destination: readExtensionString(
                        invocation.destination,
                        "destination",
                    ),
                    peer: readRoutePeer(invocation.peer),
                    ...(invocation.protocolVersion === undefined
                        ? {}
                        : {
                              protocolVersion: readExtensionString(
                                  invocation.protocolVersion,
                                  "protocolVersion",
                              ),
                          }),
                    requestId: readExtensionString(
                        invocation.requestId,
                        "requestId",
                    ),
                    signal,
                    ...(invocation.subject === undefined
                        ? {}
                        : { subject: readRouteSubject(invocation.subject) }),
                }),
            );
        },
    });

export class ControlExtensionRouteService {
    readonly #extensions: Pick<
        ExtensionHost,
        "acquireRegistration" | "listDeclarations" | "onChange"
    >;

    constructor(
        extensions: Pick<
            ExtensionHost,
            "acquireRegistration" | "listDeclarations" | "onChange"
        >,
    ) {
        this.#extensions = extensions;
    }

    modules(scope: ControlRouteScope): readonly PrefixRouteModuleDefinition[] {
        const grouped = new Map<
            string,
            Map<string, { declaration: ControlRouteDeclaration; id: string }>
        >();
        for (const registration of this.#extensions.listDeclarations(routes.id)) {
            const declaration =
                registration.declaration as ControlRouteDeclaration;
            if (declaration.scope !== scope) continue;
            const operations =
                grouped.get(declaration.module) ??
                new Map<
                    string,
                    { declaration: ControlRouteDeclaration; id: string }
                >();
            if (operations.has(declaration.operation)) {
                throw new TypeError(
                    `Control route ${scope}/${declaration.module}/${declaration.operation} is registered more than once.`,
                );
            }
            operations.set(declaration.operation, {
                declaration,
                id: declaration.id,
            });
            grouped.set(declaration.module, operations);
        }
        return [...grouped.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([module, operations]) =>
                routeModule(
                    module,
                    Object.fromEntries(
                        [...operations.entries()]
                            .sort(([left], [right]) =>
                                left.localeCompare(right),
                            )
                            .map(([operation, entry]) => [
                                operation,
                                async (request, context) =>
                                    await this.#invoke(
                                        entry.id,
                                        request,
                                        context,
                                    ),
                            ]),
                    ),
                ),
            );
    }

    onChange(listener: () => void): () => void {
        return this.#extensions.onChange(listener);
    }

    async #invoke(
        id: string,
        request: { payload?: JsonValue; seq?: number },
        context: PrefixRouteContext,
    ): Promise<JsonValue | undefined> {
        const { lease, registration } =
            await this.#extensions.acquireRegistration(routes.id, id);
        try {
            if (typeof registration.binding !== "function") {
                throw new TypeError(
                    `Control route ${id} has an invalid binding.`,
                );
            }
            return (await (registration.binding as ControlRouteBinding)(
                Object.freeze({
                    ...(request.payload === undefined
                        ? {}
                        : {
                              payload:
                                  request.payload as unknown as ExtensionJsonValue,
                          }),
                    ...(request.seq === undefined ? {} : { seq: request.seq }),
                }),
                Object.freeze({
                    destination: context.destination,
                    peer: context.peer,
                    ...(context.protocolVersion === undefined
                        ? {}
                        : { protocolVersion: context.protocolVersion }),
                    requestId: context.requestId,
                    signal: context.signal,
                    ...(context.subject === undefined
                        ? {}
                        : { subject: { ...context.subject } }),
                }),
            )) as JsonValue | undefined;
        } finally {
            lease.release();
        }
    }
}

export function createControlRouteSandboxBinding(
    descriptor: ExtensionJsonValue,
    context: ExtensionPointValidationContext,
    bridge: ExtensionPointSandboxBridge,
): ControlRouteBinding {
    const value = readExtensionRecord(
        descriptor,
        `Extension ${context.extensionId} control.routes/${context.id} sandbox descriptor`,
    );
    if (
        value.kind !== "route" ||
        Object.keys(value).some((key) => key !== "kind")
    ) {
        throw new TypeError(
            `Extension ${context.extensionId} control.routes/${context.id} sandbox descriptor is invalid.`,
        );
    }
    return async (request, invocation) =>
        (await bridge.invokeBinding(
            routes.id,
            context.id,
            {
                context: {
                    destination: invocation.destination,
                    peer: invocation.peer,
                    ...(invocation.protocolVersion === undefined
                        ? {}
                        : { protocolVersion: invocation.protocolVersion }),
                    requestId: invocation.requestId,
                    ...(invocation.subject === undefined
                        ? {}
                        : { subject: { ...invocation.subject } }),
                },
                request: request as unknown as ExtensionJsonValue,
            },
            {
                signal: invocation.signal,
                timeoutLabel: "Control route invocation",
            },
        )) as ExtensionJsonValue | undefined;
}

export function validateControlRouteBinding(
    binding: unknown,
    context: ExtensionPointValidationContext,
): asserts binding is ControlRouteBinding {
    if (typeof binding !== "function") {
        throw new TypeError(
            `Extension ${context.extensionId} control.routes/${context.id} binding must be a function.`,
        );
    }
}

export function createExtensionRouteModule(
    port: ExtensionControlPort,
): PrefixRouteModuleDefinition {
    return routeModule("extension", {
        list: async () => (await port.list()) as unknown as JsonValue,
        get: async (request) =>
            (await requireRecord(
                port,
                readExtensionId(request.payload),
            )) as unknown as JsonValue,
        reload: async (request, context) => {
            requireLocalManagement(context);
            const id = readExtensionId(request.payload);
            await port.reload(id);
            return (await requireRecord(port, id)) as unknown as JsonValue;
        },
        enable: async (request, context) => {
            requireLocalManagement(context);
            const id = readExtensionId(request.payload);
            await port.enable(id);
            return (await requireRecord(port, id)) as unknown as JsonValue;
        },
        disable: async (request, context) => {
            requireLocalManagement(context);
            const id = readExtensionId(request.payload);
            await port.disable(id);
            return (await requireRecord(port, id)) as unknown as JsonValue;
        },
        install: async (request, context) => {
            requireLocalManagement(context);
            return (await port.install(
                readInstallSource(request.payload),
            )) as unknown as JsonValue;
        },
        remove: async (request, context) => {
            requireLocalManagement(context);
            const input = readRemove(request.payload);
            return (await port.remove(
                input.extensionId,
                input.purge,
            )) as unknown as JsonValue;
        },
    });
}

async function requireRecord(
    port: ExtensionControlPort,
    id: string,
): Promise<ExtensionRuntimeRecord> {
    const record = (await port.list()).find((candidate) => candidate.id === id);
    if (record !== undefined) return record;
    throw createError({
        code: errorCodes.controlExtensionNotFound,
        details: { extensionId: id },
        message: `Extension ${id} is not installed.`,
        retryable: false,
    });
}

function requireLocalManagement(context: PrefixRouteContext): void {
    if (isLocalOwnerCli(context)) return;
    throw createError({
        code: errorCodes.controlExtensionAccessDenied,
        message:
            "Extension lifecycle mutations are restricted to the local owner CLI.",
        retryable: false,
    });
}

function isLocalOwnerCli(context: PrefixRouteContext): boolean {
    return context.peer === "cli" && context.subject?.kind === "local-owner";
}

function readExtensionId(payload: JsonValue | undefined): string {
    const value = readRecord(payload, "Extension request");
    assertOnlyKeys(value, ["extensionId"], "Extension request");
    return readExtensionIdValue(value.extensionId);
}

function readInstallSource(payload: JsonValue | undefined): string {
    const value = readRecord(payload, "extension.install");
    assertOnlyKeys(value, ["sourcePath"], "extension.install");
    if (typeof value.sourcePath === "string" && value.sourcePath.length > 0)
        return value.sourcePath;
    throw invalid("extension.install sourcePath must be a non-empty string.");
}

function readRemove(payload: JsonValue | undefined): {
    extensionId: string;
    purge: boolean;
} {
    const value = readRecord(payload, "extension.remove");
    assertOnlyKeys(value, ["extensionId", "purge"], "extension.remove");
    if (value.purge !== undefined && typeof value.purge !== "boolean") {
        throw invalid("extension.remove purge must be boolean.");
    }
    return {
        extensionId: readExtensionIdValue(value.extensionId),
        purge: value.purge === true,
    };
}

function readExtensionIdValue(value: JsonValue | undefined): string {
    if (typeof value === "string" && /^[a-z][a-z0-9-]*$/u.test(value))
        return value;
    throw invalid("extensionId must match [a-z][a-z0-9-]*.");
}

function readRecord(
    payload: JsonValue | undefined,
    operation: string,
): Record<string, JsonValue> {
    if (
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload)
    )
        return payload;
    throw invalid(`${operation} requires an object payload.`);
}

function assertOnlyKeys(
    value: Record<string, JsonValue>,
    keys: readonly string[],
    operation: string,
): void {
    const allowed = new Set(keys);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown !== undefined)
        throw invalid(`${operation} contains unknown field ${unknown}.`);
}

function invalid(message: string): Error {
    return createError({
        code: errorCodes.controlExtensionInvalid,
        message,
        retryable: false,
    });
}

function parseControlRouteDeclaration(
    value: ExtensionPointDeclaration,
): ControlRouteDeclaration {
    const record = value as ExtensionPointDeclaration &
        Record<string, ExtensionJsonValue | undefined>;
    const unknown = Object.keys(record).find(
        (key) =>
            key !== "id" &&
            key !== "module" &&
            key !== "operation" &&
            key !== "scope",
    );
    if (unknown !== undefined) {
        throw new TypeError(
            `control.routes declaration has unknown field ${unknown}.`,
        );
    }
    const scope =
        record.scope === "control" || record.scope === "instance"
            ? record.scope
            : undefined;
    if (scope === undefined) {
        throw new TypeError(
            "control.routes declaration scope must be control or instance.",
        );
    }
    return Object.freeze({
        id: value.id,
        module: readRouteSegment(record.module, "module"),
        operation: readRouteSegment(record.operation, "operation"),
        scope,
    });
}

function readRouteSegment(
    value: ExtensionJsonValue | undefined,
    label: string,
): string {
    const segment = readExtensionString(value, label);
    if (segment.trim() !== segment || segment.includes(".")) {
        throw new TypeError(
            `control.routes declaration ${label} must be a trimmed route segment without dots.`,
        );
    }
    return segment;
}

function readControlRouteRequest(
    value: ExtensionJsonValue | undefined,
): ControlRouteRequest {
    const record = readExtensionRecord(value, "Control route request");
    const unknown = Object.keys(record).find(
        (key) => key !== "payload" && key !== "seq",
    );
    if (unknown !== undefined) {
        throw new TypeError(
            `Control route request contains unknown field ${unknown}.`,
        );
    }
    if (
        record.seq !== undefined &&
        (typeof record.seq !== "number" ||
            !Number.isSafeInteger(record.seq) ||
            record.seq < 0)
    ) {
        throw new TypeError(
            "Control route request seq must be a non-negative integer.",
        );
    }
    return Object.freeze({
        ...(record.payload === undefined ? {} : { payload: record.payload }),
        ...(record.seq === undefined ? {} : { seq: record.seq }),
    });
}

function readRoutePeer(
    value: ExtensionJsonValue | undefined,
): ControlRouteInvocationContext["peer"] {
    if (value === "cli" || value === "tui" || value === "web") return value;
    throw new TypeError("Control route peer is invalid.");
}

function readRouteSubject(
    value: ExtensionJsonValue,
): NonNullable<ControlRouteInvocationContext["subject"]> {
    const record = readExtensionRecord(value, "Control route subject");
    return Object.freeze({
        id: readExtensionString(record.id, "subject.id"),
        kind: readExtensionString(record.kind, "subject.kind"),
    });
}

function readExtensionRecord(
    value: ExtensionJsonValue | undefined,
    label: string,
): Record<string, ExtensionJsonValue> {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, ExtensionJsonValue>;
    }
    throw new TypeError(`${label} must be an object.`);
}

function readExtensionString(
    value: ExtensionJsonValue | undefined,
    label: string,
): string {
    if (typeof value === "string" && value.length > 0) return value;
    throw new TypeError(`${label} must be a non-empty string.`);
}
