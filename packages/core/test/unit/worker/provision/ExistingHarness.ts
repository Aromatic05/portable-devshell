import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { ContainerProvisionExisting } from "../../../../src/instance/runtime/provision/container/Existing.ts";
import type { ContainerAdoptionIdentity } from "../../../../src/instance/runtime/provision/container/Adoption.ts";
import type { ContainerProvisionOperations } from "../../../../src/instance/runtime/provision/container/Provision.ts";

export const existingId = "a".repeat(64);
export const replacementId = "b".repeat(64);
export const startedAt = "2026-10-20T01:00:00Z";
export function existingInspect(status: string, id = existingId, started = startedAt): string {
    return JSON.stringify([{ Id: id, State: { Status: status, StartedAt: started } }]);
}

export async function existingFixture(t: TestContext, adoptLifecycle = true) {
    const root = await mkdtemp(join(tmpdir(), "existing-adoption-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const adoption = { databaseFile: join(root, "adoption.sqlite3"), resourceDirectory: join(root, "resources"), owner: "instance-alpha/config-1" };
    let container: { status: "running" | "stopped"; id: string; started: string } | undefined = { status: "stopped", id: existingId, started: startedAt };
    const calls: Array<{ operation: string; args: readonly string[] }> = [];
    let nextFault: { operation: string; afterEffect?: boolean } | undefined;
    let before: ((operation: string, args: readonly string[]) => Promise<void>) | undefined;
    let target: string | undefined;
    const operations: ContainerProvisionOperations = {
        provider: "podman",
        async readContainerStatus() { return container?.status ?? "missing"; },
        setContainerTarget(id) { target = id; },
        async runProviderCommand(operation, args) {
            calls.push({ operation, args });
            await before?.(operation, args);
            const fault = nextFault?.operation === operation ? nextFault : undefined;
            if (fault) nextFault = undefined;
            if (fault && !fault.afterEffect) throw new Error(`injected ${operation} failure`);
            if (!container || (args.at(-1) !== "configured" && args.at(-1) !== container.id))
                return { exitCode: 125, stdout: "", stderr: "no such container", details: {} };
            if (args[0] === "start") { container.status = "running"; container.started = startedAt; }
            if (args[0] === "stop") container.status = "stopped";
            if (fault) throw new Error(`injected ${operation} failure`);
            return { exitCode: 0, stdout: args[0] === "inspect" ? existingInspect(container.status, container.id, container.started) : "", stderr: "", details: {} };
        },
    };
    const config = { mode: "existingStoppedContainer" as const, containerName: "configured", adoptLifecycle };
    return {
        root, adoption, config, operations, calls,
        provision(identity: ContainerAdoptionIdentity | undefined = adoption) { return new ContainerProvisionExisting({ config, operations, adoption: identity }); },
        state: () => container,
        target: () => target,
        replace(id = replacementId, status: "running" | "stopped" = "running") { container = { id, status, started: startedAt }; },
        remove() { container = undefined; },
        externalRestart() { container!.status = "running"; container!.started = "2026-10-20T02:00:00Z"; },
        fail(operation: string, afterEffect = false) { nextFault = { operation, afterEffect }; },
        intercept(callback: typeof before) { before = callback; },
    };
}
