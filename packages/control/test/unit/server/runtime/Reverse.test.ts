import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { ReverseConnections } from "@portable-devshell/core";

import { ReverseCredentials } from "../../../../src/instance/reverse/Credentials.ts";
import { ReverseCredentialStore } from "../../../../src/instance/reverse/credential/Store.ts";
import { ReverseIngress } from "../../../../src/server/reverse/Ingress.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

class RecordingHttpHost {
    readonly rawPaths: string[] = [];
    readonly upgradePaths: string[] = [];

    registerRawRoute(_method: string, path: string): () => void {
        this.rawPaths.push(path);
        return () => undefined;
    }

    registerUpgradeHandler(path: string): () => void {
        this.upgradePaths.push(path);
        return () => undefined;
    }
}

test("reverse ingress can install before the first reverse instance exists", async (t) => {
    const homeDirectory = await createTestTempDirectory("reverse-runtime-empty");
    t.after(
        async () => await rm(homeDirectory, { force: true, recursive: true }),
    );
    const instances = { get: () => undefined };
    const connections = new ReverseConnections({ instances });
    const credentials = new ReverseCredentials({
        credentialStore: new ReverseCredentialStore(homeDirectory),
        instanceRegistry: instances,
        publicBaseUrl: "https://controller.example.test",
    });
    const ingress = new ReverseIngress({
        connections,
        credentials,
        publicBaseUrl: "https://controller.example.test",
    });
    const host = new RecordingHttpHost();

    ingress.install(host as never);

    assert.equal(host.rawPaths.includes("/reverse/v1/enroll"), true);
    assert.equal(host.upgradePaths.includes("/reverse/v1/connect"), true);
    ingress.stop();
});

test("reverse ingress and credentials adopt a replacement public URL", async (t) => {
    const homeDirectory = await createTestTempDirectory("reverse-runtime");
    t.after(
        async () => await rm(homeDirectory, { force: true, recursive: true }),
    );
    const descriptor: any = {
        config: { name: "reverse-worker", provider: "reverse" },
    };
    const instances = {
        get(name: string) {
            return name === descriptor.config.name ? descriptor : undefined;
        },
    };
    const connections = new ReverseConnections({ instances });
    const credentials = new ReverseCredentials({
        credentialStore: new ReverseCredentialStore(homeDirectory),
        instanceRegistry: instances,
        publicBaseUrl: "https://controller.example.test/old",
    });
    const ingress = new ReverseIngress({
        connections,
        credentials,
        publicBaseUrl: "https://controller.example.test/old",
    });
    const firstHost = new RecordingHttpHost();
    ingress.install(firstHost as never);
    assert.equal(firstHost.rawPaths.includes("/old/reverse/v1/enroll"), true);

    credentials.setPublicBaseUrl("https://controller.example.test/new");
    ingress.setPublicBaseUrl("https://controller.example.test/new");
    const nextHost = new RecordingHttpHost();
    ingress.install(nextHost as never);

    assert.equal(nextHost.rawPaths.includes("/new/reverse/v1/enroll"), true);
    assert.equal(
        nextHost.upgradePaths.includes("/new/reverse/v1/connect"),
        true,
    );
    const code = await credentials.createDeviceCode("reverse-worker");
    assert.equal(code.controllerUrl, "https://controller.example.test/new");
    ingress.stop();
});
