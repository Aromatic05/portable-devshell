import { ControlPathHome, createDefaultControlConfig, normalizeConfigInstanceDraft, type ControlConfig } from "@portable-devshell/shared";
import { ControlConfigStore } from "../../../../src/config/store/index.ts";
import { ConfigEngine } from "../../../../src/config/engine/index.ts";
import { InstanceChangeHub } from "../../../../src/instance/Change.ts";
import { InstanceRegistry } from "../../../../src/instance/Registry.ts";
import { InstanceEditorCoordinator } from "../../../../src/instance/editor/index.ts";
import { InstanceCreateCoordinator } from "../../../../src/instance/editor/create/index.ts";
import { createTestInstance, type TestInstanceRuntimeOverrides } from "../../../support/InstanceRuntime.ts";

export function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

export async function deletionFixture(home: string, overrides: TestInstanceRuntimeOverrides = {}, restart = false) {
    const store = new ControlConfigStore();
    let config = restart ? await store.readOrCreate(home) : createDefaultControlConfig();
    const draft = { name: "round5-delete", provider: "local", mcp: { enabled: false } } as const;
    if (!restart) {
        config.instances = [normalizeConfigInstanceDraft(draft)];
        await store.write(config, home);
    }
    const descriptors: ReturnType<typeof createTestInstance>[] = [];
    const createRuntimeInstance = (next: ControlConfig["instances"][number]) => {
        const descriptor = createTestInstance(next, overrides);
        descriptors.push(descriptor);
        return descriptor;
    };
    const registry = new InstanceRegistry(config.instances.map(createRuntimeInstance));
    const engine = new ConfigEngine({ configStore: store, homeDirectory: home,
        getConfig: () => config, setConfig: (next) => { config = next; } });
    const options = { engine, instanceRegistry: registry, instanceChanges: new InstanceChangeHub(),
        createRuntimeInstance, finalizeRuntimeInstance: async (descriptor: ReturnType<typeof createTestInstance>) => descriptor.close() };
    const editor = new InstanceEditorCoordinator({ ...options, cleanupDebtFile: new ControlPathHome(home).lifecycleCleanupFile });
    const creator = new InstanceCreateCoordinator({ ...options,
        assertCleanupSettled: (name, reconcile) => editor.assertInstanceCleanupSettled(name, reconcile) });
    return { home, store, engine, registry, editor, creator, descriptors, draft,
        async close() { for (const descriptor of descriptors) await descriptor.close(); } };
}
