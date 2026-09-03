import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createDevshellPiExtension } from "@portable-devshell/pi-extension";
import type { AgentTarget } from "@portable-devshell/shared";

import { PiGuiWeb } from "./PiGuiWeb.js";
import { PiSdkLoader, type PiModelRuntimeLike, type PiSdkModule, type PiSessionLike } from "./PiSdkLoader.js";
import type {
    PiChildAgentCommandMessage,
    PiChildAgentStartMessage,
    PiChildInitMessage,
    PiParentMessage
} from "./PiProcessProtocol.js";

interface ManagedPiAgent {
    localCwd: string;
    session: PiSessionLike;
    target: AgentTarget;
}

let agentDir: string | undefined;
const agents = new Map<string, ManagedPiAgent>();
let gui: PiGuiWeb | undefined;
let modelRuntime: PiModelRuntimeLike | undefined;
let sdk: PiSdkModule | undefined;

process.on("message", (value: unknown) => {
    const message = value as PiParentMessage;
    void handleMessage(message).catch((error) => sendFailure(message, error));
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
    process.env.PI_CODING_AGENT_DIR = input.agentDir;
    agentDir = input.agentDir;
    await mkdir(input.agentDir, { recursive: true });
    sdk = await new PiSdkLoader().load(input.entrypoint);
    modelRuntime = await sdk.ModelRuntime.create({
        authPath: join(input.agentDir, "auth.json"),
        modelsPath: join(input.agentDir, "models.json")
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

    const settingsManager = activeSdk.SettingsManager.create(input.localCwd, activeAgentDir);
    const devshellExtension = createDevshellPiExtension({
        autoStartControl: false,
        cwd: input.localCwd,
        target: input.target
    });
    const resourceLoader = new activeSdk.DefaultResourceLoader({
        agentDir: activeAgentDir,
        cwd: input.localCwd,
        extensionFactories: [devshellExtension],
        noExtensions: true,
        settingsManager,
        systemPromptOverride: (basePrompt: string | undefined) => appendRemoteWorkspacePrompt(
            basePrompt,
            `${input.target.instance}:${input.target.workspace}`
        )
    });
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
    const session = created.session;
    try {
        session.setSessionName?.(`${input.agentId} · ${input.target.instance}:${input.target.workspace}`);
        activeGui.attach(session, input.localCwd);
        agents.set(input.agentId, {
            localCwd: input.localCwd,
            session,
            target: { ...input.target }
        });
    } catch (error) {
        session.dispose();
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
            await active.prompt(requireMessage(message));
            return;
        case "steer":
            await active.prompt(requireMessage(message), { streamingBehavior: "steer" });
            return;
        case "followUp":
            await active.prompt(requireMessage(message), { streamingBehavior: "followUp" });
            return;
        case "abort":
            await active.abort();
            return;
    }
}

async function stopAgent(agentId: string): Promise<void> {
    const active = agents.get(agentId);
    if (active === undefined) return;
    agents.delete(agentId);
    await active.session.abort().catch(() => undefined);
    requireGui().detach(active.session);
    active.session.dispose();
}

async function shutdown(): Promise<void> {
    for (const agentId of [...agents.keys()]) {
        await stopAgent(agentId).catch(() => undefined);
    }
    await gui?.stop();
    gui = undefined;
    modelRuntime = undefined;
    sdk = undefined;
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

function appendRemoteWorkspacePrompt(basePrompt: string | undefined, remoteWorkspace: string): string {
    const devshellPrompt = [
        "portable-devshell execution environment:",
        `- The real project workspace is ${remoteWorkspace}.`,
        "- Your local process cwd is only Pi runtime state. It is not the project workspace.",
        "- Use the provided devshell tools for every project filesystem, shell, process, and artifact operation.",
        "- Do not attempt to access the project with local Node.js filesystem/process APIs.",
        "- Tool results come directly from devshell attached to the real project workspace."
    ].join("\n");
    return basePrompt === undefined || basePrompt.length === 0
        ? devshellPrompt
        : `${basePrompt}\n\n${devshellPrompt}`;
}

function sendFailure(message: PiParentMessage, error: unknown): void {
    const text = error instanceof Error ? error.message : String(error);
    if (message.type === "init") {
        send({ error: text, ok: false, type: "ready" });
        return;
    }
    send({ error: text, id: message.id, ok: false, type: "result" });
}

function send(message: object): void {
    process.send?.(message);
}
