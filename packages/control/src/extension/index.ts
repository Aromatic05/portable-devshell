import type {
    ExtensionRuntime,
    ExtensionRuntimeOptions,
} from "./Api.js";
import { ExtensionHost } from "./host/Host.js";

export function createExtensionRuntime(
    options: ExtensionRuntimeOptions,
): ExtensionRuntime {
    return new ExtensionHost(options);
}
