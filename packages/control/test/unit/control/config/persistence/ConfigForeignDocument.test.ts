import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ControlPathHome, createDefaultControlConfig } from "@portable-devshell/shared";
import { ControlConfigStore } from "../../../../../src/config/store/index.ts";
import { createTestTempDirectory } from "../../../../../../../test/TestTempDirectory.ts";
import { runPersistenceProcess } from "./CrashProcess.ts";

for (const foreignName of ["operator_notes.toml", "部署说明.toml"]) {
    test(`unrecognized ${foreignName} must remain preserved without blocking crash recovery`, async (t) => {
        const home = await createTestTempDirectory("foreign-toml-recovery");
        t.after(() => rm(home, { recursive: true, force: true }));
        t.mock.method(console, "warn", () => undefined);
        const paths = new ControlPathHome(home);
        const config = createDefaultControlConfig();
        config.web.listenPort = 17920;
        await new ControlConfigStore().write(config, home);
        const foreign = join(paths.instancesDir, foreignName);
        await writeFile(foreign, "operator-owned unrecognized document");
        // A successful ordinary write preserves this document by design.
        await new ControlConfigStore().write(config, home);
        assert.equal(await readFile(foreign, "utf8"), "operator-owned unrecognized document");
        config.web.listenPort = 17921;
        const moduleUrl = new URL("../../../../../src/config/store/index.ts", import.meta.url).href;
        runPersistenceProcess(`
            import fs from 'node:fs/promises';
            import { syncBuiltinESMExports } from 'node:module';
            const { home, config, target } = JSON.parse(process.argv[1]);
            const rename = fs.rename;
            fs.rename = async (...args) => {
                await rename(...args);
                if (args[1] === target) process.kill(process.pid, 'SIGKILL');
            };
            syncBuiltinESMExports();
            const { ControlConfigStore } = await import(${JSON.stringify(moduleUrl)});
            await new ControlConfigStore().write(config, home);
            throw new Error('writer kill boundary not reached');
        `, { home, config, target: paths.configFile }, true);
        const recovered = await new ControlConfigStore().readOrCreate(home);
        assert.equal(recovered.web.listenPort, 17920);
        assert.equal(await readFile(foreign, "utf8"), "operator-owned unrecognized document");
    });
}
