import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type { CliCommandResult, CliNativeCommandInvocationContext } from "@portable-devshell/extension/cli";

import { executeStorageArguments } from "./StorageCommandCore.js";

export { STORAGE_USAGE } from "./StorageCommandCore.js";

export async function executeStorageCommand(
    argv: readonly string[],
    invocation: CliNativeCommandInvocationContext,
): Promise<CliCommandResult> {
    invocation.signal.throwIfAborted();
    if (!invocation.localOwner) throw new Error("Storage commands are restricted to the local owner CLI.");
    const result = executeStorageArguments(argv, {
        signal: invocation.signal,
        ...(invocation.workingDirectory === undefined ? {} : { workingDirectory: invocation.workingDirectory }),
    });
    if (result.kind === "text") return result;
    return { kind: "json", value: result.value as ExtensionJsonValue };
}
