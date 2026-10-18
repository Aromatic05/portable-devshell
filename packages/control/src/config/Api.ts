// Types shared with Control domains that consume Config services.
import type { ConfigEditorCoordinator } from "./editor/index.js";

export type { ConfigCommittedChange } from "./change/Config.js";
export type { ConfigChangeHub } from "./change/Config.js";
export type {
    ConfigDomainDefinition,
    ConfigPathPermission,
    ConfigRegistry,
} from "./domain/Registry.js";
export type { ControlConfigMutationRunner } from "./engine/Lock.js";
export type { ConfigRuntimeChangeSet } from "./engine/Api.js";
export type { ConfigEditorPort } from "./Route.js";
export type { ConfigEditorCoordinator };
