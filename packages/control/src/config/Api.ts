// Types shared with Control domains that consume Config services.
export type { ConfigCommittedChange } from "./change/Config.js";
export type {
    ConfigDomainDefinition,
    ConfigPathPermission,
    ConfigRegistry,
} from "./domain/Registry.js";
export type { ControlConfigMutationRunner } from "./engine/Lock.js";
