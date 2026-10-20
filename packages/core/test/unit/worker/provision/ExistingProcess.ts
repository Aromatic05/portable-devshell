import { normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import { toWorkerConfig } from "../../../../src/instance/model/Instance.ts";
import { WorkerCommandClient } from "../../../../src/instance/runtime/execution/Command.ts";
import { WorkerInstanceRetirement } from "../../../../src/instance/runtime/provision/Retirement.ts";
import { resolveWorkerInstanceConfig } from "../../../../src/instance/runtime/provision/Config.ts";
import { WorkerRuntimeFactory } from "../../../../src/instance/runtime/provision/Factory.ts";
import type { WorkerCommandName } from "../../../../src/instance/runtime/execution/Command.ts";
import { join } from "node:path";
import { writeSync } from "node:fs";

const [root, command, tag = "original"] = process.argv.slice(2) as [string, WorkerCommandName | "retire-all" | "retire-skip", string?];
const instance = normalizeConfigInstanceDraft({
    name: tag === "second-instance" ? "second" : "adopted",
    provider: "podman",
    podmanBinary: join(root, "fake-provider.mjs"),
    container: { mode: "existingStoppedContainer", containerName: tag === "new-container-binding" ? "a".repeat(64) : "configured", adoptLifecycle: tag !== "worker-only" },
    env: { ADOPTION_CONFIG_TAG: tag },
});
const create = WorkerRuntimeFactory.create;
WorkerRuntimeFactory.create = (options) => create({
    ...options,
    ...("adoption" in options ? { adoption: { ...options.adoption!, resourceDirectory: join(root, "resources") } } : {}),
});
try {
    const config = toWorkerConfig(instance, undefined, join(root, "controller-home"));
    if (config.runtime === undefined) throw new Error("Missing managed runtime");
    if (command === "retire-all" || command === "retire-skip") {
        const client = new WorkerCommandClient(config.runtime, config.name, config.env);
        await new WorkerInstanceRetirement({ config: resolveWorkerInstanceConfig(config), commandClient: client }).retire(command === "retire-skip");
        writeSync(1, JSON.stringify({ retired: true }));
        process.exit(0);
    }
    const result = await config.runtime.runWorkerCommand(command, { instanceName: instance.name, env: config.env });
    writeSync(1, JSON.stringify(result));
    process.exitCode = result.exitCode === 0 ? 0 : 1;
} catch (error) {
    writeSync(2, JSON.stringify({ message: String(error), details: error instanceof Error && "details" in error ? error.details : undefined }));
    process.exitCode = 1;
}
