import { diskWorker } from "./DiskWorker.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { asInstanceName, type JsonValue } from "@portable-devshell/shared";
import type { ExtensionContextObserveCapability } from "@portable-devshell/extension/context";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { CommentService } from "../../src/comment/CommentService.ts";
import { MessageStore } from "../../src/message/store/MessageStore.ts";
import { MailingService } from "../../src/mailing/Service.ts";
import { databaseConnection } from "./Database.ts";

export const ROOT = "var/agent-work";
export const STATE = `${ROOT}/.mailing/state.json`;
export const INBOX = `${ROOT}/receiver/mailbox.md`;
export const OUTBOX = `${ROOT}/sender/chat.md`;
export function mail(subject = "Durable subject", body = "Original body α\n\nKeep every line", to = "receiver"): string {
    return `<!-- MAIL BEGIN -->\nTo: ${to}\nSubject: ${subject}\n\n${body}\n<!-- MAIL END -->\n`;
}

/** Real files and SQLite with an explicitly disk-backed Worker capability fixture. */
export async function diskMemory(t: TestContext) {
    const root = await createTestTempDirectory("round4-comment-disk");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const instance = asInstanceName(`r4-memory-${process.pid}-${randomUUID().slice(0, 8)}`);
    const services: MailingService[] = [];
    const stores: MessageStore[] = [];
    t.after(async () => {
        for (const service of services) await service.close();
        for (const store of stores) await store.close();
    });
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
    const worker = diskWorker(workspace, instance, {
        async before(name, input) { await beforeTool?.(name, input); },
        async after(name, input, result) { await afterTool?.(name, input, result); },
    });
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
