import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { ControlPathHome, createDefaultControlConfig } from '@portable-devshell/shared';
import { McpAppActionStore } from '../../../../../mcp/src/mcpapp/ActionStore.ts';
import { McpAppLeaseStore } from '../../../../../mcp/src/mcpapp/app/Lease.ts';
import { McpAppRuntime } from '../../../../../mcp/src/mcpapp/index.ts';
import { createTestTempDirectory } from '../../../../../../test/TestTempDirectory.ts';
import { ContextRegistry } from '../../../../src/context/registry/index.ts';
import { ControlHttpServer } from "../../../../src/server/http/index.ts";
import { McpControlModule } from '../../../../src/server/mcp/Module.ts';
import { createToolCallRegistry } from '../../../../src/toolcall/index.ts';

test('MCP App reconciles terminated Contexts on startup and revokes leases on disable', async (t) => {
    const home = await createTestTempDirectory('mcpapp-context-lifecycle');
    t.after(async () => await rm(home, { force: true, recursive: true }));
    const paths = new ControlPathHome(home);
    const registry = new ContextRegistry({ filePath: paths.contextsFile });
    await registry.initialize();
    const active = await registry.create({ principal: 'local' });
    const disabled = await registry.create({ principal: 'local' });
    const old = new McpAppRuntime({ filePath: paths.mcpAppLeasesFile });
    await old.initialize();
    const activeToken = await old.leases.issue('demo', active.ctxId);
    const disabledToken = await old.leases.issue('demo', disabled.ctxId);
    await old.actions.prepareOnce(disabled.ctxId, 'demo', { actionId: 'disabled-receipt', itemId: 'task-one', instance: 'demo', operation: 'task-pause', targetId: 'task-one' });
    await registry.disable(disabled.ctxId);

    const changes: Array<{ ctxIds: readonly string[]; terminalCtxIds?: readonly string[] }> = [];
    const unsubscribe = registry.changes.onChange((change) => changes.push(change));
    t.after(unsubscribe);
    const module = new McpControlModule({
        http: new ControlHttpServer(),
        artifact: { service: {}, installHttpRoute() {} } as never,
        config: createDefaultControlConfig(),
        context: {} as never,
        contextChanges: registry.changes,
        contextRecords: () => registry.list(),
        controlPaths: paths,
        instances: { list: () => [] } as never,
        toolRegistry: createToolCallRegistry(),
    });
    await module.start();
    const afterStartup = new McpAppLeaseStore({ filePath: paths.mcpAppLeasesFile });
    await afterStartup.initialize();
    assert.equal(await afterStartup.verify('demo', active.ctxId, activeToken), true);
    assert.equal(await afterStartup.verify('demo', disabled.ctxId, disabledToken), false);
    const receiptStore = new McpAppActionStore({ filePath: `${paths.mcpAppLeasesFile}.actions` });
    await receiptStore.initialize();
    assert.equal(await receiptStore.get('disabled-receipt'), undefined);

    await registry.renew(active.ctxId);
    assert.equal(changes.at(-1)?.terminalCtxIds, undefined);
    await registry.disable(active.ctxId);
    await module.stop();
    assert.ok(changes.some((change) => change.terminalCtxIds?.includes(active.ctxId)));
    const afterDisable = new McpAppLeaseStore({ filePath: paths.mcpAppLeasesFile });
    await afterDisable.initialize();
    assert.equal(await afterDisable.verify('demo', active.ctxId, activeToken), false);
});

test('MCP App revokes instance and Context credentials without touching sibling Contexts', async (t) => {
    const home = await createTestTempDirectory('mcpapp-retire-records');
    t.after(async () => await rm(home, { force: true, recursive: true }));
    const paths = new ControlPathHome(home);
    const app = new McpAppRuntime({ filePath: paths.mcpAppLeasesFile });
    await app.initialize();
    const own = await app.leases.issue('alpha', 'ctx-one');
    const sibling = await app.leases.issue('beta', 'ctx-one');
    const unrelated = await app.leases.issue('beta', 'ctx-two');
    await app.revokeInstance('alpha');
    assert.equal(await app.leases.verify('alpha', 'ctx-one', own), false);
    assert.equal(await app.leases.verify('beta', 'ctx-one', sibling), true);
    await app.revokeContext('ctx-one');
    assert.equal(await app.leases.verify('beta', 'ctx-one', sibling), false);
    assert.equal(await app.leases.verify('beta', 'ctx-two', unrelated), true);
    const restarted = new McpAppActionStore({ filePath: `${paths.mcpAppLeasesFile}.actions` });
    await restarted.initialize();
    assert.deepEqual(await restarted.contextIds(), []);
});
