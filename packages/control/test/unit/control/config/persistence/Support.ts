import { ControlGlobalTomlDocument } from "../../../../../src/config/store/document/Global.ts";
import { ControlInstanceTomlDocument } from "../../../../../src/config/store/document/Instance.ts";
import { ControlConfigTomlCodec } from "../../../../../src/config/store/TomlCodec.ts";
import {
    normalizeConfigGlobalDraft,
    normalizeConfigInstanceDraft,
    type ConfigGlobalDraft,
    type ConfigInstanceDraft,
} from "@portable-devshell/shared";

const toml = new ControlConfigTomlCodec();
const globalDocument = new ControlGlobalTomlDocument();
const instanceDocument = new ControlInstanceTomlDocument();

export function encodeGlobalConfig(draft: ConfigGlobalDraft): string {
    return toml.encode(
        globalDocument.encode(normalizeConfigGlobalDraft(draft)),
    );
}

export function encodeInstanceConfig(draft: ConfigInstanceDraft): string {
    return toml.encode(
        instanceDocument.encode(normalizeConfigInstanceDraft(draft)),
    );
}
