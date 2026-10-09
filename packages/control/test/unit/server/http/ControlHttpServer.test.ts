import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        const remove = lease.registerRawRoute("get", "/artifact/:token", (_req, res) => { res.end("found"); });
        assert.equal(await (await fetch(`${origin}/artifact/abc`)).text(), "found");
        assert.equal((await fetch(`${origin}/artifact/abc/extra`)).status, 404);
        remove();
        assert.equal((await fetch(`${origin}/artifact/abc`)).status, 404);
        for (let i = 0; i < 100; i += 1) {
            const undo = lease.registerRawRoute("get", "/retry", (_req, res) => { res.end("active"); });
            undo();
        }
        assert.equal((await fetch(`${origin}/retry`)).status, 404);
        const final = lease.registerRawRoute("get", "/retry", (_req, res) => { res.end("again"); });
        assert.equal(await (await fetch(`${origin}/retry`)).text(), "again");
        final();
    } finally {
        await http.close();
    }
});


test("static HTTP respects MIME, encoded paths, allowed methods, and HEAD", async () => {
    const directory = await mkdtemp(join(tmpdir(), "control-static-http-"));
    const root = join(directory, "assets");
    const http = new ControlHttpServer();
    const lease = http.acquire({ listenHost: "127.0.0.1", listenPort: 0 });
    try {
        await mkdir(join(root, "sub"), { recursive: true });
        await writeFile(join(root, "manifest.webmanifest"), "{}", "utf8");
        await writeFile(join(root, "file with space.txt"), "encoded", "utf8");
        await writeFile(join(root, "sub", "index.html"), "<title>sub</title>", "utf8");
        lease.registerStaticDirectory("/web", root);
        await lease.start();
        const address = lease.address;
        assert.ok(address && typeof address !== "string");
        const base = `http://127.0.0.1:${address.port}/web`;
        const manifest = await fetch(`${base}/manifest.webmanifest`);
        assert.equal(manifest.status, 200);
        assert.match(manifest.headers.get("content-type") ?? "", /^application\/manifest\+json/u);
        assert.equal(await (await fetch(`${base}/file%20with%20space.txt`)).text(), "encoded");
        assert.equal(await (await fetch(`${base}/sub/`)).text(), "<title>sub</title>");
        const head = await fetch(`${base}/file%20with%20space.txt`, { method: "HEAD" });
        assert.equal(head.status, 200);
        assert.equal(head.headers.get("content-length"), "7");
        assert.equal(await head.text(), "");
        const post = await fetch(`${base}/manifest.webmanifest`, { method: "POST" });
        assert.equal(post.status, 405);
        assert.equal(post.headers.get("allow"), "GET, HEAD");
        assert.equal((await fetch(`${base}/file%ZZ.txt`)).status, 400);
        assert.equal((await fetch(`${base}/missing.txt`)).status, 404);
    } finally {
        await http.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("static HTTP rejects symlink escapes and decoded traversal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "control-static-symlink-"));
    const root = join(directory, "assets");
    const outside = join(directory, "secret.txt");
    const http = new ControlHttpServer();
    const lease = http.acquire({ listenHost: "127.0.0.1", listenPort: 0 });
    try {
        await mkdir(root);
        await writeFile(outside, "not public", "utf8");
        await writeFile(join(root, "public.txt"), "public", "utf8");
        await symlink(outside, join(root, "escape.txt"));
        await symlink(directory, join(root, "escape-dir"));
        lease.registerStaticDirectory("/static", root);
        await lease.start();
        const address = lease.address;
        assert.ok(address && typeof address !== "string");
        const base = `http://127.0.0.1:${address.port}/static`;
        assert.equal(await (await fetch(`${base}/public.txt`)).text(), "public");
        assert.equal((await fetch(`${base}/escape.txt`)).status, 403);
        assert.equal((await fetch(`${base}/escape-dir/secret.txt`)).status, 403);
        assert.equal((await fetch(`${base}/%2e%2e%2fsecret.txt`)).status, 403);
    } finally {
        await http.close();
        await rm(directory, { recursive: true, force: true });
    }
});
