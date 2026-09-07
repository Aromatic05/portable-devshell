import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createDevshellPiExtension } from "@portable-devshell/pi-extension";
import type { AgentWorkerTarget } from "@portable-devshell/agentd";
import { PiChildToolSession } from "./PiChildToolSession.js";
import { PiGuiWeb } from "./PiGuiWeb.js";
import { PiSdkLoader, type PiModelRuntimeLike, type PiSdkModule, type PiSessionLike } from "./PiSdkLoader.js";
import type {
    PiChildAgentCommandMessage,
    PiChildAgentStartMessage,
    PiChildInitMessage,
    PiParentMessage
} from "./PiProcessProtocol.js";
import { deliverPiAgentMessage } from "./PiAgentCommands.js";
import { disposeManagedPiAgent } from "./PiAgentLifecycle.js";

interface ManagedPiAgent {
    localCwd: string;
    session: PiSessionLike;
    target: AgentWorkerTarget;
    tools: PiChildToolSession;
}

let agentDir: string | undefined;
const agents = new Map<string, ManagedPiAgent>();
const toolSessions = new Map<string, PiChildToolSession>();
let gui: PiGuiWeb | undefined;
let modelRuntime: PiModelRuntimeLike | undefined;
let sdk: PiSdkModule | undefined;

process.on("message", (value: unknown) => {
    const message = value as PiParentMessage;
    if (message?.type === "tool.result") {
        toolSessions.get(message.agentId)?.accept(message);
        return;
    }
    void handleMessage(message).catch((error) => sendFailure(message, error));
});
process.once("disconnect", () => {
    const error = new Error("Pi provider parent IPC disconnected.");
    for (const session of toolSessions.values()) session.disconnect(error);
    void shutdown().finally(() => process.exit(0));
});

async function handleMessage(message: PiParentMessage): Promise<void> {
    switch (message.type) {
        case "init": {
            const upstream = await initialize(message);
            send({ ok: true, type: "ready", webUpstream: upstream.toString() });
            return;
        }
        case "agent.start":
            await startAgent(message);
            send({ id: message.id, ok: true, type: "result" });
            return;
        case "agent.command":
            await commandAgent(message);
            send({ id: message.id, ok: true, type: "result" });
            return;
        case "shutdown":
            await shutdown();
            send({ id: message.id, ok: true, type: "result" });
            setImmediate(() => process.exit(0));
            return;
    }
}

async function initialize(input: PiChildInitMessage): Promise<URL> {
    if (sdk !== undefined) throw new Error("Pi provider child is already initialized.");
    sdk = await new PiSdkLoader().load(input.entrypoint);
    agentDir = sdk.getAgentDir();
    await mkdir(agentDir, { recursive: true });
    modelRuntime = await sdk.ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json")
    });
    gui = await PiGuiWeb.start(input.webBasePath);
    return gui.upstream;
}

async function startAgent(input: PiChildAgentStartMessage): Promise<void> {
    if (agents.has(input.agentId)) throw new Error(`Pi Agent already exists: ${input.agentId}`);
    const activeSdk = requireSdk();
    const activeAgentDir = requireAgentDir();
    const activeModelRuntime = requireModelRuntime();
    const activeGui = requireGui();
    await mkdir(input.localCwd, { recursive: true });
    const tools = new PiChildToolSession({
        agentId: input.agentId,
        send,
        target: input.target,
        tools: input.tools
    });
    toolSessions.set(input.agentId, tools);

    const settingsManager = activeSdk.SettingsManager.create(input.localCwd, activeAgentDir);
    const resourceLoader = new activeSdk.DefaultResourceLoader({
        agentDir: activeAgentDir,
        cwd: input.localCwd,
        extensionFactories: [{
            factory: createDevshellPiExtension(tools, { closeSessionOnShutdown: false }),
            hidden: true,
            name: "portable-devshell"
        }],
        noExtensions: true,
        settingsManager
    });
    let session: PiSessionLike | undefined;
    try {
        await resourceLoader.reload();
        const sessionManager = activeSdk.SessionManager.create(input.localCwd);
        const created = await activeSdk.createAgentSession({
            agentDir: activeAgentDir,
            cwd: input.localCwd,
            modelRuntime: activeModelRuntime,
            noTools: "builtin",
            resourceLoader,
            sessionManager,
            settingsManager
        });
        session = created.session;
        session.setSessionName?.(`${input.agentId} · ${input.target.instance}:${input.target.workspace}`);
        activeGui.attach(session, input.localCwd);
        agents.set(input.agentId, {
            localCwd: input.localCwd,
            session,
            target: { ...input.target },
            tools
        });
    } catch (error) {
        session?.dispose();
        try {
            await tools.close().catch(() => undefined);
        } finally {
            toolSessions.delete(input.agentId);
        }
        throw error;
    }
}

async function commandAgent(message: PiChildAgentCommandMessage): Promise<void> {
    if (message.command === "stop") {
        await stopAgent(message.agentId);
        return;
    }
    const active = requireAgent(message.agentId).session;
    switch (message.command) {
        case "prompt":
            await deliverPiAgentMessage(active, "prompt", requireMessage(message));
            return;
        case "steer":
            await deliverPiAgentMessage(active, "steer", requireMessage(message));
            return;
        case "followUp":
            await deliverPiAgentMessage(active, "followUp", requireMessage(message));
            return;
        case "abort":
            await active.abort();
            return;
        case "reload":
            if (active.isStreaming === true) throw new Error("Cannot reload a Pi Agent while a turn is active.");
            await active.reload();
            return;
    }
}

async function stopAgent(agentId: string): Promise<void> {
    const active = agents.get(agentId);
    if (active === undefined) return;
    agents.delete(agentId);
    try {
        await disposeManagedPiAgent(active, requireGui());
    } finally {
        try {
            await active.tools.close();
        } finally {
            toolSessions.delete(agentId);
        }
    }
}

async function shutdown(): Promise<void> {
    for (const agentId of [...agents.keys()]) {
        await stopAgent(agentId).catch(() => undefined);
    }
    await gui?.stop();
    gui = undefined;
    modelRuntime = undefined;
    sdk = undefined;
    toolSessions.clear();
}

function requireAgent(agentId: string): ManagedPiAgent {
    const active = agents.get(agentId);
    if (active !== undefined) return active;
    throw new Error(`Unknown Pi Agent: ${agentId}`);
}

function requireSdk(): PiSdkModule {
    if (sdk !== undefined) return sdk;
    throw new Error("Pi provider child is not initialized.");
}

function requireAgentDir(): string {
    if (agentDir !== undefined) return agentDir;
    throw new Error("Pi provider child has no state directory.");
}

function requireModelRuntime(): PiModelRuntimeLike {
    if (modelRuntime !== undefined) return modelRuntime;
    throw new Error("Pi provider child model runtime is not initialized.");
}

function requireGui(): PiGuiWeb {
    if (gui !== undefined) return gui;
    throw new Error("Pi provider child WebUI is not initialized.");
}

function requireMessage(message: PiChildAgentCommandMessage): string {
    if (typeof message.message === "string" && message.message.length > 0) return message.message;
    throw new Error(`${message.command} requires a message.`);
}

function sendFailure(message: PiParentMessage, error: unknown): void {
    const text = error instanceof Error ? error.message : String(error);
    if (message.type === "init") {
        send({ error: text, ok: false, type: "ready" });
        return;
    }
    if (message.type === "tool.result") return;
    send({ error: text, id: message.id, ok: false, type: "result" });
}

function send(message: object): void {
    process.send?.(message);
}
