import {
    ControlGlobalTomlDocument,
    ControlInstanceTomlDocument,
    ControlTomlCodec
} from "../dist/index.js";
import {
    normalizeConfigGlobalDraft,
    normalizeConfigInstanceDraft,
    type ConfigGlobalDraft,
    type ConfigInstanceDraft
} from "@portable-devshell/shared";

const toml = new ControlTomlCodec();
const globalDocument = new ControlGlobalTomlDocument();
const instanceDocument = new ControlInstanceTomlDocument();

export function encodeGlobalConfig(draft: ConfigGlobalDraft): string {
    return toml.encode(globalDocument.encode(normalizeConfigGlobalDraft(draft)));
}

export function encodeInstanceConfig(draft: ConfigInstanceDraft): string {
    return toml.encode(instanceDocument.encode(normalizeConfigInstanceDraft(draft)));
}
