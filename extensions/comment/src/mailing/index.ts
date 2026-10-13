import type { ExtensionContext } from "@portable-devshell/extension";
import { modelCommands, nativeCommands } from "@portable-devshell/extension/cli";
import { rewrite } from "@portable-devshell/extension/toolcall";

import { executeMailModelCommand, executeMailNativeCommand } from "./Command.js";
import { createMailingHook } from "./Hook.js";
import { MailingService, type MailingPort } from "./Service.js";

/** Mailing owns its service and bindings; the parent Comment Extension owns retirement. */
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
    context.register(rewrite, "mailing-trigger", createMailingHook(mailing, (error) =>
        context.logger.warn("Mailing trigger failed", { message: String(error) }),
    ));
    context.register(modelCommands, "mail", async (argv, invocation) =>
        await executeMailModelCommand(mailing, argv, invocation),
    );
    context.register(nativeCommands, "mail", async (argv, invocation) =>
        await executeMailNativeCommand(mailing, argv, invocation),
    );
}
