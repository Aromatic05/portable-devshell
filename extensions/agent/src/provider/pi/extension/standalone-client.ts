import { spawn } from "node:child_process";

import {
    CONTROL_PROTOCOL_VERSION,
    ClientConnection,
    connectControlClientChannel,
    createControlClients,
    createError,
    type ControlClients
} from "@portable-devshell/shared";

import { createDevshellPiExtension, type DevshellPiToolSession, type PiExtensionApiLike } from "./DevshellPiBridge.js";
import type { DevshellPiTarget } from "./DevshellPiTarget.js";

export interface StandaloneDevshellPiOptions {
    autoStartControl?: boolean;
    controlCommand?: string;
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    target?: DevshellPiTarget | string;
}

interface StandaloneControlSession {
    clients: ControlClients;
    close(): void;
}

export function createStandaloneDevshellPiExtension(
    options: StandaloneDevshellPiOptions = {}
): (pi: PiExtensionApiLike) => Promise<void> {
    return async (pi) => {
        const session = await openStandaloneDevshellPiToolSession(options);
        await createDevshellPiExtension(session)(pi);
    };
}

export async function standaloneDevshellPiExtension(pi: PiExtensionApiLike): Promise<void> {
    await createStandaloneDevshellPiExtension()(pi);
}

export async function openStandaloneDevshellPiToolSession(
    options: StandaloneDevshellPiOptions = {}
): Promise<DevshellPiToolSession> {
    const control = await connectStandaloneControl(options);
    try {
        const requested = resolveStandaloneTarget(options);
        const instance = requested.instance ?? await selectStandaloneInstance(control.clients);
        const instances = await control.clients.instance.list();
        const selected = instances.find((candidate) => candidate.name === instance);
        if (selected === undefined) throw new Error(`Unknown devshell instance: ${instance}`);
        if (!selected.snapshot.ready) await control.clients.runtime.start(instance);
        const opened = await control.clients.tool.openSession(instance, requested.workspace);
        let closed = false;
        return {
            target: { instance, workspace: opened.workspace },
            tools: opened.tools.map((tool) => ({
                description: tool.description,
                inputSchema: tool.inputSchema,
                name: tool.name
            })),
            async callTool(toolName, input, operationId, signal, onProgress) {
                signal?.throwIfAborted();
                const result = await control.clients.tool.callStreaming(
                    instance,
                    toolName,
                    input,
                    opened.workspace,
                    { onProgress, operationId, recording: "caller", signal }
                );
                signal?.throwIfAborted();
                return result;
            },
            async close() {
                if (closed) return;
                closed = true;
                try {
                    await control.clients.tool.closeSession(instance);
                } finally {
                    control.close();
                }
            }
        };
    } catch (error) {
        control.close();
        throw error;
    }
}

export function parseStandaloneDevshellPiTarget(value: string): DevshellPiTarget {
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

async function connectStandaloneControl(options: StandaloneDevshellPiOptions): Promise<StandaloneControlSession> {
    let control = createStandaloneControlClients(options.environment);
    try {
        await negotiate(control.clients);
    } catch (firstError) {
        control.close();
        if (options.autoStartControl === false || !isControlUnavailable(firstError)) throw firstError;
        await startControl(options);
        control = createStandaloneControlClients(options.environment);
        await negotiate(control.clients).catch((error) => {
            control.close();
            throw error;
        });
    }
    return control;
}

function createStandaloneControlClients(environment?: NodeJS.ProcessEnv): StandaloneControlSession {
    const connection = new ClientConnection({
        connectChannel: async (signal) => await connectControlClientChannel({
            controlUrl: "",
            ...(environment?.XDG_RUNTIME_DIR === undefined ? {} : { xdgRuntimeDir: environment.XDG_RUNTIME_DIR })
        }, signal),
        mapError: toClientError,
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "cli"
    });
    return {
        clients: createControlClients(connection, { clientKind: "cli" }),
        close: () => connection.close()
    };
}

async function negotiate(clients: ControlClients): Promise<void> {
    const hello = await clients.service.hello();
    if (hello.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
        throw new Error(`Incompatible devshell Control protocol version: ${hello.protocolVersion}.`);
    }
}

function resolveStandaloneTarget(options: StandaloneDevshellPiOptions): { instance?: string; workspace: string } {
    const environment = options.environment ?? process.env;
    const configured = options.target ?? environment.DEVSHELL_AGENT_TARGET;
    if (configured !== undefined) {
        return typeof configured === "string" ? parseStandaloneDevshellPiTarget(configured) : { ...configured };
    }
    return {
        workspace: options.cwd ?? environment.PORTABLE_DEVSHELL_PI_WORKSPACE ?? process.cwd()
    };
}

async function selectStandaloneInstance(clients: ControlClients): Promise<string> {
    const instances = await clients.instance.list();
    const namedLocal = instances.find((candidate) => candidate.name === "local");
    if (namedLocal !== undefined) return namedLocal.name;
    const ready = instances.filter((candidate) => candidate.snapshot.ready);
    if (ready.length === 1) return ready[0]!.name;
    if (instances.length === 1) return instances[0]!.name;
    throw new Error(
        instances.length === 0
            ? "No devshell instance is configured."
            : "Multiple devshell instances are available; set DEVSHELL_AGENT_TARGET=<instance>:<workspace>."
    );
}

async function startControl(options: StandaloneDevshellPiOptions): Promise<void> {
    const environment = options.environment ?? process.env;
    const command = options.controlCommand ?? environment.DEVSHELL_COMMAND ?? "devshell";
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

function isControlUnavailable(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
        if (typeof current !== "object") break;
        const code = "code" in current ? String((current as { code?: unknown }).code) : undefined;
        if (code === "ENOENT" || code === "ECONNREFUSED") return true;
        current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
    }
    return false;
}

function toClientError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
