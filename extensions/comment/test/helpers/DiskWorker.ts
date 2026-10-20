import assert from "node:assert/strict";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ExtensionWorkerExecuteCapability } from "@portable-devshell/extension/worker";
import type { JsonValue } from "@portable-devshell/shared";

/** Disk-backed capability fixture, not a Rust file_edit/IPC implementation test.
 * Faults are injected at real write boundaries; mail parsing, dispatch, state,
 * notification queue and SQLite are production implementations.
 */
export function diskWorker(workspace: string, instance: string, hooks: {
    before(name: string, input: JsonValue): Promise<void>;
    after(name: string, input: JsonValue, result: JsonValue): Promise<void>;
}): ExtensionWorkerExecuteCapability {
    function path(relative: string) {
        const absolute = resolve(workspace, relative);
        assert.ok(absolute.startsWith(workspace + sep));
        return absolute;
    }
    async function call(name: string, raw: JsonValue): Promise<JsonValue> {
        const input = raw as Record<string, JsonValue>;
        if (name === "file_glob") {
            const root = path("var/agent-work");
            const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
                assert.equal(error.code, "ENOENT");
                return [];
            });
            const directories = entries.filter((entry) => entry.isDirectory());
            if (input.type === "directory") return { entries: directories.map((entry) => ({ path: `var/agent-work/${entry.name}`, type: "directory" })) };
            const outboxes: Array<{ path: string; type: string }> = [];
            for (const entry of directories) {
                const relative = `var/agent-work/${entry.name}/chat.md`;
                const exists = await stat(path(relative)).then(() => true, (error: NodeJS.ErrnoException) => {
                    assert.equal(error.code, "ENOENT");
                    return false;
                });
                if (exists) outboxes.push({ path: relative, type: "file" });
            }
            return { entries: outboxes };
        }
        if (name === "file_read") {
            const request = (input.files as Array<{ path: string }>)[0]!;
            const text = await readFile(path(request.path), "utf8").catch((error: NodeJS.ErrnoException) => {
                assert.equal(error.code, "ENOENT");
                return undefined;
            });
            if (text === undefined) return { files: [{ error: { code: "file.notFound" } }] };
            return { files: [{ content: text.replace(/\n$/u, "").split("\n").map((line, i) => `${i + 1}:${line}`).join("\n") }] };
        }
        assert.equal(name, "file_edit");
        const lines = String(input.changes).split("\n");
        assert.equal(lines.shift(), "*** Begin Edit");
        assert.equal(lines.pop(), "*** End Edit");
        const header = /^\*\*\* (Write|Rewrite|Patch) File: (.+)$/u.exec(lines.shift()!);
        assert.ok(header);
        const absolute = path(header[2]!);
        await mkdir(dirname(absolute), { recursive: true });
        if (header[1] === "Patch") {
            assert.equal(lines.shift(), "@@ EOF");
            assert.ok(lines.every((line) => line.startsWith("+")));
            const file = await open(absolute, "a");
            try {
                await file.writeFile(lines.map((line) => line.slice(1)).join("\n") + "\n");
                await file.sync();
            } finally { await file.close(); }
        } else {
            const text = lines.join("\n") + "\n";
            if (header[1] === "Write") await writeFile(absolute, text, { flag: "wx" });
            else {
                await writeFile(`${absolute}.fixture-tmp`, text);
                await rename(`${absolute}.fixture-tmp`, absolute);
            }
        }
        return { operations: [{ path: header[2]!, status: "applied" }] };
    }
    return { async openSession(input) {
        assert.equal(input.instance, instance);
        assert.equal(input.workspace, workspace);
        return { instance, workspace,
            environment: { homeDirectory: workspace, platform: { arch: process.arch, os: process.platform } },
            closed: new Promise<void>(() => {}), listTools: () => [], async close() {},
            async callTool(name, input) {
                await hooks.before(name, input as JsonValue);
                const result = await call(name, input as JsonValue);
                await hooks.after(name, input as JsonValue, result);
                return result;
            },
        };
    } };
}
