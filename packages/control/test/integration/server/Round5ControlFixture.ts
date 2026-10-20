import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inspect } from "node:util";
import type { TestContext } from "node:test";
import { ControlPathHome, Endpoint, LocalChannel, createInstanceTransport, createServerTransport, normalizeConfigInstanceDraft, toConfigInstanceDraft } from "@portable-devshell/shared";
import { Control } from "../../../src/Control.ts";
import { ControlFactory } from "../../../src/Factory.ts";
import { ControlConfigStore } from "../../../src/config/store/index.ts";
import { resolveTestWorkerBinary, workerPathEnvironmentName } from "../../../../../test/TestPlatformSupport.ts";
import { staleWorkerFixture } from "./Round5WorkerFixture.ts";

export async function controlDebtFixture(t: TestContext, home: string) {
    const binary = resolveTestWorkerBinary();
    assert.ok(binary);
    // Scope os.homedir(), native storage, runtime endpoints and asset install to
    // this test's disposable home before creating any production Instance.
    const environment = { HOME: home, USERPROFILE: home, PORTABLE_DEVSHELL_HOME: `${home}/.devshell`,
        XDG_RUNTIME_DIR: home, [workerPathEnvironmentName()]: binary };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    Object.assign(process.env, environment);
    t.after(() => {
        for (const key of Object.keys(environment)) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    });
    const worker = await staleWorkerFixture(home);
    const store = new ControlConfigStore();
    await store.readOrCreate(home);
    const file = new ControlPathHome(home).lifecycleCleanupFile;
    await mkdir(dirname(file), { recursive: true });
    const generationId = "round5-stale-generation";
    await writeFile(file, JSON.stringify([{ generationId, createdAt: "2026-10-20T00:00:00.000Z", operation: "delete",
        instance: toConfigInstanceDraft(normalizeConfigInstanceDraft({ name: "round5-delete", provider: "local", mcp: { enabled: false } })) }]));
    const warnings: string[] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(inspect(args, { depth: 12 })); });
    const control = new Control({ configStore: store, factory: new ControlFactory({ builtinExtensionSources: [] }), homeDirectory: home, xdgRuntimeDir: home });
    const endpoints: Endpoint[] = [];
    t.after(async () => { for (const endpoint of endpoints) endpoint.close(); await control.stop(); });
    async function connect() {
        const endpoint = new Endpoint({ connectChannel: (signal) => LocalChannel.connect(control.socketPath, { signal }) });
        endpoints.push(endpoint);
        await createServerTransport(endpoint, { clientKind: "cli" }).hello();
        return createInstanceTransport(endpoint);
    }
    await control.start();
    return { worker, control, connect, warnings, generationId };
}
