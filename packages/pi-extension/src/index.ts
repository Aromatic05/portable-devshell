import { spawn } from "node:child_process";

import {
    CONTROL_PROTOCOL_VERSION,
    ClientConnection,
    connectControlClientChannel,
    createControlClients,
    createError,
    type AgentTarget,
    type AgentToolSessionRecord,
    type ControlClients,
    type JsonValue,
    type ToolDefinition
} from "@portable-devshell/shared";

export interface PiExtensionApiLike {
    on(event: "session_shutdown", handler: () => Promise<void> | void): void;
    registerTool(tool: PiToolLike): void;
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
}

export interface DevshellPiExtensionOptions {
    autoStartControl?: boolean;
    controlCommand?: string;
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    target?: AgentTarget | string;
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
        const session = await openAgentControlSession(options);
        try {
            const catalog = await session.clients.agent.listToolSessionTools(session.record.sessionId);
            for (const definition of catalog.tools) {
                pi.registerTool(toPiTool(definition, session));
            }
        } catch (error) {
            await closeAgentControlSession(session);
            throw error;
        }
        pi.on("session_shutdown", async () => {
            await closeAgentControlSession(session);
        });
    };
}

export default createDevshellPiExtension();

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
        const target = await resolveTarget(clients, options);
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

async function resolveTarget(
    clients: ControlClients,
    options: DevshellPiExtensionOptions
): Promise<AgentTarget> {
    const configured = options.target ?? options.environment?.DEVSHELL_AGENT_TARGET ?? process.env.DEVSHELL_AGENT_TARGET;
    if (configured !== undefined) {
        return typeof configured === "string" ? parseDevshellAgentTarget(configured) : { ...configured };
    }
    const instances = await clients.instance.list();
    if (instances.length !== 1) {
        throw new Error(
            instances.length === 0
                ? "No devshell instances are configured. Set DEVSHELL_AGENT_TARGET=<instance>:<workspace>."
                : "Multiple devshell instances are configured. Set DEVSHELL_AGENT_TARGET=<instance>:<workspace>."
        );
    }
    return {
        instance: instances[0]!.name,
        workspace: options.cwd ?? process.cwd()
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
    return {
        description: definition.description,
        async execute(toolCallId, params, signal) {
            signal?.throwIfAborted();
            const result = await session.clients.agent.callToolSession(
                {
                    input: asJsonValue(params),
                    operationId: toolCallId,
                    sessionId: session.record.sessionId,
                    toolName: definition.name
                },
                signal
            );
            signal?.throwIfAborted();
            return {
                content: [{ text: renderToolResult(result), type: "text" }],
                details: result
            };
        },
        label: definition.name,
        name: definition.name,
        parameters: definition.inputSchema
    };
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
