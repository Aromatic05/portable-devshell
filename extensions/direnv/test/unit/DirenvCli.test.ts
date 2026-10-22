import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { activate } from "../../src/builtin/index.ts";

const execute = promisify(execFile);

async function fixture(t: test.TestContext) {
    const root = await mkdtemp(join(tmpdir(), "direnv-cli-"));
    t.after(async () => await rm(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(home);
    await mkdir(workspace);
    const env = {
        HOME: home,
        // Use the runner's CLI search path: Homebrew installs direnv under
        // /opt/homebrew/bin on macOS, rather than /usr/bin.
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"),
        DIRENV_LOG_FORMAT: "",
        BEFORE_HOOK: "from-earlier-driver",
        REMOVE_ME: "earlier-value",
    };
    let descriptor!: { executable: string; args: string[] };
    activate({ register(_point: unknown, _id: string, value: typeof descriptor) {
        descriptor = value;
    } } as never);
    return { root, workspace, env, descriptor };
}

test("direnv real CLI exports prior-hook values and removals inherited by a child", { timeout: 10_000 }, async (t) => {
    const { workspace, env, descriptor } = await fixture(t);
    await writeFile(join(workspace, ".envrc"), 'export AFTER_HOOK="$BEFORE_HOOK:direnv"\nunset REMOVE_ME\n');
    await execute(descriptor.executable, ["allow"], { cwd: workspace, env });
    const exported = await execute(descriptor.executable, descriptor.args, { cwd: workspace, env });
    const patch = JSON.parse(exported.stdout);
    assert.equal(patch.AFTER_HOOK, "from-earlier-driver:direnv");
    assert.equal(patch.REMOVE_ME, null);
    const inherited: NodeJS.ProcessEnv = { ...env, ...patch };
    delete inherited.REMOVE_ME;
    const child = await execute("/bin/sh", ["-c", 'printf "%s\\n%s" "$AFTER_HOOK" "${REMOVE_ME-unset}"'], {
        cwd: workspace, env: inherited,
    });
    assert.equal(child.stdout, "from-earlier-driver:direnv\nunset");
    assert.equal(env.REMOVE_ME, "earlier-value");
});

test("direnv real CLI recovers after approval and unloads workspace values after a cwd switch", { timeout: 10_000 }, async (t) => {
    const { root, workspace, env, descriptor } = await fixture(t);
    await writeFile(join(workspace, ".envrc"), 'export WORKSPACE_ONLY="approved-value"\n');
    await assert.rejects(execute(descriptor.executable, descriptor.args, { cwd: workspace, env }), /blocked|allow/i);
    await execute(descriptor.executable, ["allow"], { cwd: workspace, env });
    const approved = await execute(descriptor.executable, descriptor.args, { cwd: workspace, env });
    const patch = JSON.parse(approved.stdout);
    assert.equal(patch.WORKSPACE_ONLY, "approved-value");
    const other = join(root, "other");
    await mkdir(other);
    const unrelated = await execute(descriptor.executable, descriptor.args, { cwd: other, env: { ...env, ...patch } });
    assert.equal(JSON.parse(unrelated.stdout).WORKSPACE_ONLY, null);
});
