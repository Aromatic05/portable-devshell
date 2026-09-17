import type { ExtensionJsonValue } from "../ExtensionApi.js";
import type { ToolCallRewriteContext } from "./toolcall.js";

export const secretRewriteInterfaceOperation = "secret.environment";

export async function readSecretEnvironment(
    context: Pick<ToolCallRewriteContext, "requestInterface">,
): Promise<Readonly<Record<string, string>>> {
    const value = await context.requestInterface(secretRewriteInterfaceOperation);
    if (!isRecord(value))
        throw new TypeError("Secret rewrite interface returned an invalid environment.");
    const environment: Record<string, string> = {};
    for (const [name, entry] of Object.entries(value)) {
        if (typeof entry !== "string")
            throw new TypeError(
                `Secret rewrite environment value ${name} must be a string.`,
            );
        environment[name] = entry;
    }
    return Object.freeze(environment);
}

function isRecord(
    value: ExtensionJsonValue | undefined,
): value is Record<string, ExtensionJsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
