import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    ControlConfigStore,
    ControlConfigTomlCodec,
    ControlConfigValidator,
    ControlPathHome,
    ControlPathRuntime,
    createDefaultControlConfig
} from "../../dist/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

test("default config is generated at the fixed control config path", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));

    try {
        const store = new ControlConfigStore();
        const config = await store.readOrCreate(homeDirectory);
        const paths = new ControlPathHome(homeDirectory);

        assert.deepEqual(config, createDefaultControlConfig());
        assert.equal(paths.configFile, join(homeDirectory, ".devshell", "control", "config.toml"));
        assert.equal(new ControlPathRuntime("/tmp/runtime-task-8").socketFile, "/tmp/runtime-task-8/portable-devshell/control.sock");

        await access(paths.configFile);
        const source = await readFile(paths.configFile, "utf8");
        assert.match(source, /\[mcp\]/u);
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("valid config fixture is loaded", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));

    try {
        const fixture = await readFixture("config-valid.toml");
        const paths = new ControlPathHome(homeDirectory);

        await writeFileWithParents(paths.configFile, fixture);

        const config = await new ControlConfigStore().readOrCreate(homeDirectory);

        assert.equal(config.instances[0]?.name, "demo-local");
        assert.equal(config.instances[0]?.mcp.allowTools[0], "bash_run");
        assert.equal(config.instances[0]?.logs?.eventBufferSize, 50);
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("invalid config fixture is rejected", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));

    try {
        const paths = new ControlPathHome(homeDirectory);
        await writeFileWithParents(paths.configFile, await readFixture("config-invalid.toml"));

        await assert.rejects(new ControlConfigStore().readOrCreate(homeDirectory), /mcp\.listenPort must be an integer/u);
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("public MCP without auth is rejected", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));

    try {
        const paths = new ControlPathHome(homeDirectory);
        await writeFileWithParents(paths.configFile, await readFixture("config-public-no-auth.toml"));

        await assert.rejects(new ControlConfigStore().readOrCreate(homeDirectory), /Public MCP exposure requires authentication\./u);
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("instance name without dash is rejected", () => {
    const codec = new ControlConfigTomlCodec();
    const validator = new ControlConfigValidator();
    const config = codec.decode(codec.encode(createDefaultControlConfig()));

    config.instances.push({
        enabled: true,
        mcp: {
            allowTools: ["bash_run"],
            enabled: true
        },
        name: "invalidname",
        provider: "local"
    });

    assert.throws(() => validator.validate(config), /instance name must include '-': invalidname/u);
});

async function readFixture(name: string): Promise<string> {
    return await readFile(join(fixturesDir, name), "utf8");
}

async function writeFileWithParents(path: string, source: string): Promise<void> {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source, "utf8");
}
