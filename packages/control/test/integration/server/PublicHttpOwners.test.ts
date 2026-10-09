import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import test from "node:test";

import {
    Endpoint, LocalChannel, createConfigTransport,
    createDefaultControlConfig, createServerTransport,
} from "@portable-devshell/shared";
import { Control } from "../../../src/Control.ts";
import { ControlFactory } from "../../../src/Factory.ts";
import { ControlConfigStore } from "../../../src/config/store/index.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

async function availablePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return address.port;
}

test("Artifact and Reverse routes outlive MCP Host generations and migrate with Control HTTP configuration", async (t) => {
    const home = await createTestTempDirectory("control-public-http-owners");
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const config = createDefaultControlConfig();
    config.web.enabled = false;
    config.mcp.enabled = true;
    config.mcp.listenHost = "127.0.0.1";
    config.mcp.listenPort = port;
    config.mcp.publicBaseUrl = `${origin}/old`;
    const store = new ControlConfigStore();
    await store.write(config, home);
    const control = new Control({
        configStore: store,
        homeDirectory: home,
        factory: new ControlFactory({ builtinExtensionSources: [] }),
        xdgRuntimeDir: home,
    });
    const endpoint = new Endpoint({ connectChannel: (signal) => LocalChannel.connect(control.socketPath, { signal }) });
    t.after(async () => {
        endpoint.close();
        await control.stop();
        await rm(home, { recursive: true, force: true });
    });

    await control.start();
    await createServerTransport(endpoint, { clientKind: "cli" }).hello();
    const remote = createConfigTransport(endpoint);
    const artifact = (prefix: string) => `${origin}${prefix}/artifacts/share/unknown`;
    const reverse = (prefix: string) => `${origin}${prefix}/reverse/v1/enroll`;
    const getArtifact = async (prefix: string) => await (await fetch(artifact(prefix))).text();
    const postReverse = async (prefix: string) =>
        await fetch(reverse(prefix), { method: "POST", body: "{}", headers: { "content-type": "application/json" } });

    assert.match(await getArtifact("/old"), /Artifact share was not found/u);
    assert.equal((await postReverse("/old")).status, 400);

    const updated = await remote.updateMcpEndpoint({ patch: { publicBaseUrl: `${origin}/new` } });
    assert.equal(updated.restartControlRequired, false);
    assert.equal(await (await fetch(artifact("/old"))).status, 404);
    assert.match(await getArtifact("/new"), /Artifact share was not found/u);
    assert.equal((await postReverse("/old")).status, 404);
    assert.equal((await postReverse("/new")).status, 400);

    const changed = await remote.updateMcpEndpoint({ patch: { oauth2: { approval: "token", token: "t".repeat(48) } } });
    assert.equal(changed.restartControlRequired, false);
    assert.match(await getArtifact("/new"), /Artifact share was not found/u);
    assert.equal((await postReverse("/new")).status, 400);

    const disabled = await remote.updateMcpEndpoint({ patch: { enabled: false } });
    assert.equal(disabled.restartControlRequired, false);
    await assert.rejects(fetch(artifact("/new")));

    const reenabled = await remote.updateMcpEndpoint({ patch: { enabled: true } });
    assert.equal(reenabled.restartControlRequired, false);
    assert.match(await getArtifact("/new"), /Artifact share was not found/u);
    assert.equal((await postReverse("/new")).status, 400);
});
