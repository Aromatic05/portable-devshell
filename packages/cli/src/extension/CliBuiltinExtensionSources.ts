import { artifactExtensionDirectory } from "@portable-devshell/artifact-extension";
import { instanceExtensionDirectory } from "@portable-devshell/instance-extension";
import { mcpExtensionDirectory } from "@portable-devshell/mcp-extension";
import { secretExtensionDirectory } from "@portable-devshell/secret-extension";
import { skillExtensionDirectory } from "@portable-devshell/skill-extension";

export interface CliBuiltinExtensionSource {
    readonly id: string;
    readonly path: string;
}

export function cliBuiltinExtensionSources(): readonly CliBuiltinExtensionSource[] {
    return Object.freeze([
        Object.freeze({ id: "artifact", path: artifactExtensionDirectory() }),
        Object.freeze({ id: "instance", path: instanceExtensionDirectory() }),
        Object.freeze({ id: "skill", path: skillExtensionDirectory() }),
        Object.freeze({ id: "secret", path: secretExtensionDirectory() }),
        Object.freeze({ id: "mcp", path: mcpExtensionDirectory() })
    ]);
}
