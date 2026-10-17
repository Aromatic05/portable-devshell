import type { ContextApi } from "../../../../../context/Api.js";
import type { InstanceRegistry } from "../../../../../instance/Api.js";
import { modelCommandAuthorized } from "./Broker.js";
import type { CliExtensionCommandService } from "./index.js";

interface MemoryStatus {
    readonly name: string;
    readonly directory: string;
    readonly mailbox: string;
}

/** Adapt an optional Model CLI capability without coupling Control composition
 * to the Extension that implements it. The Context Tool owns only the result.
 */
export function createModelMemoryLookup(options: {
    commands: CliExtensionCommandService;
    contexts: ContextApi;
    instances: Pick<InstanceRegistry, "get">;
}): (ctxId: string, instance: string, workspace: string, signal?: AbortSignal) => Promise<MemoryStatus | undefined> {
    let lastProvider: { id: string; extensionId: string } | undefined;
    return async (ctxId, instance, workspace, signal) => {
        const provider = options.commands.list().find((command) => command.id === "memory");
        if (provider !== undefined) lastProvider = provider;
        const candidate = provider ?? lastProvider;
        if (candidate === undefined) return undefined;
        const allowed = options.instances.get(instance)?.config.modelExtensions ?? [];
        if (!modelCommandAuthorized(allowed, candidate)) return undefined;

        const result = await options.commands.command(candidate.id, ["status"], {
            ctxId,
            context: {
                instanceReference: (target) =>
                    options.contexts.registry.referenceInstance(ctxId, target),
            },
            instance,
            requestId: "environ_info",
            signal: signal ?? new AbortController().signal,
            workspace,
        });
        if (result.kind !== "json" || result.value === null ||
            typeof result.value !== "object" || Array.isArray(result.value))
            return undefined;
        const { name, directory, mailbox } = result.value;
        return typeof name === "string" && typeof directory === "string" &&
            typeof mailbox === "string"
            ? { name, directory, mailbox } : undefined;
    };
}
