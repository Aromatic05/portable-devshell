import type { ToolCallRegistration } from "@portable-devshell/shared";
import {
    contextErrorCodes, controlErrorCodes, createRemoteError, runtimeErrorCodes, type EnvironmentTransport, type JsonValue, type ProcessTransport, type ContextRecord, type ToolCallContext, type ToolCallExternalBinding, } from "@portable-devshell/shared";
import type { ContextApi } from "../Api.js";
import {
    contextToolDefinitions,
    environmentInfoToolName,
    remoteEnvironmentToolName,
} from "./Definition.js";
import {
    readEnvironmentInfoInput,
    readRemoteEnvironmentInput,
} from "./Input.js";

type CurrentMemory = {
    name: string;
    directory: string;
    mailbox: string;
};

export function installContextTools(
    contexts: ContextApi,
    hooks: ToolCallRegistration,
    options: {
        environment(instance: string): EnvironmentTransport;
        leaseInstance(instance: string): { release(): void };
        memory?(ctxId: string, instance: string, workspace: string, signal?: AbortSignal): Promise<CurrentMemory | undefined>;
        modelCommands?(instance: string): readonly string[];
        process(instance: string): ProcessTransport;
    },
): () => void {
    const runtime = new ContextToolRuntime(contexts, options);
    const unregisterDefinitions = contextToolDefinitions().map((definition) =>
        hooks.registerToolName(definition.name, () => definition),
    );
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
        for (const unregister of unregisterDefinitions.reverse()) unregister();
    };
}

class ContextToolRuntime {
    readonly #contexts: ContextApi;
    readonly #environment: (instance: string) => EnvironmentTransport;
    readonly #leaseInstance: (instance: string) => { release(): void };
    readonly #memory?: (ctxId: string, instance: string, workspace: string, signal?: AbortSignal) => Promise<CurrentMemory | undefined>;
    readonly #modelCommands: (instance: string) => readonly string[];
    readonly #process: (instance: string) => ProcessTransport;

    constructor(
        contexts: ContextApi,
        options: {
            environment(instance: string): EnvironmentTransport;
            leaseInstance(instance: string): { release(): void };
            memory?(ctxId: string, instance: string, workspace: string, signal?: AbortSignal): Promise<CurrentMemory | undefined>;
            modelCommands?(instance: string): readonly string[];
            process(instance: string): ProcessTransport;
        },
    ) {
        this.#contexts = contexts;
        this.#environment = options.environment;
        this.#leaseInstance = options.leaseInstance;
        this.#memory = options.memory;
        this.#modelCommands = options.modelCommands ?? (() => []);
        this.#process = options.process;
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
                const process = await this.#process(context.instance).snapshot();
                const worker = process.worker;
                if (worker === undefined)
                    throw createRemoteError({
                        code: runtimeErrorCodes.workerHandshakeFailed,
                        details: { instance: context.instance },
                        message: `Worker handshake is unavailable for ${context.instance}.`,
                        retryable: true,
                    });

                let skillsDirectory = "";
                let alerts: Array<{ code: string; text: string }> = [];
                const environment = this.#environment(context.instance);
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
                                await environment.prepareExtensionResource({
                                    collection: "managed",
                                    extensionId: "skill",
                                })
                            ).directory;
                            alertCleanupWorkspace = facts.workspace;
                            alerts = (await environment.readAlerts(facts.workspace))
                                .advice;
                        },
                        signal,
                    },
                );
                committed = true;
                await this.#contexts.cleanup.reconcile(record.ctxId);
                const memoryLookup = await readOptionalMemory(
                    this.#memory,
                    record.ctxId,
                    context.instance,
                    prepared.workspace,
                    signal,
                );
                const memoryUnavailable = memoryLookup === "unavailable";
                const memory = memoryUnavailable ? undefined : memoryLookup;
                return {
                    ...this.#expose(record, context),
                    comment: [
                        ...(memory === undefined && prepared.projectMemoryPresent !== false
                            ? [
                                  `Existing work index: ${prepared.projectMemoryAgentFile}. Consult it when looking for previous work; it is not the current Context's Memory binding.`,
                              ]
                            : []),
                        ...(memory === undefined ? [] : [
                            `Current Memory: ${memory.directory} (${memory.name}). Reuse this directory; do not initialize another Memory for this Context.`,
                        ]),
                        ...(memoryUnavailable ? [
                            "Current Context Memory status is temporarily unavailable. The shared project work index is not proof that Memory is unclaimed. Do not initialize, inherit or create a Memory directory until status is available again.",
                        ] : []),
                        `Use ${prepared.temporaryDirectory} only for small disposable temporary files; temporary storage is limited to 2 GiB per workspace.`,
                        `Put large working data and anything that must persist in ${prepared.workspace}/var/.`,
                        ...modelDevshellComments(
                            this.#modelCommands(context.instance),
                        ),
                        ...alerts.map((advice) => advice.text),
                    ],
                    expiresAt: record.expiresAt,
                    instance: context.instance,
                    modelCommands: [...this.#modelCommands(context.instance)],
                    ...(memory === undefined ? {} : { memory }),
                    ...(memoryUnavailable ? { memoryStatus: "unavailable" } : {}),
                    platform: {
                        arch: worker.platform.arch,
                        ...(worker.platform.distribution === undefined
                            ? {}
                            : {
                                  distribution: worker.platform.distribution,
                              }),
                        os: worker.platform.os,
                        ...(worker.platform.packageManager === undefined
                            ? {}
                            : {
                                  packageManager:
                                      worker.platform.packageManager,
                              }),
                        ...(worker.platform.shell === undefined
                            ? {}
                            : { shell: worker.platform.shell.kind }),
                    },
                    ...(!memoryUnavailable &&
                    (memory !== undefined || prepared.projectMemoryPresent !== false)
                        ? {
                              projectMemoryAgentFile: memory === undefined
                                  ? prepared.projectMemoryAgentFile
                                  : `${memory.directory}/INDEX.md`,
                              projectMemoryDirectory: memory?.directory ?? prepared.projectMemoryDirectory,
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

    #requireGeneration(instance: string): { release(): void } {
        try {
            return this.#leaseInstance(instance);
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

/**
 * Memory status is supplementary metadata, not a precondition for the
 * Context/Worker environment already committed by environ_info.
 */
async function readOptionalMemory(
    lookup: ((ctxId: string, instance: string, workspace: string, signal?: AbortSignal) =>
        Promise<CurrentMemory | undefined>) | undefined,
    ctxId: string,
    instance: string,
    workspace: string,
    parentSignal?: AbortSignal,
): Promise<CurrentMemory | "unavailable" | undefined> {
    if (lookup === undefined) return undefined;
    const deadline = AbortSignal.timeout(3_000);
    const signal = parentSignal === undefined
        ? deadline : AbortSignal.any([parentSignal, deadline]);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(
            signal.reason instanceof Error
                ? signal.reason
                : new Error("Context Memory lookup was cancelled."),
        );
        signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
        signal.throwIfAborted();
        return await Promise.race([
            lookup(ctxId, instance, workspace, signal),
            aborted,
        ]);
    } catch (error) {
        // Caller cancellation is authoritative and must not be suppressed.
        if (parentSignal?.aborted) throw error;
        // Do not record the exception text or the returned Memory metadata;
        // either may contain private directory paths or extension secrets.
        console.warn("Optional Context Memory status unavailable", {
            extensionId: "comment",
            instance,
            reason: deadline.aborted ? "timeout" : "lookupFailed",
        });
        return "unavailable";
    } finally {
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
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
