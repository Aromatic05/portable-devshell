import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { JsonValue } from "@portable-devshell/shared";

import { PiSdkLoader, type PiSessionLike } from "./PiSdkLoader.js";
import { PiAgentWebServer } from "./PiAgentWebServer.js";
import { createPiWorkerToolsFromDefinitions } from "./PiWorkerTools.js";
import type {
    PiChildCommandMessage,
    PiChildInitMessage,
    PiChildToolResultMessage,
    PiParentMessage
} from "./PiProcessProtocol.js";

let session: PiSessionLike | undefined;
let webServer: PiAgentWebServer | undefined;
const toolResults = new Map<string, {
    reject(error: Error): void;
    resolve(value: JsonValue): void;
}>();

process.on("message", (value: unknown) => {
    void handleMessage(value as PiParentMessage).catch((error) => {
        send({
            error: error instanceof Error ? error.message : String(error),
            ok: false,
            type: "ready"
        });
    });
});

async function handleMessage(message: PiParentMessage): Promise<void> {
    switch (message.type) {
        case "init":
            send({ ok: true, type: "ready", webUpstream: (await initialize(message)).toString() });
            return;
        case "command":
            await handleCommand(message);
            return;
        case "tool.result":
            settleToolResult(message);
            return;
    }
}

async function initialize(input: PiChildInitMessage): Promise<URL> {
    if (session !== undefined) throw new Error("Pi Agent child is already initialized.");
    await Promise.all([
        mkdir(input.agentDir, { recursive: true }),
        mkdir(input.localCwd, { recursive: true }),
        mkdir(input.sessionDir, { recursive: true })
    ]);
    const sdk = await new PiSdkLoader().load(input.entrypoint);
    const modelRuntime = await sdk.ModelRuntime.create({
        authPath: join(input.agentDir, "auth.json"),
        modelsPath: join(input.agentDir, "models.json")
    });
    const settingsManager = sdk.SettingsManager.create(input.localCwd, input.agentDir);
    const resourceLoader = new sdk.DefaultResourceLoader({
        agentDir: input.agentDir,
        cwd: input.localCwd,
        settingsManager,
        systemPromptOverride: (basePrompt: string | undefined) => appendRemoteWorkspacePrompt(
            basePrompt,
            input.remoteWorkspace
        )
    });
    await resourceLoader.reload();
    const customTools = createPiWorkerToolsFromDefinitions(input.tools, executeTool);
    const sessionManager = sdk.SessionManager.create(input.localCwd, input.sessionDir);
    const created = await sdk.createAgentSession({
        agentDir: input.agentDir,
        customTools,
        cwd: input.localCwd,
        modelRuntime,
        noTools: "builtin",
        resourceLoader,
        sessionManager,
        settingsManager,
        tools: customTools.map((tool) => tool.name)
    });
    session = created.session;
    webServer = new PiAgentWebServer({ modelRuntime, session, settingsManager });
    return await webServer.start();
}

async function handleCommand(message: PiChildCommandMessage): Promise<void> {
    try {
        const active = requireSession();
        switch (message.command) {
            case "prompt":
                await active.prompt(requireMessage(message));
                break;
            case "steer":
                await active.prompt(requireMessage(message), { streamingBehavior: "steer" });
                break;
            case "followUp":
                await active.prompt(requireMessage(message), { streamingBehavior: "followUp" });
                break;
            case "abort":
                await active.abort();
                break;
            case "stop":
                await active.abort().catch(() => undefined);
                await webServer?.stop().catch(() => undefined);
                webServer = undefined;
                active.dispose();
                session = undefined;
                break;
        }
        send({ id: message.id, ok: true, type: "command.result" });
        if (message.command === "stop") {
            setImmediate(() => process.exit(0));
        }
    } catch (error) {
        send({
            error: error instanceof Error ? error.message : String(error),
            id: message.id,
            ok: false,
            type: "command.result"
        });
    }
}

async function executeTool(
    toolCallId: string,
    definition: { name: string },
    input: JsonValue,
    signal?: AbortSignal
): Promise<JsonValue> {
    const requestId = randomUUID();
    const result = new Promise<JsonValue>((resolve, reject) => {
        toolResults.set(requestId, { resolve, reject });
    });
    const abort = () => send({ requestId, type: "tool.cancel" });
    signal?.addEventListener("abort", abort, { once: true });
    try {
        send({ input, requestId, toolCallId, toolName: definition.name, type: "tool.call" });
        return await result;
    } finally {
        signal?.removeEventListener("abort", abort);
        toolResults.delete(requestId);
    }
}

function settleToolResult(message: PiChildToolResultMessage): void {
    const pending = toolResults.get(message.requestId);
    if (pending === undefined) return;
    toolResults.delete(message.requestId);
    if (message.ok && message.result !== undefined) pending.resolve(message.result);
    else if (message.ok) pending.resolve({});
    else pending.reject(new Error(message.error ?? "Worker tool call failed."));
}

function requireSession(): PiSessionLike {
    if (session !== undefined) return session;
    throw new Error("Pi Agent child is not initialized.");
}

function requireMessage(message: PiChildCommandMessage): string {
    if (typeof message.message === "string" && message.message.length > 0) return message.message;
    throw new Error(`${message.command} requires a message.`);
}

function appendRemoteWorkspacePrompt(basePrompt: string | undefined, remoteWorkspace: string): string {
    const devshellPrompt = [
        "portable-devshell execution environment:",
        `- The real project workspace is ${remoteWorkspace}.`,
        "- Your local process cwd is only Pi runtime state. It is not the project workspace.",
        "- Use the provided devshell Worker tools for every project filesystem, shell, process, and artifact operation.",
        "- Do not attempt to access the project with local Node.js filesystem/process APIs.",
        "- Tool results come directly from the Worker attached to the real project workspace."
    ].join("\n");
    return basePrompt === undefined || basePrompt.length === 0
        ? devshellPrompt
        : `${basePrompt}\n\n${devshellPrompt}`;
}

function send(message: object): void {
    process.send?.(message);
}
