import { randomUUID } from "node:crypto";

import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";

import { createDevshellPiExtension, type DevshellPiToolSession, type PiExtensionApiLike } from "../adapt/Bridge.js";
import type { PiAgentProfile } from "../profile/Profile.js";
import type { PiModelLike, PiModelRuntimeLike, PiSdkModule, PiSessionLike } from "../runtime/Sdk.js";
import {
    createPiChildAgentPath,
    PI_MAIN_AGENT_PATH,
    resolvePiAgentReference,
} from "./Namespace.js";
import {
    PiAgentRegistry,
    snapshot,
    type PiSubagentRecord,
    type PiSubagentSnapshot,
    type PiSubagentEvent,
} from "./Registry.js";

export interface PiSubagentGuiLike {
    attach(session: PiSessionLike, cwd: string): string;
    detach(session: PiSessionLike): void;
}

export interface PiAgentProfileCatalogLike {
    get(name: string): Promise<PiAgentProfile | undefined>;
    list(): Promise<readonly PiAgentProfile[]>;
}

export interface PiSubagentSpawnInput {
    fork?: boolean;
    name: string;
    profile?: string;
    task: string;
}

export interface PiSubagentPollInput {
    agents?: readonly string[];
    cursor?: number;
    timeoutMs?: number;
}

export interface PiSubagentPollResult {
    readonly agents: readonly PiSubagentSnapshot[];
    readonly cursor: number;
    readonly events: readonly PiSubagentEvent[];
    readonly main: {
        readonly activity: "idle" | "running";
        readonly agent: typeof PI_MAIN_AGENT_PATH;
        readonly lifecycle: "alive";
    };
    readonly timedOut: boolean;
}

export class PiSubagentRuntime {
    readonly #agentDir: string;
    readonly #gui: PiSubagentGuiLike;
    readonly #localCwd: string;
    readonly #modelRuntime: PiModelRuntimeLike;
    readonly #profiles: PiAgentProfileCatalogLike;
    readonly #registry = new PiAgentRegistry();
    readonly #sdk: PiSdkModule;
    readonly #tools: DevshellPiToolSession;
    #main?: PiSessionLike;

    constructor(options: {
        agentDir: string;
        gui: PiSubagentGuiLike;
        localCwd: string;
        modelRuntime: PiModelRuntimeLike;
        profiles: PiAgentProfileCatalogLike;
        sdk: PiSdkModule;
        tools: DevshellPiToolSession;
    }) {
        this.#agentDir = options.agentDir;
        this.#gui = options.gui;
        this.#localCwd = options.localCwd;
        this.#modelRuntime = options.modelRuntime;
        this.#profiles = options.profiles;
        this.#sdk = options.sdk;
        this.#tools = options.tools;
    }

    bindMain(session: PiSessionLike): void {
        if (this.#main !== undefined)
            throw new Error("Pi subagent runtime is already bound to /root/main.");
        this.#main = session;
    }

    async listProfiles(): Promise<readonly PiAgentProfile[]> {
        return await this.#profiles.list();
    }

    async spawn(input: PiSubagentSpawnInput): Promise<PiSubagentSnapshot> {
        if (input.fork === true)
            throw new Error("agent_spawn fork=true is not supported yet.");
        const path = createPiChildAgentPath(input.name);
        if (this.#registry.has(path))
            throw new Error(`Agent already exists: ${path}.`);
        const profile =
            input.profile === undefined
                ? undefined
                : await this.#profiles.get(input.profile);
        if (input.profile !== undefined && profile === undefined) {
            const available = (await this.#profiles.list())
                .map((entry) => entry.name)
                .join(", ");
            throw new Error(
                `Unknown Agent profile: ${input.profile}. Available: ${available || "none"}.`,
            );
        }
        const model = await this.#resolveModel(profile);
        const settingsManager = this.#sdk.SettingsManager.create(
            this.#localCwd,
            this.#agentDir,
        );
        const resourceLoader = new this.#sdk.DefaultResourceLoader({
            agentDir: this.#agentDir,
            cwd: this.#localCwd,
            extensionFactories: [
                {
                    factory: profiledExtension(this.#tools, profile),
                    hidden: true,
                    name: "portable-devshell-subagent",
                },
            ],
            settingsManager,
        });
        await resourceLoader.reload();
        const sessionManager = this.#sdk.SessionManager.create(this.#localCwd);
        const main = this.#requireMain();
        const created = await this.#sdk.createAgentSession({
            agentDir: this.#agentDir,
            cwd: this.#localCwd,
            ...(model === undefined ? {} : { model }),
            ...(typeof main.agent?.state?.thinkingLevel === "string"
                ? { thinkingLevel: main.agent.state.thinkingLevel }
                : {}),
            modelRuntime: this.#modelRuntime,
            noTools: "builtin",
            resourceLoader,
            sessionManager,
            settingsManager,
        });
        const session = created.session;
        session.setSessionName?.(path);
        this.#gui.attach(session, this.#localCwd);
        const record: PiSubagentRecord = {
            activity: "running",
            id: randomUUID(),
            lifecycle: "alive",
            model: model === undefined ? modelName(main.agent?.state?.model) : modelName(model),
            name: input.name,
            path,
            ...(profile === undefined ? {} : { profile: profile.name }),
            session,
            task: input.task,
            turnGeneration: 0,
        };
        record.unsubscribe = session.subscribe?.((event) =>
            this.#observe(record, event),
        );
        this.#registry.add(record);
        this.#startTurn(record, input.task);
        return snapshot(record);
    }

    async poll(
        input: PiSubagentPollInput = {},
        signal?: AbortSignal,
    ): Promise<PiSubagentPollResult> {
        if (this.#registry.records().length === 0)
            throw new Error("No subagents exist under /root/main.");
        const paths = new Set<string>([PI_MAIN_AGENT_PATH]);
        if (input.agents === undefined || input.agents.length === 0) {
            for (const path of this.#registry.paths()) paths.add(path);
        } else {
            for (const reference of input.agents) {
                const path = resolvePiAgentReference(reference);
                if (path !== PI_MAIN_AGENT_PATH) this.#registry.require(path);
                paths.add(path);
            }
        }
        const snapshots = this.#registry.snapshots(paths);
        const cursor = input.cursor ?? this.#registry.cursor;
        const completedNow =
            input.cursor === undefined &&
            snapshots.some(
                (agent) =>
                    agent.lifecycle === "terminated" ||
                    (agent.activity === "idle" && agent.lastTurn !== undefined),
            );
        let events = this.#registry.eventsAfter(cursor, paths);
        let timedOut = false;
        if (!completedNow && events.length === 0) {
            const timeoutMs = clampTimeout(input.timeoutMs);
            const woke = await this.#registry.waitForEvent(
                cursor,
                paths,
                timeoutMs,
                signal,
            );
            timedOut = !woke;
            events = this.#registry.eventsAfter(cursor, paths);
        }
        return {
            agents: this.#registry.snapshots(paths),
            cursor: this.#registry.cursor,
            events,
            main: {
                activity: this.#requireMain().isStreaming ? "running" : "idle",
                agent: PI_MAIN_AGENT_PATH,
                lifecycle: "alive",
            },
            timedOut,
        };
    }

    async interact(input: {
        agent: string;
        interrupt?: boolean;
        message: string;
    }): Promise<PiSubagentSnapshot> {
        const record = this.#registry.require(input.agent);
        this.#assertAlive(record);
        if (input.interrupt === true && record.activity === "running") {
            ++record.turnGeneration;
            await record.session.abort();
            await record.session.waitForIdle().catch(() => undefined);
            record.activity = "idle";
            record.lastTurn = { outcome: "interrupted" };
            this.#registry.emit(record.path, "interrupted");
        }
        if (record.activity === "running") {
            await record.session.followUp(input.message);
            this.#registry.emit(record.path, "activity", "follow-up queued");
        } else {
            this.#startTurn(record, input.message);
        }
        return snapshot(record);
    }

    async manage(input: {
        action: "interrupt" | "terminate";
        agent: string;
    }): Promise<PiSubagentSnapshot> {
        const record = this.#registry.require(input.agent);
        if (input.action === "interrupt") {
            this.#assertAlive(record);
            if (record.activity === "running") {
                ++record.turnGeneration;
                await record.session.abort();
                await record.session.waitForIdle().catch(() => undefined);
                record.activity = "idle";
                record.lastTurn = { outcome: "interrupted" };
                this.#registry.emit(record.path, "interrupted");
            }
            return snapshot(record);
        }
        if (record.lifecycle === "terminated") return snapshot(record);
        ++record.turnGeneration;
        if (record.activity === "running")
            await record.session.abort().catch(() => undefined);
        record.unsubscribe?.();
        this.#gui.detach(record.session);
        record.session.dispose();
        record.lifecycle = "terminated";
        record.activity = "idle";
        record.lastActivity = undefined;
        this.#registry.emit(record.path, "terminated");
        return snapshot(record);
    }

    notifyMainInput(): void {
        this.#registry.emit(PI_MAIN_AGENT_PATH, "input");
    }

    async close(): Promise<void> {
        for (const record of this.#registry.records()) {
            if (record.lifecycle === "terminated") continue;
            await this.manage({ action: "terminate", agent: record.path }).catch(
                () => undefined,
            );
        }
    }

    #assertAlive(record: PiSubagentRecord): void {
        if (record.lifecycle !== "alive")
            throw new Error(`Agent is terminated: ${record.path}.`);
    }

    #requireMain(): PiSessionLike {
        if (this.#main === undefined)
            throw new Error("Pi subagent runtime is not bound to /root/main.");
        return this.#main;
    }

    async #resolveModel(profile: PiAgentProfile | undefined): Promise<PiModelLike | undefined> {
        const candidates = profile?.candidateModels ?? [];
        if (candidates.length === 0) {
            const inherited = this.#requireMain().agent?.state?.model;
            return isModel(inherited) ? inherited : undefined;
        }
        for (const candidate of candidates) {
            const model = findModel(this.#modelRuntime, candidate);
            if (model === undefined) continue;
            const auth = await this.#modelRuntime.checkAuth(model.provider).catch(
                () => undefined,
            );
            if (auth !== undefined) return model;
        }
        throw new Error(
            `No configured model is available for profile ${profile?.name ?? "unknown"}: ${candidates.join(", ")}.`,
        );
    }

    #startTurn(record: PiSubagentRecord, message: string): void {
        this.#assertAlive(record);
        const generation = ++record.turnGeneration;
        record.activity = "running";
        record.task = message;
        record.lastActivity = undefined;
        this.#registry.emit(record.path, "activity", "running");
        void record.session.prompt(message).then(
            () => {
                if (
                    record.lifecycle !== "alive" ||
                    generation !== record.turnGeneration
                )
                    return;
                record.activity = "idle";
                record.lastActivity = undefined;
                record.lastTurn = {
                    outcome: "completed",
                    result: finalAssistantText(record.session),
                };
                this.#registry.emit(
                    record.path,
                    "completed",
                    record.lastTurn.result,
                );
            },
            (error: unknown) => {
                if (
                    record.lifecycle !== "alive" ||
                    generation !== record.turnGeneration
                )
                    return;
                record.activity = "idle";
                record.lastActivity = undefined;
                record.lastTurn = {
                    error: error instanceof Error ? error.message : String(error),
                    outcome: "failed",
                };
                this.#registry.emit(
                    record.path,
                    "failed",
                    record.lastTurn.error,
                );
            },
        );
    }

    #observe(record: PiSubagentRecord, value: unknown): void {
        if (record.lifecycle !== "alive") return;
        const event = asRecord(value);
        if (event?.type !== "tool_execution_start") return;
        const toolName =
            typeof event.toolName === "string"
                ? event.toolName
                : typeof event.name === "string"
                  ? event.name
                  : undefined;
        if (toolName === undefined) return;
        record.lastActivity = toolName;
        this.#registry.emit(record.path, "activity", toolName);
    }
}

function profiledExtension(
    tools: DevshellPiToolSession,
    profile: PiAgentProfile | undefined,
): (pi: PiExtensionApiLike) => Promise<void> {
    const base = createDevshellPiExtension(tools, {
        closeSessionOnShutdown: false,
    });
    return async (pi) => {
        await base(pi);
        if (profile === undefined) return;
        pi.on("before_agent_start", (event: BeforeAgentStartEvent) => ({
            systemPrompt: `${event.systemPrompt}\n\n<agent_profile name="${profile.name}">\n${profile.prompt}\n</agent_profile>`,
        }));
    };
}

function clampTimeout(value: number | undefined): number {
    if (value === undefined) return 30_000;
    if (!Number.isFinite(value)) return 30_000;
    return Math.max(0, Math.min(60_000, Math.floor(value)));
}

function findModel(runtime: PiModelRuntimeLike, candidate: string): PiModelLike | undefined {
    const slash = candidate.indexOf("/");
    if (slash > 0 && slash < candidate.length - 1) {
        return runtime.getModel(candidate.slice(0, slash), candidate.slice(slash + 1));
    }
    return runtime
        .getModels()
        .find((model) => model.id === candidate || model.name === candidate);
}

function isModel(value: unknown): value is PiModelLike {
    const record = asRecord(value);
    return typeof record?.id === "string" && typeof record.provider === "string";
}

function modelName(value: unknown): string | undefined {
    return isModel(value) ? `${value.provider}/${value.id}` : undefined;
}

function finalAssistantText(session: PiSessionLike): string {
    const messages = session.agent?.state?.messages;
    if (!Array.isArray(messages)) return "";
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = asRecord(messages[index]);
        if (message?.role !== "assistant" || !Array.isArray(message.content))
            continue;
        const text = message.content.flatMap((part) => {
            const record = asRecord(part);
            return record?.type === "text" && typeof record.text === "string"
                ? [record.text]
                : [];
        });
        if (text.length > 0) return text.join("\n");
    }
    return "";
}

function asRecord(value: unknown): Record<string, any> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, any>)
        : undefined;
}
