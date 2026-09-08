import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import test from "node:test";

import { mcpExtensionDirectory } from "@portable-devshell/mcp-extension";
import { secretExtensionDirectory } from "@portable-devshell/secret-extension";
import { skillExtensionDirectory } from "@portable-devshell/skill-extension";

import { cliBuiltinExtensionSources } from "../../src/extension/CliBuiltinExtensionSources.ts";

test("CLI lifecycle injects every builtin Extension source including MCP", () => {
    const sources = cliBuiltinExtensionSources();

    assert.deepEqual(sources, [
        { id: "skill", path: skillExtensionDirectory() },
        { id: "secret", path: secretExtensionDirectory() },
        { id: "mcp", path: mcpExtensionDirectory() }
    ]);
    assert.equal(sources.every((source) => isAbsolute(source.path)), true);
});
