import assert from "node:assert/strict";
import test from "node:test";
import { ControlHttpServer } from "../../../../src/server/http/index.js";

test("leases share a listener and route registrations can be revoked independently", async () => {
    const http = new ControlHttpServer();
    const first = http.acquire({ listenHost: "127.0.0.1", listenPort: 0 });
    const second = http.acquire({ listenHost: "127.0.0.1", listenPort: 0 });
    const remove = first.registerRawRoute("get", "/first", (_req, res) => {
        res.end("first");
    });
    second.registerRawPrefix("/second", (_req, res) => {
        res.end("second");
    });
    try {
        await Promise.all([first.start(), second.start()]);
        assert.deepEqual(first.address, second.address);
        const address = first.address;
        assert.equal(typeof address, "object");
        if (!address || typeof address === "string") throw new Error("Expected an IP listener address");
        remove();
        assert.equal(await (await fetch(`http://127.0.0.1:${address.port}/first`)).status, 404);
        assert.equal(await (await fetch(`http://127.0.0.1:${address.port}/second/path`)).text(), "second");
        await first.stop();
        assert.equal(await (await fetch(`http://127.0.0.1:${address.port}/second/path`)).text(), "second");
    } finally {
        await http.close();
    }
});

test("failed bind rolls back and a stopped lease can restart", async () => {
    const http = new ControlHttpServer();
    const blocker = http.acquire({ listenHost: "127.0.0.1", listenPort: 0 });
    await blocker.start();
    const address = blocker.address;
    assert.ok(address && typeof address !== "string");
    const conflict = http.acquire({ listenHost: "127.0.0.1", listenPort: address.port });
    await assert.rejects(conflict.start());
    await conflict.stop();
    await blocker.stop();
    await blocker.start();
    await blocker.stop();
    await http.close();
});

test("path parameters and repeated route registration preserve exact routing", async () => {
    const http = new ControlHttpServer();
    const lease = http.acquire({ listenHost: "127.0.0.1", listenPort: 0 });
    try {
        await lease.start();
        const address = lease.address;
        assert.ok(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}`;
        const remove = lease.registerRawRoute("get", "/artifact/:token", (_req, res) => res.end("found"));
        assert.equal(await (await fetch(`${origin}/artifact/abc`)).text(), "found");
        assert.equal((await fetch(`${origin}/artifact/abc/extra`)).status, 404);
        remove();
        assert.equal((await fetch(`${origin}/artifact/abc`)).status, 404);
        for (let i = 0; i < 100; i += 1) {
            const undo = lease.registerRawRoute("get", "/retry", (_req, res) => res.end("active"));
            undo();
        }
        assert.equal((await fetch(`${origin}/retry`)).status, 404);
        const final = lease.registerRawRoute("get", "/retry", (_req, res) => res.end("again"));
        assert.equal(await (await fetch(`${origin}/retry`)).text(), "again");
        final();
    } finally {
        await http.close();
    }
});
