import { spawn } from "node:child_process";

import {
    type BeforeAgentStartEvent,
    type BeforeAgentStartEventResult,
    type InputEvent,
    type InputEventResult,
    type SessionStartEvent,
    type SessionShutdownEvent
} from "@earendil-works/pi-coding-agent";
import {
    CONTROL_PROTOCOL_VERSION,
    ClientConnection,
    connectControlClientChannel,
    createControlClients,
    createError,
    type AgentTarget,
    type AgentToolSessionOpenInput,
    type AgentToolSessionRecord,
    type ControlClients,
    type JsonValue,
    type ToolDefinition
} from "@portable-devshell/shared";

import {
    renderPiToolCall,
    renderPiToolResult,
    type PiThemeLike,
    type PiToolRenderContextLike,
    type PiToolRenderResultLike,
    type PiToolRenderResultOptionsLike
} from "./renderer.js";

import {
    loadDevshellPiWorkspaceResources,
    transformDevshellPiSkillInput,
    type DevshellPiContextFile,
    type DevshellPiWorkspaceResources
} from "./workspace-resources.js";
import { attachStandaloneWorkspaceResources } from "./standalone-resources.js";

export {
    appendDevshellRemoteWorkspacePrompt,
    replacePiProjectContext
} from "./standalone-resources.js";

export {
    expandDevshellPiPromptTemplate,
    loadDevshellPiWorkspaceContext,
    loadDevshellPiWorkspaceResources,
    transformDevshellPiSkillInput
} from "./workspace-resources.js";
export type {
    DevshellPiContextFile,
    DevshellPiWorkspaceResources,
    DevshellPiWorkspaceSkill
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

export interface DevshellPiExtensionAttachOptions {
    standaloneResources?: boolean;
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

export interface DevshellPiExtensionOptions {
    autoStartControl?: boolean;
    controlCommand?: string;
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    target?: AgentTarget | string;
}

export interface DevshellPiWorkspaceBridge {
    close(): Promise<void>;
    extension: (pi: PiExtensionApiLike, options?: DevshellPiExtensionAttachOptions) => Promise<void>;
    loadContextFiles(): Promise<DevshellPiContextFile[]>;
    loadResources(): Promise<DevshellPiWorkspaceResources>;
    refreshResources(): Promise<DevshellPiWorkspaceResources>;
    setActiveSkillNames(names: ReadonlySet<string>): void;
}

interface AgentControlSession {
    clients: ControlClients;
    close(): void;
    record: AgentToolSessionRecord;
}

export function createDevshellPiExtension(
    options: DevshellPiExtensionOptions = {}
): (pi: PiExtensionApiLike) => Promise<void> {
    return async (pi) => {
        const bridge = await openDevshellPiWorkspaceBridge(options);
        try {
            await bridge.extension(pi, { standaloneResources: true });
            pi.on("session_shutdown", bridge.close);
        } catch (error) {
            await bridge.close();
            throw error;
        }
    };
}

export async function openDevshellPiWorkspaceBridge(
    options: DevshellPiExtensionOptions = {}
): Promise<DevshellPiWorkspaceBridge> {
    const session = await openAgentControlSession(options);
    let closed = false;
    let catalog;
    try {
        catalog = await session.clients.agent.listToolSessionTools(session.record.sessionId);
    } catch (error) {
        await closeAgentControlSession(session);
        throw error;
    }
    const toolNames = new Set(catalog.tools.map((tool) => tool.name));
    let resources: DevshellPiWorkspaceResources | undefined;
    let resourcesPromise: Promise<DevshellPiWorkspaceResources> | undefined;
    let resourceGeneration = 0;
    let activeSkillNames: ReadonlySet<string> | undefined;
    const fetchResources = async () => {
        const generation = ++resourceGeneration;
        const loaded = await loadDevshellPiWorkspaceResources(
            session.record.target,
            toolNames,
            async (toolName, input, operationId) => await session.clients.agent.callToolSession({
                input,
                operationId: `pi-resource-generation-${generation}-${operationId}`,
                sessionId: session.record.sessionId,
                toolName
            })
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
    const refreshResources = async () => await fetchResources();
    const close = async () => {
        if (closed) return;
        closed = true;
        await closeAgentControlSession(session);
    };
    return {
        close,
        extension: async (pi, attachOptions = {}) => {
            for (const definition of catalog.tools) {
                pi.registerTool(toPiTool(definition, session));
            }
            const loaded = await loadResources();
            if (attachOptions.standaloneResources === true) {
                attachStandaloneWorkspaceResources(pi, session.record.target, loaded, (names) => {
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
        refreshResources,
        setActiveSkillNames: (names) => {
            activeSkillNames = new Set(names);
        }
    };
}

async function openAgentControlSession(
    options: DevshellPiExtensionOptions
): Promise<AgentControlSession> {
    let clients = createAgentControlClients(options.environment);
    try {
        await negotiateAgentControl(clients);
    } catch (firstError) {
        clients.close();
        if (options.autoStartControl === false || !isControlUnavailable(firstError)) throw firstError;
        await startControl(options);
        clients = createAgentControlClients(options.environment);
        try {
            await negotiateAgentControl(clients);
        } catch (error) {
            clients.close();
            throw error;
        }
    }

    try {
        const target = resolveToolSessionOpenInput(options);
        const record = await clients.agent.openToolSession(target);
        return { clients, close: clients.close, record };
    } catch (error) {
        clients.close();
        throw error;
    }
}

function createAgentControlClients(environment?: NodeJS.ProcessEnv): ControlClients & { close(): void } {
    const connection = new ClientConnection({
        connectChannel: async (signal) => await connectControlClientChannel({
            controlUrl: "",
            ...(environment?.XDG_RUNTIME_DIR === undefined
                ? {}
                : { xdgRuntimeDir: environment.XDG_RUNTIME_DIR })
        }, signal),
        mapError: toClientError,
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "agent"
    });
    return {
        ...createControlClients(connection, { clientKind: "agent" }),
        close: () => connection.close()
    };
}

async function negotiateAgentControl(clients: ControlClients): Promise<void> {
    const hello = await clients.service.hello();
    if (hello.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
        throw new Error(`Incompatible devshell Control protocol version: ${hello.protocolVersion}.`);
    }
}

export function resolveToolSessionOpenInput(
    options: DevshellPiExtensionOptions
): AgentToolSessionOpenInput {
    const configured = options.target ?? options.environment?.DEVSHELL_AGENT_TARGET ?? process.env.DEVSHELL_AGENT_TARGET;
    if (configured !== undefined) {
        return typeof configured === "string" ? parseDevshellAgentTarget(configured) : { ...configured };
    }
    return {
        workspace: options.cwd
            ?? options.environment?.PORTABLE_DEVSHELL_PI_WORKSPACE
            ?? process.env.PORTABLE_DEVSHELL_PI_WORKSPACE
            ?? process.cwd()
    };
}

export function parseDevshellAgentTarget(value: string): AgentTarget {
    if (value.length === 0 || value.trim() !== value) {
        throw new TypeError("DEVSHELL_AGENT_TARGET must not be empty or surrounded by whitespace.");
    }
    const delimiter = value.indexOf(":");
    if (delimiter <= 0) {
        throw new TypeError("DEVSHELL_AGENT_TARGET must use <instance>:<workspace>.");
    }
    const instance = value.slice(0, delimiter);
    const workspace = value.slice(delimiter + 1);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(instance) || workspace.length === 0) {
        throw new TypeError("DEVSHELL_AGENT_TARGET is invalid.");
    }
    return { instance, workspace };
}

function toPiTool(definition: ToolDefinition, session: AgentControlSession): PiToolLike {
    const prompt = piPromptMetadata(definition.name);
    return {
        description: definition.description,
        async execute(toolCallId, params, signal) {
            signal?.throwIfAborted();
            const input = prepareToolInput(definition.name, params);
            const result = await session.clients.agent.callToolSession(
                {
                    input,
                    operationId: toolCallId,
                    sessionId: session.record.sessionId,
                    toolName: definition.name
                },
                signal
            );
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
            return {
                promptSnippet: "Read file contents from the devshell workspace"
            };
        case "file_search":
            return {
                promptSnippet: "Search file contents in the devshell workspace"
            };
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

async function closeAgentControlSession(session: AgentControlSession): Promise<void> {
    try {
        await session.clients.agent.closeToolSession(session.record.sessionId);
    } catch {
        // Control connection teardown also owns and releases the session.
    } finally {
        session.close();
    }
}

async function startControl(options: DevshellPiExtensionOptions): Promise<void> {
    const command = options.controlCommand ?? options.environment?.DEVSHELL_COMMAND ?? process.env.DEVSHELL_COMMAND ?? "devshell";
    const environment = options.environment ?? process.env;
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, ["start"], {
            cwd: options.cwd ?? process.cwd(),
            env: environment,
            stdio: ["ignore", "pipe", "pipe"]
        });
        let output = "";
        const append = (chunk: Buffer | string) => {
            output = `${output}${chunk.toString()}`.slice(-16_384);
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(
                `devshell start failed (${code ?? signal ?? "unknown"}).${output.trim().length === 0 ? "" : `\n${output.trim()}`}`
            ));
        });
    });
}

function toClientError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function isControlUnavailable(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
        if (typeof current === "object") {
            const code = "code" in current ? String((current as { code?: unknown }).code) : undefined;
            if (code === "ENOENT" || code === "ECONNREFUSED") return true;
            current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
            continue;
        }
        break;
    }
    return false;
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

export default createDevshellPiExtension();
