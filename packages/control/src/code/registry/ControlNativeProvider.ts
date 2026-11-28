import {
    createProcessTransport,
    toConfigView,
    type ControlConfig,
    type Endpoint,
    type JsonValue,
} from "@portable-devshell/shared";

import type { ContextApi } from "../../context/Api.js";
import type { ExtensionControlPort } from "../../extension/Api.js";
import type {
    InstanceCreatePort,
    InstanceEditorPort,
    InstanceRegistry,
} from "../../instance/Api.js";
import type {
    CodeExecutionPrincipal,
    CodeMethodInvocationContext,
    CodeObjectDescriptor,
    CodeObjectProvider,
} from "../Api.js";

export interface ControlNativeCodeObjectProviderOptions {
    readonly config?: () => ControlConfig;
    readonly contexts?: ContextApi;
    readonly endpoint: Endpoint;
    readonly extensionControl?: ExtensionControlPort;
    readonly instanceCreate?: InstanceCreatePort;
    readonly instanceEditor?: InstanceEditorPort;
    readonly instances: InstanceRegistry;
}

const INSTANCE_OBJECT: CodeObjectDescriptor = {
    callable: true,
    id: "instance",
    methods: [
        {
            audiences: ["native", "model"],
            example: "await devshell.instance.list()",
            inputSchema: { additionalProperties: false, properties: {}, type: "object" },
            name: "list",
            outputSchema: {
                items: {
                    properties: {
                        enabled: { type: "boolean" },
                        mcpEnabled: { type: "boolean" },
                        name: { type: "string" },
                        provider: { type: "string" },
                    },
                    required: ["name", "provider", "enabled"],
                    type: "object",
                },
                type: "array",
            },
            summary: "List configured and active DevShell instances.",
        },
        {
            audiences: ["native", "model"],
            example: 'await devshell.instance.status({ name: "demo-local" })',
            inputSchema: {
                additionalProperties: false,
                properties: { name: { type: "string" } },
                required: ["name"],
                type: "object",
            },
            name: "status",
            summary: "Read runtime status for an instance.",
        },
        {
            audiences: ["native"],
            example: 'await devshell.instance.start({ name: "demo-local" })',
            inputSchema: {
                additionalProperties: false,
                properties: { name: { type: "string" } },
                required: ["name"],
                type: "object",
            },
            name: "start",
            summary: "Start the worker daemon for an instance.",
        },
        {
            audiences: ["native"],
            example: 'await devshell.instance.stop({ name: "demo-local" })',
            inputSchema: {
                additionalProperties: false,
                properties: { name: { type: "string" } },
                required: ["name"],
                type: "object",
            },
            name: "stop",
            summary: "Stop the worker daemon for an instance.",
        },
        {
            audiences: ["native", "model"],
            example: 'await devshell.instance.logs({ name: "demo-local", limit: 50 })',
            inputSchema: {
                additionalProperties: false,
                properties: {
                    limit: { type: "integer" },
                    name: { type: "string" },
                },
                required: ["name"],
                type: "object",
            },
            name: "logs",
            summary: "Read recent worker logs for an instance.",
        },
        {
            audiences: ["native"],
            inputSchema: {
                additionalProperties: false,
                properties: { name: { type: "string" } },
                required: ["name"],
                type: "object",
            },
            name: "enable",
            summary: "Enable a disabled instance.",
        },
        {
            audiences: ["native"],
            inputSchema: {
                additionalProperties: false,
                properties: { name: { type: "string" } },
                required: ["name"],
                type: "object",
            },
            name: "disable",
            summary: "Disable an enabled instance.",
        },
        {
            audiences: ["native"],
            inputSchema: {
                additionalProperties: false,
                properties: { name: { type: "string" } },
                required: ["name"],
                type: "object",
            },
            name: "delete",
            summary: "Delete an instance configuration.",
        },
        {
            audiences: ["native"],
            inputSchema: { additionalProperties: true, type: "object" },
            name: "create",
            summary: "Create a new instance from a validated draft object.",
        },
    ],
    scopeLevel: "control",
    summary: "Instance lifecycle management and InstanceHandle factory.",
};

const CONFIG_OBJECT: CodeObjectDescriptor = {
    id: "config",
    methods: [
        {
            audiences: ["native"],
            example: "await devshell.config.get()",
            inputSchema: { additionalProperties: false, properties: {}, type: "object" },
            name: "get",
            summary: "Read the redacted Control configuration view.",
        },
    ],
    scopeLevel: "control",
    summary: "Control configuration inspection.",
};

const EXTENSION_OBJECT: CodeObjectDescriptor = {
    id: "extension",
    methods: [
        {
            audiences: ["native"],
            example: "await devshell.extension.list()",
            inputSchema: { additionalProperties: false, properties: {}, type: "object" },
            name: "list",
            summary: "List installed Control extensions and their runtime state.",
        },
        {
            audiences: ["native"],
            example: 'await devshell.extension.inspect({ id: "artifact" })',
            inputSchema: {
                additionalProperties: false,
                properties: { id: { type: "string" } },
                required: ["id"],
                type: "object",
            },
            name: "inspect",
            summary: "Inspect one installed extension by id.",
        },
        {
            audiences: ["native"],
            inputSchema: {
                additionalProperties: false,
                properties: { id: { type: "string" } },
                required: ["id"],
                type: "object",
            },
            name: "enable",
            summary: "Enable an installed extension.",
        },
        {
            audiences: ["native"],
            inputSchema: {
                additionalProperties: false,
                properties: { id: { type: "string" } },
                required: ["id"],
                type: "object",
            },
            name: "disable",
            summary: "Disable an installed extension.",
        },
        {
            audiences: ["native"],
            inputSchema: {
                additionalProperties: false,
                properties: { id: { type: "string" } },
                required: ["id"],
                type: "object",
            },
            name: "reload",
            summary: "Reload an active extension generation.",
        },
    ],
    scopeLevel: "control",
    summary: "Control extension lifecycle management.",
};

const CONTEXT_OBJECT: CodeObjectDescriptor = {
    id: "context",
    methods: [
        {
            audiences: ["native"],
            example: "await devshell.context.list()",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    instance: { type: "string" },
                    status: { type: "string" },
                },
                type: "object",
            },
            name: "list",
            summary: "List active and recent Agent contexts.",
        },
    ],
    scopeLevel: "control",
    summary: "Control Context observation.",
};

export class ControlNativeCodeObjectProvider implements CodeObjectProvider {
    readonly #options: ControlNativeCodeObjectProviderOptions;

    constructor(options: ControlNativeCodeObjectProviderOptions) {
        this.#options = options;
    }

    describe(principal: CodeExecutionPrincipal): readonly CodeObjectDescriptor[] {
        const all: CodeObjectDescriptor[] = [INSTANCE_OBJECT];
        if (this.#options.config !== undefined) all.push(CONFIG_OBJECT);
        if (this.#options.extensionControl !== undefined) all.push(EXTENSION_OBJECT);
        if (this.#options.contexts !== undefined) all.push(CONTEXT_OBJECT);

        return all
            .map((descriptor) => ({
                ...descriptor,
                methods: descriptor.methods.filter((method) =>
                    method.audiences.includes(principal.audience),
                ),
            }))
            .filter((descriptor) => descriptor.methods.length > 0 || descriptor.callable === true);
    }

    owns(objectId: string, principal: CodeExecutionPrincipal): boolean {
        return this.describe(principal).some((descriptor) => descriptor.id === objectId);
    }

    async invoke(
        objectId: string,
        method: string,
        input: JsonValue,
        context: CodeMethodInvocationContext,
    ): Promise<JsonValue | undefined> {
        const record = asRecord(input);
        switch (objectId) {
            case "instance":
                return await this.#invokeInstance(method, record, context);
            case "config":
                return this.#invokeConfig(method, context);
            case "extension":
                return await this.#invokeExtension(method, record, context);
            case "context":
                return await this.#invokeContext(method, record, context);
            default:
                throw new Error(`Unknown Control object: ${objectId}`);
        }
    }

    async #invokeInstance(
        method: string,
        input: Record<string, JsonValue>,
        context: CodeMethodInvocationContext,
    ): Promise<JsonValue> {
        switch (method) {
            case "list": {
                const configured = this.#options.config?.().instances;
                if (configured !== undefined) {
                    return configured.map((item) => {
                        const runtime = this.#options.instances.get(item.name);
                        return {
                            active: runtime !== undefined,
                            enabled: item.enabled,
                            mcpEnabled: item.mcp.enabled,
                            name: item.name,
                            provider: item.provider,
                        };
                    });
                }
                return this.#options.instances.list().map((item) => ({
                    active: true,
                    enabled: true,
                    mcpEnabled: item.config.mcpEnabled,
                    name: item.config.name,
                    provider: item.config.provider,
                }));
            }
            case "status": {
                const name = requireString(input, "name");
                const process = createProcessTransport(this.#options.endpoint, name);
                const envelope = await process.snapshot(context.signal);
                return envelope.snapshot as unknown as JsonValue;
            }
            case "start": {
                requireLocalOwner(context, "devshell.instance.start");
                const name = requireString(input, "name");
                const process = createProcessTransport(this.#options.endpoint, name);
                const handle = await process.start({ signal: context.signal });
                return (await handle.snapshot) as unknown as JsonValue;
            }
            case "stop": {
                requireLocalOwner(context, "devshell.instance.stop");
                const name = requireString(input, "name");
                const process = createProcessTransport(this.#options.endpoint, name);
                return (await process.stop(context.signal)) as unknown as JsonValue;
            }
            case "logs": {
                const name = requireString(input, "name");
                const limit =
                    typeof input.limit === "number" ? input.limit : undefined;
                const process = createProcessTransport(this.#options.endpoint, name);
                return (await process.readLogs(
                    limit === undefined ? undefined : { limit },
                    context.signal,
                )) as unknown as JsonValue;
            }
            case "enable": {
                requireLocalOwner(context, "devshell.instance.enable");
                const editor = requirePort(this.#options.instanceEditor, "Instance editing");
                return await editor.enableInstance({ instanceName: requireString(input, "name") });
            }
            case "disable": {
                requireLocalOwner(context, "devshell.instance.disable");
                const editor = requirePort(this.#options.instanceEditor, "Instance editing");
                return await editor.disableInstance({ instanceName: requireString(input, "name") });
            }
            case "delete": {
                requireLocalOwner(context, "devshell.instance.delete");
                const editor = requirePort(this.#options.instanceEditor, "Instance editing");
                return await editor.deleteInstance({ instanceName: requireString(input, "name") });
            }
            case "create": {
                requireLocalOwner(context, "devshell.instance.create");
                const create = requirePort(this.#options.instanceCreate, "Instance creation");
                return (await create.createInstance(input)) as unknown as JsonValue;
            }
            default:
                throw new Error(`Unknown method devshell.instance.${method}`);
        }
    }

    #invokeConfig(
        method: string,
        context: CodeMethodInvocationContext,
    ): JsonValue {
        requireNative(context, `devshell.config.${method}`);
        if (method !== "get") {
            throw new Error(`Unknown method devshell.config.${method}`);
        }
        const read = requirePort(this.#options.config, "Control config");
        return toConfigView(read()) as unknown as JsonValue;
    }

    async #invokeExtension(
        method: string,
        input: Record<string, JsonValue>,
        context: CodeMethodInvocationContext,
    ): Promise<JsonValue> {
        requireNative(context, `devshell.extension.${method}`);
        const control = requirePort(this.#options.extensionControl, "Extension control");
        switch (method) {
            case "list":
                return (await control.list()) as unknown as JsonValue;
            case "inspect": {
                const id = requireString(input, "id");
                const listed = await control.list();
                const found = listed.find((entry) => entry.id === id);
                if (found === undefined) {
                    throw new Error(`Extension ${id} is not installed.`);
                }
                return found as unknown as JsonValue;
            }
            case "enable": {
                requireLocalOwner(context, "devshell.extension.enable");
                const id = requireString(input, "id");
                await control.enable(id);
                return { enabled: true, id };
            }
            case "disable": {
                requireLocalOwner(context, "devshell.extension.disable");
                const id = requireString(input, "id");
                await control.disable(id);
                return { enabled: false, id };
            }
            case "reload": {
                requireLocalOwner(context, "devshell.extension.reload");
                const id = requireString(input, "id");
                await control.reload(id);
                return { id, reloaded: true };
            }
            default:
                throw new Error(`Unknown method devshell.extension.${method}`);
        }
    }

    async #invokeContext(
        method: string,
        input: Record<string, JsonValue>,
        context: CodeMethodInvocationContext,
    ): Promise<JsonValue> {
        requireNative(context, `devshell.context.${method}`);
        const contexts = requirePort(this.#options.contexts, "Context registry");
        if (method !== "list") {
            throw new Error(`Unknown method devshell.context.${method}`);
        }
        const query = {
            ...(typeof input.instance === "string" ? { instance: input.instance } : {}),
            ...(typeof input.status === "string" ? { status: input.status as never } : {}),
        };
        return (await contexts.registry.list(query)) as unknown as JsonValue;
    }
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
    if (typeof value === "object" && value !== null && !Array.isArray(value))
        return value;
    throw new TypeError("Arguments must be a JSON object.");
}

function requireString(input: Record<string, JsonValue>, key: string): string {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
    throw new TypeError(`Missing required string field "${key}".`);
}

function requireNative(
    context: CodeMethodInvocationContext,
    operation: string,
): void {
    if (context.audience !== "native") {
        throw new Error(`${operation} is only available in native Code Mode.`);
    }
}

function requireLocalOwner(
    context: CodeMethodInvocationContext,
    operation: string,
): void {
    requireNative(context, operation);
    if (!context.localOwner) {
        throw new Error(`${operation} requires local owner CLI authority.`);
    }
}

function requirePort<T>(value: T | undefined, label: string): T {
    if (value === undefined) throw new Error(`${label} is unavailable.`);
    return value;
}
