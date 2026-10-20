import type { ExtensionWorkerSession } from "@portable-devshell/extension/worker";
import { hasMailRecord } from "./Protocol.js";

const ROOT = "var/agent-work";
const MAX_READ_BYTES = 8 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Mailing Worker returned an invalid result");
    return value as Record<string, unknown>;
}

function parseLines(value: string): string {
    return value.split("\n").map((line) => {
        const match = /^[0-9]+:(.*)$/u.exec(line);
        if (match === null) throw new Error("Unexpected file_read line encoding");
        return match[1]!;
    }).join("\n");
}

export interface MailingFiles {
    listTasks(): Promise<string[]>;
    listOutboxes(): Promise<string[]>;
    read(path: string): Promise<string | undefined>;
    appendUnique(path: string, marker: string, content: string): Promise<void>;
    replace(path: string, content: string): Promise<void>;
    create(path: string, content: string): Promise<void>;
    close(): Promise<void>;
}

/** All file operations execute on the owning Worker, never on the Control filesystem. */
export class WorkerMailingFiles implements MailingFiles {
    readonly #session: ExtensionWorkerSession;
    constructor(session: ExtensionWorkerSession) { this.#session = session; }
    async close(): Promise<void> { await this.#session.close(); }

    async listTasks(): Promise<string[]> {
        const tasks = new Set<string>();
        let cursor: string | undefined;
        do {
            const value = record(await this.#session.callTool("file_glob",
                cursor === undefined
                    ? { patterns: [`${ROOT}/*`], type: "directory", gitignore: false, hidden: true, maxDepth: 1 }
                    : { cursor }));
            if (!Array.isArray(value.entries)) throw new Error("Invalid file_glob entries");
            for (const entry of value.entries) {
                const path = record(entry).path;
                if (typeof path !== "string") continue;
                const match = /^\.?\/?var\/agent-work\/([^/]+)$/u.exec(path);
                if (match && match[1] !== ".mailing" && /^[a-z0-9][a-z0-9._-]{0,62}$/u.test(match[1]!))
                    tasks.add(match[1]!);
            }
            cursor = typeof value.nextCursor === "string" ? value.nextCursor : undefined;
        } while (cursor !== undefined);
        return [...tasks].sort();
    }

    async listOutboxes(): Promise<string[]> {
        const tasks = new Set<string>();
        let cursor: string | undefined;
        do {
            const value = record(await this.#session.callTool("file_glob",
                cursor === undefined
                    ? { patterns: [ROOT + "/*/chat.md"], type: "file", gitignore: false, hidden: true, maxDepth: 2 }
                    : { cursor }));
            if (!Array.isArray(value.entries)) throw new Error("Invalid file_glob entries");
            for (const entry of value.entries) {
                const path = record(entry).path;
                if (typeof path !== "string") continue;
                const match = /^\.?\/?var\/agent-work\/([^/]+)\/chat\.md$/u.exec(path);
                if (match && /^[a-z0-9][a-z0-9._-]{0,62}$/u.test(match[1]!))
                    tasks.add(match[1]!);
            }
            cursor = typeof value.nextCursor === "string" ? value.nextCursor : undefined;
        } while (cursor !== undefined);
        return [...tasks].sort();
    }

    async read(path: string): Promise<string | undefined> {
        let selector: string | undefined;
        const lines: string[] = [];
        let bytes = 0;
        do {
            const value = record(await this.#session.callTool("file_read", {
                files: [{ path, view: "content", ...(selector === undefined ? {} : { selector }) }],
            }));
            if (!Array.isArray(value.files) || value.files.length !== 1) throw new Error("Invalid file_read response");
            const entry = record(value.files[0]);
            if (entry.error !== undefined) {
                const error = record(entry.error);
                if (error.code === "file.notFound") return undefined;
                throw new Error(`Mailing file_read ${path}: ${String(error.message ?? error.code)}`);
            }
            if (typeof entry.content !== "string") throw new Error(`Invalid text content in ${path}`);
            const text = entry.content.length === 0 ? "" : parseLines(entry.content);
            bytes += Buffer.byteLength(text, "utf8");
            if (bytes > MAX_READ_BYTES) throw new Error(`Mailing file exceeds 8 MiB: ${path}; archive it before continuing`);
            if (text !== "") lines.push(text);
            selector = typeof entry.nextSelector === "string" ? entry.nextSelector : undefined;
        } while (selector !== undefined);
        return lines.join("\n") + (lines.length > 0 ? "\n" : "");
    }

    async create(path: string, content: string): Promise<void> {
        if ((await this.read(path)) !== undefined) return;
        await this.#edit(`*** Begin Edit\n*** Write File: ${path}\n${content.trimEnd()}\n*** End Edit`);
    }

    async replace(path: string, content: string): Promise<void> {
        const current = await this.read(path);
        if (current === content) return;
        const action = current === undefined ? "Write" : "Rewrite";
        await this.#edit(`*** Begin Edit\n*** ${action} File: ${path}\n${content.trimEnd()}\n*** End Edit`);
    }

    async appendUnique(path: string, marker: string, content: string): Promise<void> {
        const current = await this.read(path);
        if (current !== undefined && hasMailRecord(current, marker, content)) return;
        if (current === undefined) {
            // Create a harmless header first. Always append through a prefixed patch,
            // so user mail bodies cannot impersonate *** End Edit control lines.
            const header = path.endsWith("/mailing.md") ? "# Mailing List" : "# Mailbox";
            await this.#edit(`*** Begin Edit\n*** Write File: ${path}\n${header}\n*** End Edit`);
            await this.read(path); // establish a file_edit snapshot for the new target
        }
        const additions = content.trimEnd().split("\n").map((line) => `+${line}`).join("\n");
        await this.#edit(`*** Begin Edit\n*** Patch File: ${path}\n@@ EOF\n${additions}\n*** End Edit`);
    }

    async #edit(changes: string): Promise<void> {
        const result = record(await this.#session.callTool("file_edit", { changes, resultDetail: "summary" }));
        if (!Array.isArray(result.operations) || result.operations.length !== 1)
            throw new Error("Mailing file_edit returned invalid result");
        const operation = record(result.operations[0]);
        if (operation.status !== "applied") {
            const error = operation.error === undefined ? undefined : record(operation.error);
            throw new Error(`Mailing file_edit failed: ${String(error?.message ?? operation.status)}`);
        }
    }
}
