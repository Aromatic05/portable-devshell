import type {
    BeforeAgentStartEvent,
    BeforeAgentStartEventResult,
    InputEvent,
    InputEventResult,
    SessionStartEvent,
    SessionShutdownEvent
} from "@earendil-works/pi-coding-agent";
import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

import {
    renderPiToolCall,
    renderPiToolResult,
    type PiThemeLike,
    type PiToolRenderContextLike,
    type PiToolRenderResultLike,
    type PiToolRenderResultOptionsLike
} from "./renderer.js";
import { attachStandaloneWorkspaceResources } from "./standalone-resources.js";
import type { DevshellPiTarget } from "./DevshellPiTarget.js";
import {
    loadDevshellPiWorkspaceResources,
    transformDevshellPiSkillInput,
    type DevshellPiContextFile,
    type DevshellPiWorkspaceResources
} from "./workspace-resources.js";

export interface PiExtensionApiLike {
    on(
        event: "before_agent_start",
        handler: (event: BeforeAgentStartEvent) => BeforeAgentStartEventResult | Promise<BeforeAgentStartEventResult | void> | void
    ): void;
    on(event: "input", handler: (event: InputEvent) => InputEventResult | Promise<InputEventResult | void> | void): void;
    on(event: "session_start", handler: (event: SessionStartEvent) => Promise<void> | void): void;
    on(event: "session_shutdown", handler: (event: SessionShutdownEvent) => Promise<void> | void): void;
    getCommands(): Array<{
        name: string;
        source: "extension" | "prompt" | "skill";
        sourceInfo: { scope?: string };
    }>;
    registerCommand(name: string, options: {
        description?: string;
        handler: (args: string) => Promise<void> | void;
    }): void;
    registerTool(tool: PiToolLike): void;
    sendUserMessage(content: string, options?: { expandPromptTemplates?: boolean }): void;
}

export interface PiToolLike {
    description: string;
    execute(
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal
    ): Promise<{
        content: Array<{ text: string; type: "text" }>;
        details: JsonValue;
    }>;
    label: string;
    name: string;
    parameters: JsonValue;
    promptGuidelines?: string[];
    promptSnippet?: string;
    renderShell?: "default" | "self";
    renderCall?(args: unknown, theme: PiThemeLike, context: PiToolRenderContextLike): unknown;
    renderResult?(
        result: PiToolRenderResultLike,
        options: PiToolRenderResultOptionsLike,
        theme: PiThemeLike,
        context: PiToolRenderContextLike
    ): unknown;
}

export interface DevshellPiToolSession {
    readonly target: DevshellPiTarget;
    readonly tools: readonly ToolDefinition[];
    callTool(
        toolName: string,
        input: JsonValue,
        operationId: string,
        signal?: AbortSignal
    ): Promise<JsonValue>;
    close(): Promise<void> | void;
}

export interface DevshellPiExtensionAttachOptions {
    standaloneResources?: boolean;
}

export interface DevshellPiWorkspaceBridge {
    close(): Promise<void>;
    extension(pi: PiExtensionApiLike, options?: DevshellPiExtensionAttachOptions): Promise<void>;
    loadContextFiles(): Promise<DevshellPiContextFile[]>;
    loadResources(): Promise<DevshellPiWorkspaceResources>;
    refreshResources(): Promise<DevshellPiWorkspaceResources>;
    setActiveSkillNames(names: ReadonlySet<string>): void;
}

export function createDevshellPiExtension(
    session: DevshellPiToolSession
): (pi: PiExtensionApiLike) => Promise<void> {
    return async (pi) => {
        const bridge = createDevshellPiWorkspaceBridge(session);
        try {
            await bridge.extension(pi, { standaloneResources: true });
            pi.on("session_shutdown", bridge.close);
        } catch (error) {
            await bridge.close();
            throw error;
        }
    };
}

export function createDevshellPiWorkspaceBridge(
    session: DevshellPiToolSession
): DevshellPiWorkspaceBridge {
    let closed = false;
    const catalog = [...session.tools];
    const toolNames = new Set(catalog.map((tool) => tool.name));
    let resources: DevshellPiWorkspaceResources | undefined;
    let resourcesPromise: Promise<DevshellPiWorkspaceResources> | undefined;
    let resourceGeneration = 0;
    let activeSkillNames: ReadonlySet<string> | undefined;

    const fetchResources = async () => {
        const generation = ++resourceGeneration;
        const loaded = await loadDevshellPiWorkspaceResources(
            session.target,
            toolNames,
            async (toolName, input, operationId) => await session.callTool(
                toolName,
                input,
                `pi-resource-generation-${generation}-${operationId}`
            )
        );
        if (resources === undefined) {
            resources = loaded;
        } else {
            resources.contextFiles = loaded.contextFiles;
            resources.prompts = loaded.prompts;
            resources.skills = loaded.skills;
        }
        return resources;
    };
    const loadResources = async () => {
        if (resources !== undefined) return resources;
        resourcesPromise ??= fetchResources();
        try {
            return await resourcesPromise;
        } finally {
            resourcesPromise = undefined;
        }
    };

    const close = async () => {
        if (closed) return;
        closed = true;
        await session.close();
    };

    return {
        close,
        extension: async (pi, attachOptions = {}) => {
            for (const definition of catalog) {
                pi.registerTool(toPiTool(definition, session));
            }
            const loaded = await loadResources();
            if (attachOptions.standaloneResources === true) {
                attachStandaloneWorkspaceResources(pi, session.target, loaded, (names) => {
                    activeSkillNames = names;
                });
            }
            pi.on("input", (event) => {
                const active = activeSkillNames;
                return transformDevshellPiSkillInput(
                    active === undefined
                        ? loaded.skills
                        : loaded.skills.filter((skill) => active.has(skill.resource.name)),
                    event
                );
            });
        },
        loadContextFiles: async () => (await loadResources()).contextFiles,
        loadResources,
        refreshResources: fetchResources,
        setActiveSkillNames: (names) => {
            activeSkillNames = new Set(names);
        }
    };
}

function toPiTool(definition: ToolDefinition, session: DevshellPiToolSession): PiToolLike {
    const prompt = piPromptMetadata(definition.name);
    return {
        description: definition.description,
        async execute(toolCallId, params, signal) {
            signal?.throwIfAborted();
            const input = prepareToolInput(definition.name, params);
            const result = await session.callTool(definition.name, input, toolCallId, signal);
            signal?.throwIfAborted();
            return {
                content: [{ text: renderModelToolResult(definition.name, result), type: "text" }],
                details: result
            };
        },
        label: definition.name,
        name: definition.name,
        parameters: definition.inputSchema,
        ...prompt,
        ...(definition.name === "file_edit" ? { renderShell: "self" as const } : {}),
        renderCall(args, theme, context) {
            return renderPiToolCall(definition.name, args, theme, context);
        },
        renderResult(result, options, theme, context) {
            return renderPiToolResult(definition.name, result, options, theme, context);
        }
    };
}

export function piPromptMetadata(toolName: string): Pick<PiToolLike, "promptGuidelines" | "promptSnippet"> {
    switch (toolName) {
        case "file_read":
            return { promptSnippet: "Read file contents from the devshell workspace" };
        case "file_search":
            return { promptSnippet: "Search file contents in the devshell workspace" };
        case "file_edit":
            return {
                promptSnippet: "Edit workspace files with devshell Write/Patch/Rewrite/Delete/Move edit blocks",
                promptGuidelines: [
                    "Before file_edit modifies an existing file, use file_read or file_search on that file in the current context; file_edit rejects unseen existing files.",
                    "file_edit changes must use devshell edit blocks: start with '*** Begin Edit', use '*** Patch File:', '*** Write File:', '*** Rewrite File:', '*** Delete File:', or '*** Move File:', and finish with '*** End Edit'. Never use '*** Update File:'."
                ]
            };
        default:
            return {};
    }
}

export function prepareToolInput(toolName: string, params: unknown): JsonValue {
    const input = asJsonValue(params);
    if (toolName !== "file_edit" || input === null || Array.isArray(input) || typeof input !== "object") {
        return input;
    }
    return { ...input, resultDetail: "diff" };
}

function renderModelToolResult(toolName: string, value: JsonValue): string {
    if (toolName !== "file_edit" || value === null || Array.isArray(value) || typeof value !== "object") {
        return renderToolResult(value);
    }
    const operations = value.operations;
    if (!Array.isArray(operations)) return renderToolResult(value);
    return operations.map((operation) => {
        if (operation === null || Array.isArray(operation) || typeof operation !== "object") {
            return renderToolResult(operation);
        }
        const action = typeof operation.action === "string" ? operation.action : "edit";
        const path = typeof operation.path === "string" ? operation.path : "<unknown>";
        const status = typeof operation.status === "string" ? operation.status : "unknown";
        const added = typeof operation.addedLines === "number" ? `+${operation.addedLines}` : undefined;
        const removed = typeof operation.removedLines === "number" ? `-${operation.removedLines}` : undefined;
        return [action, path, status, added, removed].filter(Boolean).join(" ");
    }).join("\n");
}

function asJsonValue(value: unknown): JsonValue {
    if (!isJsonValue(value)) throw new TypeError("Pi tool arguments are not JSON serializable.");
    return value;
}

function isJsonValue(value: unknown): value is JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJsonValue);
    if (typeof value !== "object") return false;
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function renderToolResult(value: JsonValue): string {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
