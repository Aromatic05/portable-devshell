import {
    createToolTransport,
    type Endpoint,
    type JsonValue,
    type ToolDefinition,
} from "@portable-devshell/shared";

import type { InstanceRegistry } from "../../instance/Api.js";
import type { ToolCallRegistry } from "../../toolcall/Api.js";
import type {
    CodeExecutionPrincipal,
    CodeMethodDescriptor,
    CodeMethodInvocationContext,
    CodeObjectDescriptor,
    CodeObjectProvider,
} from "../Api.js";

const RESERVED_TOOL_NAMESPACES = new Set(["environ", "mcpapp", "workspace"]);

const FALLBACK_WORKER_OBJECTS: readonly CodeObjectDescriptor[] = [
    {
        id: "bash",
        methods: [
            {
                audiences: ["native", "model"],
                example: 'await devshell.bash.run({ command: "git status --short" })',
                inputSchema: {
                    additionalProperties: true,
                    properties: {
                        command: { type: "string" },
                        cwd: { type: "string" },
                        timeoutMs: { type: "integer" },
                        waitMs: { type: "integer" },
                    },
                    required: ["command"],
                    type: "object",
                },
                name: "run",
                summary: "Run a shell command in the target instance workspace.",
            },
        ],
        scopeLevel: "instance",
        summary: "Shell command execution on the target worker.",
    },
    {
        id: "file",
        methods: [
            {
                audiences: ["native", "model"],
                example: 'await devshell.file.read({ files: [{ path: "README.md" }] })',
                inputSchema: {
                    additionalProperties: true,
                    properties: {
                        files: { type: "array" },
                        path: { type: "string" },
                    },
                    type: "object",
                },
                name: "read",
                summary: "Read files from the target workspace.",
            },
            {
                audiences: ["native", "model"],
                inputSchema: {
                    additionalProperties: true,
                    properties: {
                        patch: { type: "string" },
                    },
                    type: "object",
                },
                name: "edit",
                summary: "Apply structured edits to files in the target workspace.",
            },
            {
                audiences: ["native", "model"],
                example: 'await devshell.file.glob({ patterns: ["src/**/*.rs"] })',
                inputSchema: {
                    additionalProperties: true,
                    properties: {
                        cwd: { type: "string" },
                        maxResults: { type: "integer" },
                        patterns: { items: { type: "string" }, type: "array" },
                    },
                    required: ["patterns"],
                    type: "object",
                },
                name: "glob",
                summary: "Find files matching glob patterns.",
            },
            {
                audiences: ["native", "model"],
                example: 'await devshell.file.grep({ pattern: "TODO" })',
                inputSchema: {
                    additionalProperties: true,
                    properties: {
                        cwd: { type: "string" },
                        pattern: { type: "string" },
                    },
                    required: ["pattern"],
                    type: "object",
                },
                name: "grep",
                summary: "Search text content across workspace files.",
            },
        ],
        scopeLevel: "instance",
        summary: "Workspace file inspection, search, and editing.",
    },
    {
        id: "task",
        methods: [
            {
                audiences: ["native", "model"],
                inputSchema: { additionalProperties: true, type: "object" },
                name: "inspect",
                summary: "Inspect running or completed managed tasks.",
            },
            {
                audiences: ["native", "model"],
                inputSchema: { additionalProperties: true, type: "object" },
                name: "input",
                summary: "Send input to or wait on a managed task.",
            },
            {
                audiences: ["native", "model"],
                inputSchema: { additionalProperties: true, type: "object" },
                name: "manage",
                summary: "Create, list, or stop managed tasks and terminals.",
            },
        ],
        scopeLevel: "instance",
        summary: "Managed background process tasks and terminals.",
    },
];

export interface ToolCallCodeObjectProviderOptions {
    readonly endpoint: Endpoint;
    readonly instances: InstanceRegistry;
    readonly toolRegistry: ToolCallRegistry;
}

export class ToolCallCodeObjectProvider implements CodeObjectProvider {
    readonly #endpoint: Endpoint;
    readonly #instances: InstanceRegistry;
    readonly #toolRegistry: ToolCallRegistry;

    constructor(options: ToolCallCodeObjectProviderOptions) {
        this.#endpoint = options.endpoint;
        this.#instances = options.instances;
        this.#toolRegistry = options.toolRegistry;
    }

    describe(
        _principal: CodeExecutionPrincipal,
        instance?: string,
    ): readonly CodeObjectDescriptor[] {
        const grouped = this.#collectObjects(instance);
        return [...grouped.values()].map((entry) => entry.descriptor);
    }

    owns(
        objectId: string,
        _principal: CodeExecutionPrincipal,
        instance?: string,
    ): boolean {
        return this.#collectObjects(instance).has(objectId);
    }

    async invoke(
        objectId: string,
        method: string,
        input: JsonValue,
        context: CodeMethodInvocationContext,
    ): Promise<JsonValue | undefined> {
        if (context.instance === undefined || context.workspace === undefined) {
            throw new Error(
                `devshell.${objectId}.${method}() requires an active instance and workspace.`,
            );
        }
        const entry = this.#collectObjects(context.instance).get(objectId);
        const toolName = entry?.toolNames.get(method) ?? `${objectId}_${method}`;
        const transport = createToolTransport(this.#endpoint, context.instance);
        return await transport.callStreaming(toolName, input, context.workspace, {
            operationId: context.parentCallId,
            signal: context.signal,
        });
    }

    #collectObjects(
        instance?: string,
    ): Map<
        string,
        {
            descriptor: CodeObjectDescriptor;
            toolNames: Map<string, string>;
        }
    > {
        const definitions = this.#resolveToolDefinitions(instance);
        if (definitions.length === 0) {
            const fallback = new Map<
                string,
                {
                    descriptor: CodeObjectDescriptor;
                    toolNames: Map<string, string>;
                }
            >();
            for (const descriptor of FALLBACK_WORKER_OBJECTS) {
                const toolNames = new Map<string, string>();
                for (const method of descriptor.methods) {
                    toolNames.set(method.name, `${descriptor.id}_${method.name}`);
                }
                fallback.set(descriptor.id, { descriptor, toolNames });
            }
            return fallback;
        }

        const grouped = new Map<
            string,
            {
                methods: CodeMethodDescriptor[];
                toolNames: Map<string, string>;
            }
        >();

        for (const definition of definitions) {
            const parsed = splitToolName(definition.name);
            if (parsed === undefined) continue;
            if (RESERVED_TOOL_NAMESPACES.has(parsed.namespace)) continue;
            let bucket = grouped.get(parsed.namespace);
            if (bucket === undefined) {
                bucket = { methods: [], toolNames: new Map() };
                grouped.set(parsed.namespace, bucket);
            }
            if (bucket.toolNames.has(parsed.method)) continue;
            bucket.toolNames.set(parsed.method, definition.name);
            bucket.methods.push({
                audiences: ["native", "model"],
                inputSchema: (definition.inputSchema ?? {
                    additionalProperties: true,
                    type: "object",
                }) as JsonValue,
                name: parsed.method,
                ...(definition.outputSchema === undefined
                    ? {}
                    : { outputSchema: definition.outputSchema as JsonValue }),
                summary: firstSentence(definition.description),
            });
        }

        const result = new Map<
            string,
            {
                descriptor: CodeObjectDescriptor;
                toolNames: Map<string, string>;
            }
        >();

        // Ensure canonical bash/file/task entries exist when worker hasn't synced yet
        for (const fallback of FALLBACK_WORKER_OBJECTS) {
            if (!grouped.has(fallback.id)) {
                const toolNames = new Map<string, string>();
                for (const method of fallback.methods) {
                    toolNames.set(method.name, `${fallback.id}_${method.name}`);
                }
                result.set(fallback.id, { descriptor: fallback, toolNames });
            }
        }

        for (const [namespace, bucket] of grouped.entries()) {
            const fallbackSummary = FALLBACK_WORKER_OBJECTS.find(
                (item) => item.id === namespace,
            )?.summary;
            result.set(namespace, {
                descriptor: {
                    id: namespace,
                    methods: bucket.methods,
                    scopeLevel: "instance",
                    summary: fallbackSummary ?? `Worker ${namespace} operations.`,
                },
                toolNames: bucket.toolNames,
            });
        }
        return result;
    }

    #resolveToolDefinitions(instance?: string): readonly ToolDefinition[] {
        if (instance !== undefined) {
            const listed = this.#toolRegistry.list(instance);
            if (listed.length > 0) return listed.map((entry) => entry.definition);
        }
        for (const candidate of this.#instances.list()) {
            const listed = this.#toolRegistry.list(candidate.config.name);
            if (listed.length > 0) return listed.map((entry) => entry.definition);
        }
        return [];
    }
}

function splitToolName(
    name: string,
): { method: string; namespace: string } | undefined {
    const separator = name.indexOf("_");
    if (separator <= 0 || separator === name.length - 1) return undefined;
    const namespace = name.slice(0, separator);
    const method = name.slice(separator + 1);
    if (!/^[a-z][a-zA-Z0-9]*$/u.test(namespace)) return undefined;
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(method)) return undefined;
    return { method, namespace };
}

function firstSentence(text: string | undefined): string {
    if (text === undefined || text.trim().length === 0) return "";
    const trimmed = text.trim();
    const newline = trimmed.indexOf("\n");
    const line = newline === -1 ? trimmed : trimmed.slice(0, newline).trim();
    return line.length <= 120 ? line : `${line.slice(0, 117)}...`;
}
