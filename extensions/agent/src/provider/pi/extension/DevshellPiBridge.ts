import type {
    BeforeAgentStartEvent,
    BeforeAgentStartEventResult,
    InputEvent,
    InputEventResult,
    SessionStartEvent,
    SessionShutdownEvent
} from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@portable-devshell/shared";

import {
    prepareAgentModelToolInput,
    projectAgentModelToolResult
} from "../../../builtin/provider/AgentToolProjection.js";
import type { AgentModelToolDefinition } from "../../../builtin/provider/AgentToolSession.js";
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
        signal?: AbortSignal,
        onUpdate?: (result: {
            content: Array<{ text: string; type: "text" }>;
            details: JsonValue;
        }) => void
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
    readonly modelTools: readonly AgentModelToolDefinition[];
    readonly tools: readonly DevshellPiToolDefinition[];
    callTool(
        toolName: string,
        input: JsonValue,
        operationId: string,
        signal?: AbortSignal,
        onProgress?: (progress: JsonValue) => void
    ): Promise<JsonValue>;
    close(): Promise<void> | void;
}

export interface DevshellPiToolDefinition {
    description: string;
    inputSchema: JsonValue;
    name: string;
}

export interface DevshellPiExtensionAttachOptions {
    standaloneResources?: boolean;
}

export interface DevshellPiExtensionOptions {
    closeSessionOnShutdown?: boolean;
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
    session: DevshellPiToolSession,
    options: DevshellPiExtensionOptions = {}
): (pi: PiExtensionApiLike) => Promise<void> {
    return async (pi) => {
        const bridge = createDevshellPiWorkspaceBridge(session);
        try {
            await bridge.extension(pi, { standaloneResources: true });
            if (options.closeSessionOnShutdown !== false) {
                pi.on("session_shutdown", bridge.close);
            }
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
    const catalog = [...session.modelTools];
    const toolNames = new Set(session.tools.map((tool) => tool.name));
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

function toPiTool(definition: DevshellPiToolDefinition, session: DevshellPiToolSession): PiToolLike {
    const prompt = piPromptMetadata(definition.name);
    return {
        description: definition.description,
        async execute(toolCallId, params, signal, onUpdate) {
            signal?.throwIfAborted();
            const input = prepareAgentModelToolInput(definition.name, params);
            const result = await session.callTool(
                definition.name,
                input,
                toolCallId,
                signal,
                onUpdate === undefined ? undefined : (progress) => {
                    onUpdate({
                        content: [{ text: projectAgentModelToolResult(definition.name, progress), type: "text" }],
                        details: progress
                    });
                }
            );
            signal?.throwIfAborted();
            return {
                content: [{ text: projectAgentModelToolResult(definition.name, result), type: "text" }],
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
            return { promptSnippet: "Read file contents, outlines, or metadata from the devshell workspace" };
        case "file_grep":
            return { promptSnippet: "Search file contents in the devshell workspace" };
        case "file_edit":
            return {
                promptSnippet: "Edit workspace files with devshell Write/Patch/Rewrite/Delete/Move edit blocks",
                promptGuidelines: [
                    "Before file_edit modifies an existing file, use file_read or file_grep on that file in the current context; file_edit rejects unseen existing files.",
                    "file_edit changes must use devshell edit blocks: start with '*** Begin Edit', use '*** Patch File:', '*** Write File:', '*** Rewrite File:', '*** Delete File:', or '*** Move File:', and finish with '*** End Edit'. Never use '*** Update File:'."
                ]
            };
        default:
            return {};
    }
}
