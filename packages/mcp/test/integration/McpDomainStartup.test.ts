import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import { createTestMcpRuntimeState, TestMcpHost } from '../ContextRuntime.ts';
import { mcpAppAssetDirectory } from '../../src/mcpapp/app/Resource.ts';

async function appAssetPath(): Promise<string> {
    const asset = (await readdir(mcpAppAssetDirectory)).find((name) => name.endsWith('.js'));
    assert.ok(asset, 'MCP App built assets must be installed before HTTP tests');
    return `/mcpapp/assets/${asset}`;
}

test('MCP App HTTP routes are attached only while the Protocol Domain is prepared', async () => {
    const runtime = createTestMcpRuntimeState();
    const host = new TestMcpHost({
        instances: [{ name: 'demo' }], listenHost: '127.0.0.1', listenPort: 0,
    }, runtime);
    await host.server.start();
    try {
        const address = host.server.address;
        assert.ok(typeof address === 'object' && address !== null);
        const url = `http://127.0.0.1:${address.port}${await appAssetPath()}`;
        const get = () => fetch(url, { headers: { connection: 'close' } });
        assert.equal((await get()).status, 404);
        await host.prepare();
        assert.equal((await get()).status, 200);
        host.retire();
        assert.equal((await get()).status, 404);
        await host.prepare();
        assert.equal((await get()).status, 200);
    } finally {
        await host.stop();
    }
});

test('failed MCP OAuth preparation never installs MCP App HTTP routes', async () => {
    const runtime = createTestMcpRuntimeState();
    const host = new TestMcpHost({
        instances: [{
            name: 'demo',
            auth: {
                enabled: true,
                provider: 'oauth2',
                oauth2: { requiredScopes: [], resourceName: 'test-mcp' },
            },
        }],
        listenHost: '127.0.0.1', listenPort: 0,
    }, runtime);
    await host.server.start();
    try {
        await assert.rejects(host.prepare(), /publicBaseUrl and storageDir/);
        const address = host.server.address;
        assert.ok(typeof address === 'object' && address !== null);
        const response = await fetch(`http://127.0.0.1:${address.port}${await appAssetPath()}`, {
            headers: { connection: 'close' },
        });
        assert.equal(response.status, 404);
    } finally {
        await host.stop();
    }
});
