import assert from "node:assert/strict";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";

import { assertTestspaceLifecycleEnvironment } from "./TestspaceNamespace.mjs";
import { withTestspaceControlConnection } from "./TestspaceReverse.mjs";

const INSTANCES = ["testspace-local", "testspace-reverse"];

/** Exercise live Control Web/Instance updates and rejected unsafe replacements. */
export async function runTestspaceUpdateSmoke(runtimeDirectory = process.env.XDG_RUNTIME_DIR) {
    assertTestspaceLifecycleEnvironment(process.env.DEVSHELL_TESTSPACE_ROOT, {
        ...process.env,
        XDG_RUNTIME_DIR: runtimeDirectory,
    });
    return await withTestspaceControlConnection(runtimeDirectory, async (shared, endpoint) => {
        const config = shared.createConfigTransport(endpoint);
        const initial = await config.snapshot();
        const original = initial.view.web;
        assert.equal(original.enabled, true);
        assert.equal(original.listenHost, "127.0.0.1");
        assert.match(original.publicBaseUrl, /^http:\/\/127\.0\.0\.1:/u);
        const first = await workerSnapshots(shared, endpoint);
        for (const snapshot of Object.values(first)) assert.equal(snapshot.ready, true);

        const replacementPort = await freePort();
        assert.notEqual(replacementPort, original.listenPort);
        let failed = false;
        let errorMessage;
        let activeRevision;
        try {
            await config.updateWeb({ patch: {
                listenPort: replacementPort,
                publicBaseUrl: `http://127.0.0.1:${replacementPort}`,
            } });
            const active = await config.snapshot();
            activeRevision = active.revision;
            assert.ok(active.revision > initial.revision);
            assert.equal(active.view.web.listenPort, replacementPort);
            await requireWeb(replacementPort);

            const conflict = await reservePort();
            try {
                await assert.rejects(
                    config.updateWeb({ patch: {
                        listenPort: conflict.port,
                        publicBaseUrl: `http://127.0.0.1:${conflict.port}`,
                    } }),
                    (error) => {
                        errorMessage = error.message;
                        return /bind|address.*in use|listen|preflight/iu.test(error.message);
                    },
                );
            } finally {
                await closeServer(conflict.server);
            }

            // Failure must not commit any config, replace the running listener,
            // kill either Worker, or increment the committed config revision.
            const preserved = await config.snapshot();
            assert.equal(preserved.revision, active.revision);
            assert.deepEqual(preserved.view.web, active.view.web);
            await requireWeb(replacementPort);
            const afterFailure = await workerSnapshots(shared, endpoint);
            for (const instance of INSTANCES) {
                assert.equal(afterFailure[instance].ready, true);
                assert.equal(afterFailure[instance].pid, first[instance].pid);
            }
            failed = true;
        } finally {
            const current = (await config.snapshot()).view.web;
            if (current.listenPort !== original.listenPort || current.publicBaseUrl !== original.publicBaseUrl) {
                await config.updateWeb({ patch: {
                    listenPort: original.listenPort,
                    publicBaseUrl: original.publicBaseUrl,
                } });
            }
            await requireWeb(original.listenPort);
            assert.deepEqual((await config.snapshot()).view.web, original);
        }
        assert.equal(failed, true);
        const webRestoredRevision = (await config.snapshot()).revision;
        const instanceUpdates = await exerciseInstanceUpdates(shared, endpoint, config, first);
        const final = await workerSnapshots(shared, endpoint);
        for (const instance of INSTANCES) {
            assert.equal(final[instance].ready, true);
            assert.equal(final[instance].pid, first[instance].pid);
        }
        return {
            hotReplacement: "passed",
            rejectedOccupiedListener: "passed",
            originalPort: original.listenPort,
            replacementPort,
            revisionBefore: initial.revision,
            revisionAfterReplacement: activeRevision,
            revisionAfterWebRestore: webRestoredRevision,
            rejectedError: errorMessage,
            workersRemainReady: true,
            ...instanceUpdates,
        };
    });
}

async function exerciseInstanceUpdates(shared, endpoint, config, originalWorkers) {
    const before = await config.snapshot();
    const instanceName = INSTANCES[0];
    const original = before.view.instances.find((entry) => entry.name === instanceName);
    assert.ok(original);
    assert.ok(original.extensions.model.includes("skill"));
    const reduced = original.extensions.model.filter((item) => item !== "skill");
    let rejectedError;
    let updatedRevision;
    try {
        await config.update({ instance: {
            instanceName,
            patch: { extensions: { model: reduced } },
        } });
        const updated = await config.snapshot();
        updatedRevision = updated.revision;
        assert.ok(updated.revision > before.revision);
        assert.deepEqual(updated.view.instances.find((entry) => entry.name === instanceName).extensions.model, reduced);

        // A running Worker must reject a change requiring generation rebuild
        // before persistence or runtime mutation. Other instances stay ready.
        await assert.rejects(
            config.update({ instance: {
                instanceName,
                patch: { alerts: { intervalMs: 2000 } },
            } }),
            (error) => {
                rejectedError = error.message;
                return /must be stopped before rebuilding/u.test(error.message);
            },
        );
        const afterFailure = await config.snapshot();
        assert.equal(afterFailure.revision, updated.revision);
        assert.deepEqual(afterFailure.view.instances.find((entry) => entry.name === instanceName),
            updated.view.instances.find((entry) => entry.name === instanceName));
        const workers = await workerSnapshots(shared, endpoint);
        for (const instance of INSTANCES) {
            assert.equal(workers[instance].ready, true);
            assert.equal(workers[instance].pid, originalWorkers[instance].pid);
        }
    } finally {
        const current = (await config.snapshot()).view.instances.find((entry) => entry.name === instanceName);
        if (JSON.stringify(current?.extensions.model) !== JSON.stringify(original.extensions.model)) {
            await config.update({ instance: {
                instanceName,
                patch: { extensions: { model: original.extensions.model } },
            } });
        }
        assert.deepEqual((await config.snapshot()).view.instances.find((entry) => entry.name === instanceName), original);
    }
    return {
        instanceHotUpdate: "passed",
        runningWorkerRebuildRejected: "passed",
        updatedRevision,
        rejectedWorkerUpdateError: rejectedError,
    };
}

async function workerSnapshots(shared, endpoint) {
    const result = {};
    for (const instance of INSTANCES) {
        result[instance] = (await shared.createProcessTransport(endpoint, instance).snapshot()).snapshot;
    }
    return result;
}

async function requireWeb(port) {
    const url = `http://127.0.0.1:${port}/web/`;
    let lastError;
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
            if (response.status >= 200 && response.status < 400) return;
            lastError = new Error(`Web returned HTTP ${response.status}`);
        } catch (error) { lastError = error; }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Web listener ${url} is unavailable: ${String(lastError)}`);
}

async function reservePort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    return { port: address.port, server };
}

async function closeServer(server) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort() {
    const { port, server } = await reservePort();
    await closeServer(server);
    return port;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.log(JSON.stringify(await runTestspaceUpdateSmoke(), null, 2));
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}
