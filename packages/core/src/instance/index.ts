import type { ControlInstanceConfig } from "@portable-devshell/shared";
import { Instance } from "./model/Instance.js";

export function createInstance(config: ControlInstanceConfig): Instance {
    return Instance.create(config);
}
