export const EXTENSION_CAPABILITY_IDS = [
    "artifacts",
    "assets",
    "context.observe",
    "instance.events.publish",
    "instance.manage",
    "instance.observe",
    "processes",
    "toolcall.history",
    "worker.delegate",
    "worker.execute",
] as const;

export type ExtensionCapability = (typeof EXTENSION_CAPABILITY_IDS)[number];
