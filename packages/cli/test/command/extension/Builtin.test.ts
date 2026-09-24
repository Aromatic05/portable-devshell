import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import test from "node:test";

import { accessExtensionDirectory } from "@portable-devshell/access-extension";
import { artifactExtensionDirectory } from "@portable-devshell/artifact-extension";
import { instanceExtensionDirectory } from "@portable-devshell/instance-extension";
import { commentExtensionDirectory } from "@portable-devshell/comment-extension";
import { mcpExtensionDirectory } from "@portable-devshell/mcp-extension";
import { secretExtensionDirectory } from "@portable-devshell/secret-extension";
import { skillExtensionDirectory } from "@portable-devshell/skill-extension";
import { storageExtensionDirectory } from "@portable-devshell/storage-extension";

import { cliBuiltinExtensionSources } from "../../../src/command/extension/Builtin.js";

test("CLI lifecycle injects every builtin Extension source including MCP", () => {
    const sources = cliBuiltinExtensionSources();

    assert.deepEqual(sources, [
        { id: "access", path: accessExtensionDirectory() },
        { id: "artifact", path: artifactExtensionDirectory() },
        { id: "instance", path: instanceExtensionDirectory() },
        { id: "comment", path: commentExtensionDirectory() },
        { id: "skill", path: skillExtensionDirectory() },
        { id: "secret", path: secretExtensionDirectory() },
        { id: "storage", path: storageExtensionDirectory() },
        { id: "mcp", path: mcpExtensionDirectory() },
    ]);
    assert.equal(
        sources.every((source) => isAbsolute(source.path)),
        true,
    );
});
