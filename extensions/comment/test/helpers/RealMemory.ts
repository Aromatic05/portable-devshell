import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { asInstanceName, type JsonValue } from "@portable-devshell/shared";
import type { ExtensionContextObserveCapability } from "@portable-devshell/extension/context";
import type { ExtensionWorkerExecuteCapability, ExtensionWorkerOpenInput } from "@portable-devshell/extension/worker";
import { createTestWorkerInstance } from "../../../../packages/core/test/support/WorkerInstance.ts";
import { WorkerToolCatalog } from "../../../../packages/core/src/toolcall/worker/Catalog.ts";
import { WorkerToolInvoker } from "../../../../packages/core/src/toolcall/worker/Invoker.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { resolveTestWorkerBinary } from "../../../../test/TestPlatformSupport.ts";
import { CommentService } from "../../src/comment/CommentService.ts";
import { MessageStore } from "../../src/message/store/MessageStore.ts";
import { MailingService } from "../../src/mailing/Service.ts";
import { databaseConnection } from "./Database.ts";

export const workerBinary = resolveTestWorkerBinary();
export const ROOT = "var/agent-work";
export const STATE = `${ROOT}/.mailing/state.json`;
export const INBOX = `${ROOT}/receiver/mailbox.md`;
export const OUTBOX = `${ROOT}/sender/chat.md`;
export function mail(subject = "Durable subject", body = "Original body α\n\nKeep every line", to = "receiver"): string {
    return `<!-- MAIL BEGIN -->\nTo: ${to}\nSubject: ${subject}\n\n${body}\n<!-- MAIL END -->\n`;
}

/** The only adapter is the Extension capability boundary; all file tools run in Rust over IPC. */
export async function realMemory(t: TestContext) {
    assert.ok(workerBinary, "prepare a real devshell-worker before running this suite");
    const root = await createTestTempDirectory("round4-comment-memory");
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const runtime = join(root, "runtime");
    await Promise.all([mkdir(workspace), mkdir(home), mkdir(runtime)]);
    const instance = asInstanceName(`r4-memory-${process.pid}-${randomUUID().slice(0, 8)}`);
    const workerInstance = createTestWorkerInstance({
        name: instance, homeDirectory: home, workerBinaryPath: workerBinary,
        env: { ...process.env, HOME: home, USERPROFILE: home, XDG_RUNTIME_DIR: runtime },
    });
    const services: MailingService[] = [];
    const stores: MessageStore[] = [];
    t.after(async () => {
        for (const service of services) await service.close();
        for (const store of stores) await store.close();
        await workerInstance.supervision.lifecycle.stop();
        await workerInstance.supervision.close();
    });
    await workerInstance.supervision.lifecycle.start();
    const catalog = new WorkerToolCatalog();
    catalog.refresh(await workerInstance.readWorkerTools());
    const invoker = new WorkerToolInvoker(workerInstance.supervision.endpoint, `${instance}-worker`, catalog);
    const active = new Set(["owner", "successor", "unrelated"]);
    const contexts = {
        async list(query?: { instance?: string; workspace?: string }) {
            if (query?.instance !== undefined && query.instance !== instance) return [];
            if (query?.workspace !== undefined && query.workspace !== workspace) return [];
            return [...active].map((ctxId) => ({ ctxId, status: "active" as const,
                createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                environments: [{ instance, workspace }] }));
        },
    } as ExtensionContextObserveCapability;
    let beforeTool: ((name: string, input: JsonValue) => Promise<void>) | undefined;
    let afterTool: ((name: string, input: JsonValue, result: JsonValue) => Promise<void>) | undefined;
    let beforeNotice: (() => Promise<void>) | undefined;
    const worker: ExtensionWorkerExecuteCapability = {
        async openSession(input: ExtensionWorkerOpenInput) {
            assert.equal(input.instance, instance);
            assert.equal(input.workspace, workspace);
            const prepared = await workerInstance.execution.environment.prepareWorkspace(workspace);
            return {
                instance, workspace, environment: workerInstance.supervision.handshake!,
                closed: new Promise<void>(() => {}), listTools: () => catalog.listTools(),
                async callTool(name, input) {
                    await beforeTool?.(name, input as JsonValue);
                    const result = await invoker.invoke(name, input as JsonValue, {
                        source: "extension", extensionId: "comment", workspace: prepared.workspace,
                    });
                    await afterTool?.(name, input as JsonValue, result);
                    return result;
                },
                async close() {},
            };
        },
    };
    const events: string[] = [];
    function newComment(suffix = "message") {
        const filePath = join(root, `${suffix}.sqlite3`);
        const store = new MessageStore({ filePath, instanceName: instance,
            openDatabase: () => databaseConnection(filePath) });
        stores.push(store);
        return new CommentService({ instanceName: instance, store,
            appendEvent: async (type) => { events.push(type); } });
    }
    let comment = newComment();
    const errors: unknown[] = [];
    function newMailing() {
        const service = new MailingService({ worker, contexts, pollMs: 3_600_000,
            comment: { async queue(_instance, ctxId, text) {
                await beforeNotice?.();
                await comment.queue({ ctxId, text });
            } }, onError: (error) => { errors.push(error); } });
        services.push(service);
        return service;
    }
    const target = { instance, workspace };
    const owner = { ...target, ctxId: "owner" };
    async function put(path: string, text: string) {
        const absolute = join(workspace, path);
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, text);
    }
    async function read(path: string) { return await readFile(join(workspace, path), "utf8"); }
    return { root, workspace, instance, target, owner, active, contexts, worker, events, errors,
        get comment() { return comment; }, newMailing, newComment, put, read,
        setBeforeTool(value: typeof beforeTool) { beforeTool = value; },
        setAfterTool(value: typeof afterTool) { afterTool = value; },
        setBeforeNotice(value: typeof beforeNotice) { beforeNotice = value; },
        async restartComment() {
            await comment.retire();
            for (const store of stores) await store.close();
            comment = newComment();
        },
    };
}

export function editsPath(input: JsonValue, path: string): boolean {
    return typeof input === "object" && input !== null && !Array.isArray(input) &&
        typeof input.changes === "string" && input.changes.includes(`File: ${path}\n`);
}
