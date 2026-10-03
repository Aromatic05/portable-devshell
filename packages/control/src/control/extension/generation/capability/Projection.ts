import {
    EXTENSION_CAPABILITY_IDS,
    type ExtensionCapabilities,
    type ExtensionCapability,
} from "@portable-devshell/extension";

type ExtensionCapabilityRuntimeValues = {
    [Key in keyof ExtensionCapabilities]-?: NonNullable<
        ExtensionCapabilities[Key]
    >;
};

export type ExtensionCapabilityRuntimeFactories = {
    [
        Key in keyof ExtensionCapabilityRuntimeValues
    ]: () => ExtensionCapabilityRuntimeValues[Key];
};

export const EXTENSION_CAPABILITY_CONTEXT_KEYS = Object.freeze({
    artifacts: "artifacts",
    assets: "assets",
    "context.observe": "contextObserve",
    "instance.events.publish": "instanceEventPublish",
    "instance.manage": "instanceManage",
    "instance.observe": "instanceObserve",
    processes: "processes",
    "toolcall.history": "toolCallHistory",
    "worker.delegate": "workerDelegate",
    "worker.execute": "workerExecute",
} as const satisfies Record<ExtensionCapability, keyof ExtensionCapabilities>);

export function projectExtensionCapabilities(
    grants: readonly ExtensionCapability[],
    factories: ExtensionCapabilityRuntimeFactories,
): ExtensionCapabilities {
    const granted = new Set(grants);
    const projected: Partial<ExtensionCapabilityRuntimeValues> = {};

    for (const capability of EXTENSION_CAPABILITY_IDS) {
        if (!granted.has(capability)) continue;
        const key = EXTENSION_CAPABILITY_CONTEXT_KEYS[capability];
        assignCapability(projected, key, factories[key]());
    }

    return Object.freeze(projected);
}

function assignCapability<Key extends keyof ExtensionCapabilityRuntimeValues>(
    target: Partial<ExtensionCapabilityRuntimeValues>,
    key: Key,
    value: ExtensionCapabilityRuntimeValues[Key],
): void {
    target[key] = value;
}
