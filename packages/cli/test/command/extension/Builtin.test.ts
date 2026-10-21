import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import { accessExtensionDirectory } from "@portable-devshell/access-extension";
import { artifactExtensionDirectory } from "@portable-devshell/artifact-extension";
import { instanceExtensionDirectory } from "@portable-devshell/instance-extension";
import { commentExtensionDirectory } from "@portable-devshell/comment-extension";
import { direnvExtensionDirectory } from "@portable-devshell/direnv-extension";
import { mcpExtensionDirectory } from "@portable-devshell/mcp-extension";
import { recallExtensionDirectory } from "@portable-devshell/recall-extension";
import { secretExtensionDirectory } from "@portable-devshell/secret-extension";
import { skillExtensionDirectory } from "@portable-devshell/skill-extension";
import { storageExtensionDirectory } from "@portable-devshell/storage-extension";

import { BUILTIN_EXTENSION_IDS } from "../../../../control/src/extension/install/index.ts";
import { modelCommandAuthorized } from "../../../../control/src/extension/api/point/cli/command/Broker.ts";
import { defaultConfigNormalizeContext } from "@portable-devshell/shared";
import { cliBuiltinExtensionSources } from "../../../src/command/extension/Builtin.js";

test("CLI lifecycle injects every builtin Extension source including MCP", () => {
    const sources = cliBuiltinExtensionSources();

    assert.deepEqual(sources, [
        { id: "access", path: accessExtensionDirectory() },
        { id: "artifact", path: artifactExtensionDirectory() },
        { id: "instance", path: instanceExtensionDirectory() },
        { id: "comment", path: commentExtensionDirectory() },
        { id: "direnv", path: direnvExtensionDirectory() },
        { id: "recall", path: recallExtensionDirectory() },
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

test("every bundled CLI Extension is accepted by the Control builtin installer", () => {
    const bundled = cliBuiltinExtensionSources().map((source) => source.id);
    assert.deepEqual(
        bundled.filter((id) => !BUILTIN_EXTENSION_IDS.has(id)),
        [],
        "CLI bundled Extensions must be installable by Control on first startup",
    );
    assert.deepEqual(
        [...BUILTIN_EXTENSION_IDS].filter((id) => !bundled.includes(id)),
        [],
        "Control must not reserve undocumented builtin identities",
    );
});

test("every bundled model command is authorized by default and every default entry has a declaration", () => {
    const allowed = defaultConfigNormalizeContext.defaultModelExtensions;
    const declaredByExtension = new Map<string, string[]>();
    for (const source of cliBuiltinExtensionSources()) {
        const manifest = JSON.parse(
            readFileSync(join(source.path, "devshell-extension.json"), "utf8"),
        ) as { extensions?: { "cli.model-commands"?: Array<{ id: string }> } };
        const commands = manifest.extensions?.["cli.model-commands"] ?? [];
        if (commands.length === 0) continue;
        declaredByExtension.set(source.id, commands.map((command) => command.id));
        for (const command of commands) {
            assert.ok(
                modelCommandAuthorized(allowed, { extensionId: source.id, id: command.id }),
                `Default Model CLI must authorize ${source.id}/${command.id}`,
            );
        }
    }
    assert.deepEqual(
        [...allowed].sort(),
        [...declaredByExtension.keys()].sort(),
        "The default model ACL must match the bundled model command declarations",
    );
});
