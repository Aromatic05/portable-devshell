import { createHash } from "node:crypto";

export function mcpAppIdentity(
    ctxId: string,
    instance: string,
    targetId: string,
    operation: string,
    revision?: string | number,
): string {
    return createHash("sha256")
        .update(JSON.stringify([ctxId, instance, targetId, operation, revision ?? null]))
        .digest("hex");
}
