import type { ExtensionContext } from "@portable-devshell/extension";
import { modelCommands, nativeCommands } from "@portable-devshell/extension/cli";
import { rewrite } from "@portable-devshell/extension/toolcall";

import { executeMemoryModelCommand, executeMemoryNativeCommand } from "./Command.js";
import { createMailingHook, createMemoryAutoHook } from "./Hook.js";
import { MailingService, type MailingPort } from "./Service.js";

/** Memory bindings and their derived Mailing are owned by the Comment Extension. */
export type MailingRuntime = MailingService;

export function createMailingService(
    context: ExtensionContext,
    comment: MailingPort,
): MailingRuntime {
    const worker = context.capabilities.workerExecute;
    const contexts = context.capabilities.contextObserve;
    if (worker === undefined || contexts === undefined)
        throw new Error("Comment Mailing requires worker.execute and context.observe capabilities");
    return new MailingService({
        worker,
        contexts,
        comment,
        onError: (error) => context.logger.error("Mailing reconciliation failed", {
            message: error instanceof Error ? error.message : String(error),
        }),
    });
}

export function registerMailing(context: ExtensionContext, mailing: MailingRuntime): void {
    context.register(rewrite, "memory-auto", createMemoryAutoHook(mailing, (error) =>
        context.logger.warn("Automatic Memory binding failed", { message: String(error) }),
    ));
    context.register(rewrite, "mailing-trigger", createMailingHook(mailing, (error) =>
        context.logger.warn("Mailing trigger failed", { message: String(error) }),
    ));
    context.register(modelCommands, "memory", async (argv, invocation) =>
        await executeMemoryModelCommand(mailing, argv, invocation),
    );
    context.register(nativeCommands, "memory", async (argv, invocation) =>
        await executeMemoryNativeCommand(mailing, argv, invocation),
    );
}
