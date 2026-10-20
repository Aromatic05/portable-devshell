import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalExecution } from "../../../../core/src/instance/runtime/execution/provider/Local.ts";
import { WorkerCommandClient } from "../../../../core/src/instance/runtime/execution/Command.ts";
import { WorkerBinary } from "../../../../core/src/instance/runtime/Binary.ts";
import { WorkerInstanceRetirement } from "../../../../core/src/instance/runtime/provision/Retirement.ts";
import { resolveTestWorkerBinary } from "../../../../../test/TestPlatformSupport.ts";

export function realRetirement(home: string, name = "round5-delete") {
    const binary = resolveTestWorkerBinary();
    assert.ok(binary, "Round5 retirement requires a prepared native Rust Worker");
    const env = { PORTABLE_DEVSHELL_HOME: join(home, ".devshell"), XDG_RUNTIME_DIR: home };
    const runtime = new LocalExecution({ workerBinary: new WorkerBinary(binary) });
    const client = new WorkerCommandClient(runtime, name, env);
    const retirement = new WorkerInstanceRetirement({ config: { name } as never, commandClient: client });
    return { client, retirement, env, root: join(env.PORTABLE_DEVSHELL_HOME, name) };
}

export async function staleWorkerFixture(home: string) {
    const worker = realRetirement(home);
    await mkdir(join(worker.root, "state"), { recursive: true });
    // Invalid PID is deterministic residue and cannot designate any live process.
    await writeFile(join(worker.root, "state", "worker.pid"), "round5-no-process\n");
    await mkdir(join(worker.root, "artifacts"), { recursive: true });
    await writeFile(join(worker.root, "artifacts", "retained.txt"), "must survive failed retirement");
    return worker;
}
