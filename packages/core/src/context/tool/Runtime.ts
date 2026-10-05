import type { ToolCallHooks } from "../../toolcall/Public.js";
import {
    contextErrorCodes,
    controlErrorCodes,
    createRemoteError,
    runtimeErrorCodes,
    type JsonValue,
    type ContextRecord,
    type ToolCallContext,
    type ToolCallExternalBinding,
} from "@portable-devshell/shared";

import type { ContextApi } from "../Api.js";
import type {
    ContextInstanceLeasePort,
    ContextInstancesPort,
} from "../Port.js";
import {
    environmentInfoToolName,
    remoteEnvironmentToolName,
} from "./Definition.js";
import {
    readEnvironmentInfoInput,
    readRemoteEnvironmentInput,
} from "./Input.js";

export function installContextTools(
    contexts: ContextApi,
    hooks: ToolCallHooks,
    options: {
        instances: ContextInstancesPort;
        modelCommands?(instance: string): readonly string[];
    },
): () => void {
    const runtime = new ContextToolRuntime(contexts, options);
    const unregisterInfo = hooks.registerExecute(
        environmentInfoToolName,
        async (_callId, input, value, signal) =>
            await runtime.environmentInfo(input, value.context, signal),
    );
    const unregisterRemote = hooks.registerExecute(
        remoteEnvironmentToolName,
        async (_callId, input, value, signal) =>
            await runtime.remoteEnvironment(input, value.context, signal),
    );
    return () => {
        unregisterRemote();
        unregisterInfo();
    };
}

class ContextToolRuntime {
    readonly #contexts: ContextApi;
    readonly #instances: ContextInstancesPort;
    readonly #modelCommands: (instance: string) => readonly string[];

    constructor(
        contexts: ContextApi,
        options: {
            instances: ContextInstancesPort;
            modelCommands?(instance: string): readonly string[];
        },
    ) {
        this.#contexts = contexts;
        this.#instances = options.instances;
        this.#modelCommands = options.modelCommands ?? (() => []);
    }

    async environmentInfo(
        input: JsonValue,
        context: ToolCallContext & { instance: string },
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        const allowContextId = context.contextMode !== "openai-session";
        const parsed = readEnvironmentInfoInput(input, allowContextId);
        let resolution = await this.#resolveContext(
            {
                ...((parsed.ctxId ?? context.ctxId) === undefined
                    ? {}
                    : { ctxId: parsed.ctxId ?? context.ctxId }),
                ...((parsed.workspace ?? context.workspace) === undefined
                    ? {}
                    : { workspace: parsed.workspace ?? context.workspace }),
            },
            context,
            false,
        );
        let record = resolution.record;
        const workspace =
            parsed.workspace ??
            context.workspace ??
            contextWorkspace(record, context.instance);
        if (workspace === undefined)
            throw contextWorkspaceRequired(record.ctxId, context.instance);

        let committed = false;
        let alertCleanupWorkspace: string | undefined;
        try {
            await this.#contexts.cleanup.reconcile(record.ctxId);
            if (!resolution.created) {
                record = await this.#touchContext(record, context);
                resolution = { ...resolution, record };
            }

            const generation = this.#requireGeneration(context.instance);
            try {
                const worker = generation.instance.worker;
                const handshake = worker.handshake;
                if (handshake === undefined)
                    throw createRemoteError({
                        code: runtimeErrorCodes.workerHandshakeFailed,
                        details: { instance: context.instance },
                        message: `Worker handshake is unavailable for ${context.instance}.`,
                        retryable: true,
                    });
                if (worker.prepareExtensionResource === undefined)
                    throw createRemoteError({
                        code: runtimeErrorCodes.workerHandshakeFailed,
                        details: { instance: context.instance },
                        message: `Extension resource preparation is unavailable for ${context.instance}.`,
                        retryable: true,
                    });
                if (worker.readAlerts === undefined)
                    throw createRemoteError({
                        code: runtimeErrorCodes.workerHandshakeFailed,
                        details: { instance: context.instance },
                        message: `Alert reading is unavailable for ${context.instance}.`,
                        retryable: true,
                    });

                let skillsDirectory = "";
                let alerts: Array<{ code: string; text: string }> = [];
                const prepared = await this.#contexts.environment.prepareLocal(
                    record.ctxId,
                    context.instance,
                    workspace,
                    {
                        ...(resolution.bindings.length === 0
                            ? {}
                            : {
                                  external: {
                                      bindings: resolution.bindings,
                                      principal: this.#principal(context),
                                  },
                              }),
                        beforeCommit: async (facts) => {
                            skillsDirectory = (
                                await worker.prepareExtensionResource!({
                                    collection: "managed",
                                    extensionId: "skill",
                                })
                            ).directory;
                            alertCleanupWorkspace = facts.workspace;
                            alerts = (await worker.readAlerts!(facts.workspace))
                                .advice;
                        },
                        signal,
                    },
                );
                committed = true;
                await this.#contexts.cleanup.reconcile(record.ctxId);
                return {
                    ...this.#expose(record, context),
                    comment: [
                        ...(prepared.projectMemoryPresent !== false
                            ? [
                                  `Read ${prepared.projectMemoryAgentFile} before resuming existing work; for a selected task, treat its state.json as authoritative.`,
                              ]
                            : []),
                        `Use ${prepared.workspace}/var/agent-work/ for durable task memory; keep INDEX.md as the task index and each task's state.json as authoritative current state.`,
                        `Use ${prepared.temporaryDirectory} only for small disposable temporary files; temporary storage is limited to 2 GiB per workspace.`,
                        `Put large working data and anything that must persist in ${prepared.workspace}/var/.`,
                        ...modelDevshellComments(
                            this.#modelCommands(context.instance),
                        ),
                        ...alerts.map((advice) => advice.text),
                    ],
                    expiresAt: record.expiresAt,
                    instance: context.instance,
                    platform: {
                        arch: handshake.platform.arch,
                        ...(handshake.platform.distribution === undefined
                            ? {}
                            : {
                                  distribution: handshake.platform.distribution,
                              }),
                        os: handshake.platform.os,
                        ...(handshake.platform.packageManager === undefined
                            ? {}
                            : {
                                  packageManager:
                                      handshake.platform.packageManager,
                              }),
                        ...(handshake.platform.shell === undefined
                            ? {}
                            : { shell: handshake.platform.shell.kind }),
                    },
                    ...(prepared.projectMemoryPresent !== false
                        ? {
                              projectMemoryAgentFile:
                                  prepared.projectMemoryAgentFile,
                              projectMemoryDirectory:
                                  prepared.projectMemoryDirectory,
                          }
                        : {}),
                    remoteEnvironment: {
                        commands: remoteEnvironmentCommandHints(),
                    },
                    skillsDirectory,
                    status: record.status,
                    temporaryDirectory: prepared.temporaryDirectory,
                    workspace: prepared.workspace,
                };
            } finally {
                generation.release();
            }
        } catch (error) {
            const failures: unknown[] = [];
            if (resolution.created) {
                await this.#contexts.environment
                    .rollbackUndisclosed(
                        record.ctxId,
                        context.instance,
                        committed ? alertCleanupWorkspace : undefined,
                    )
                    .catch((cleanupError) => failures.push(cleanupError));
            } else if (committed) {
                throw error;
            }
            if (failures.length > 0)
                throw new AggregateError(
                    [error, ...failures],
                    `Environment preparation failed and cleanup was incomplete for ${record.ctxId}.`,
                );
            throw error;
        }
    }

    async remoteEnvironment(
        input: JsonValue,
        context: ToolCallContext & { instance: string },
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        const allowContextId = context.contextMode !== "openai-session";
        const parsed = readRemoteEnvironmentInput(input, allowContextId);
        let resolution = await this.#resolveContext(
            (parsed.ctxId ?? context.ctxId) === undefined
                ? {}
                : { ctxId: parsed.ctxId ?? context.ctxId },
            context,
            false,
        );
        let record = resolution.record;
        if (!resolution.created) {
            record = await this.#touchContext(record, context);
            resolution = { ...resolution, record };
        }
        const base = this.#expose(record, context);
        switch (parsed.command) {
            case "help":
                assertRemoteArguments(parsed, {
                    handle: false,
                    workspace: false,
                });
                return {
                    ...base,
                    command: "help",
                    details: { commands: remoteEnvironmentCommandCatalog() },
                    message: "Current environ_remote command catalog.",
                };
            case "attach": {
                assertRemoteArguments(parsed, {
                    handle: true,
                    workspace: "optional",
                });
                const details = await this.#contexts.environment.attachRemote(
                    record.ctxId,
                    parsed.handle!,
                    parsed.workspace,
                    signal,
                );
                return {
                    ...base,
                    command: "attach",
                    details: isJsonRecord(details)
                        ? details
                        : { result: details },
                    message:
                        "Remote environment attached to the current Context.",
                };
            }
            case "mask": {
                assertRemoteArguments(parsed, {
                    handle: true,
                    workspace: false,
                });
                return {
                    ...base,
                    command: "mask",
                    details: await this.#contexts.environment.maskRemote(
                        record.ctxId,
                        parsed.handle!,
                    ),
                    message:
                        "Remote instance is permanently masked for the lifetime of the current Context.",
                };
            }
            default:
                throw createRemoteError({
                    code: controlErrorCodes.invalidTarget,
                    message: `Unknown environ_remote command ${JSON.stringify(parsed.command)}. Use command='help' for the current command catalog.`,
                    retryable: false,
                });
        }
    }

    async #resolveContext(
        input: { ctxId?: string; workspace?: string },
        context: ToolCallContext & { instance: string },
        touch = true,
    ): Promise<{
        bindings: readonly ToolCallExternalBinding[];
        created: boolean;
        record: ContextRecord;
    }> {
        const principal = this.#principal(context);
        if (input.ctxId !== undefined) {
            if (context.contextMode === "openai-session")
                throw createRemoteError({
                    code: contextErrorCodes.invalid,
                    message:
                        "ctxId is internal when Context authority is externally bound.",
                    retryable: false,
                });
            const record = await this.#contexts.registry.lookup(input.ctxId, {
                principal,
            });
            if (record.status === "disabled")
                await this.#contexts.registry.validate(record.ctxId, {
                    principal,
                });
            return {
                bindings: [],
                created: false,
                record: touch
                    ? await this.#touchContext(record, context)
                    : record,
            };
        }

        const bindings = context.externalBindings ?? [];
        let bound: ContextRecord | undefined;
        for (const binding of bindings) {
            const candidate = await this.#contexts.registry.lookupExternal(
                binding,
                { principal },
            );
            if (candidate === undefined) continue;
            if (bound !== undefined && bound.ctxId !== candidate.ctxId)
                throw conflictingExternalBindings();
            bound = candidate;
        }
        if (bound !== undefined && bound.status !== "disabled") {
            return {
                bindings,
                created: false,
                record: touch
                    ? await this.#touchContext(bound, context)
                    : bound,
            };
        }
        if (bound?.status === "disabled")
            await this.#contexts.registry.validate(bound.ctxId, { principal });

        if (input.workspace === undefined)
            throw unboundContext(context.contextMode !== "openai-session");
        return {
            bindings,
            created: true,
            record: await this.#contexts.registry.create({
                environments: [{ instance: context.instance }],
                principal,
            }),
        };
    }

    async #touchContext(
        record: ContextRecord,
        context: ToolCallContext,
    ): Promise<ContextRecord> {
        const principal = this.#principal(context);
        return record.status === "expired"
            ? await this.#contexts.registry.renewForPrincipal(record.ctxId, {
                  principal,
              })
            : await this.#contexts.registry.validateAndTouch(record.ctxId, {
                  principal,
              });
    }

    #expose(
        record: ContextRecord,
        context: ToolCallContext,
    ): Record<string, JsonValue> {
        return context.contextMode === "openai-session"
            ? {}
            : { ctxId: record.ctxId };
    }

    #principal(context: ToolCallContext): string {
        return context.principal ?? "local";
    }

    #requireGeneration(instance: string): ContextInstanceLeasePort {
        const target = this.#instances.get(instance);
        if (target === undefined) {
            throw createRemoteError({
                code: runtimeErrorCodes.instanceNotReady,
                details: { instance },
                message: `Instance ${instance} is unavailable.`,
                retryable: false,
            });
        }
        try {
            return target.acquireLease();
        } catch {
            throw createRemoteError({
                code: runtimeErrorCodes.instanceNotReady,
                details: { instance },
                message: `Instance ${instance} is unavailable.`,
                retryable: false,
            });
        }
    }
}

function contextWorkspace(
    record: ContextRecord,
    instance: string,
): string | undefined {
    return record.environments.find(
        (environment) => environment.instance === instance,
    )?.workspace;
}

function contextWorkspaceRequired(ctxId: string, instance: string) {
    return createRemoteError({
        code: contextErrorCodes.workspaceRequired,
        details: { ctxId, instance },
        message: `No workspace is attached to ${instance} for ${ctxId}. Use environ_remote command='attach' with its handle and an absolute workspace.`,
        retryable: false,
    });
}

function conflictingExternalBindings() {
    return createRemoteError({
        code: contextErrorCodes.invalid,
        message:
            "Stable external identities on this request resolve to different Contexts.",
        retryable: false,
    });
}

function unboundContext(requireExplicitContextId: boolean) {
    return createRemoteError({
        code: contextErrorCodes.invalid,
        message: requireExplicitContextId
            ? "No Context is bound to this request. Call environ_info with workspace or provide ctxId."
            : "No Context is bound to this request. Call environ_info with workspace.",
        retryable: false,
    });
}

function modelDevshellComments(commands: readonly string[]): string[] {
    if (commands.length === 0) return [];
    return [
        `Model devshell commands available through bash_run/tmux_run: ${commands.join(", ")}.`,
        "Use devshell --help or devshell <command> --help to inspect the allowed model command surface.",
    ];
}

function remoteEnvironmentCommandHints(): string[] {
    return ["help", "attach handle [workspace]", "mask handle"];
}

function remoteEnvironmentCommandCatalog(): JsonValue[] {
    return [
        {
            command: "help",
            summary:
                "Return the authoritative current environ_remote command catalog.",
            usage: "help",
        },
        {
            command: "attach",
            summary:
                "Attach a remote managed instance and optional absolute workspace to the current Context.",
            usage: "attach handle [workspace]",
        },
        {
            command: "mask",
            summary:
                "Permanently hide a remote instance from this Context and revoke any existing attachment.",
            usage: "mask handle",
        },
    ];
}

function assertRemoteArguments(
    input: { handle?: string; workspace?: string },
    expected: { handle: boolean; workspace: boolean | "optional" },
): void {
    if (expected.handle && input.handle === undefined)
        throw invalidRemoteArguments(
            "This environ_remote command requires handle.",
        );
    if (!expected.handle && input.handle !== undefined)
        throw invalidRemoteArguments(
            "handle is not valid for this environ_remote command.",
        );
    if (expected.workspace === false && input.workspace !== undefined)
        throw invalidRemoteArguments(
            "workspace is not valid for this environ_remote command.",
        );
}

function invalidRemoteArguments(message: string) {
    return createRemoteError({
        code: controlErrorCodes.invalidTarget,
        message: `${message} Use command='help' for the current command catalog.`,
        retryable: false,
    });
}

function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
