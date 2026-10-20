import { normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import { toWorkerConfig } from "../../../../src/instance/model/Instance.ts";
import type { WorkerCommandName } from "../../../../src/instance/runtime/execution/Command.ts";
import { join } from "node:path";

const [root, command, tag = "original"] = process.argv.slice(2) as [string, WorkerCommandName, string?];
const instance = normalizeConfigInstanceDraft({
    name: "adopted",
    provider: "podman",
    podmanBinary: join(root, "fake-provider.mjs"),
    container: { mode: "existingStoppedContainer", containerName: tag === "new-container-binding" ? "a".repeat(64) : "configured", adoptLifecycle: true },
    env: { ADOPTION_CONFIG_TAG: tag },
});
try {
    const config = toWorkerConfig(instance, undefined, join(root, "controller-home"));
    if (config.runtime === undefined) throw new Error("Missing managed runtime");
    const result = await config.runtime.runWorkerCommand(command, { instanceName: instance.name, env: config.env });
    process.stdout.write(JSON.stringify(result));
    process.exitCode = result.exitCode === 0 ? 0 : 1;
} catch (error) {
    process.stderr.write(JSON.stringify({ message: String(error), details: error instanceof Error && "details" in error ? error.details : undefined }));
    process.exitCode = 1;
}
