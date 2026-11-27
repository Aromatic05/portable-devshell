import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { ContextExternalBinding } from "@portable-devshell/shared";
import type { ContextStoredRecord } from "../Model.js";
import { parseRecord } from "./Record.js";

/**
 * Durable Context authority after GC of the live record. Cleanup obligations
 * and Worker-owned temporary directories are never retained in this index.
 */
export class ContextIdentityArchive {
    readonly #database: DatabaseSync;

    constructor(path: string) {
        this.#database = new DatabaseSync(path);
        chmodSync(path, 0o600);
        this.#database.exec([
            "PRAGMA foreign_keys = ON;",
            "CREATE TABLE IF NOT EXISTS context_identity (",
            "ctx_id TEXT PRIMARY KEY, principal TEXT NOT NULL, record TEXT NOT NULL);",
            "CREATE TABLE IF NOT EXISTS context_binding (",
            "ctx_id TEXT NOT NULL REFERENCES context_identity(ctx_id) ON DELETE CASCADE,",
            "principal TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,",
            "PRIMARY KEY (ctx_id, principal, kind, value));",
            "CREATE INDEX IF NOT EXISTS context_binding_lookup",
            "ON context_binding (principal, kind, value);",
            "CREATE TABLE IF NOT EXISTS context_instance (",
            "ctx_id TEXT NOT NULL REFERENCES context_identity(ctx_id) ON DELETE CASCADE,",
            "instance TEXT NOT NULL, PRIMARY KEY (ctx_id, instance));",
            "CREATE INDEX IF NOT EXISTS context_instance_lookup",
            "ON context_instance (instance);",
        ].join("\n"));
    }

    has(ctxId: string): boolean {
        return this.#database.prepare(
            "SELECT 1 FROM context_identity WHERE ctx_id = ?",
        ).get(ctxId) !== undefined;
    }

    get(ctxId: string): ContextStoredRecord | undefined {
        const row = this.#database.prepare(
            "SELECT record FROM context_identity WHERE ctx_id = ?",
        ).get(ctxId) as { record?: unknown } | undefined;
        if (typeof row?.record !== "string") return undefined;
        const record = parseRecord(JSON.parse(row.record) as unknown);
        if (record === undefined || record.ctxId !== ctxId || record.status !== "expired")
            throw new Error("Invalid collected Context authority record.");
        return record;
    }

    list(): ContextStoredRecord[] {
        const rows = this.#database.prepare(
            "SELECT ctx_id FROM context_identity",
        ).all() as Array<{ ctx_id: string }>;
        return rows.map(({ ctx_id }) => this.get(ctx_id)!);
    }

    byExternal(external: ContextExternalBinding, principal: string): ContextStoredRecord[] {
        const rows = this.#database.prepare(
            "SELECT ctx_id FROM context_binding WHERE principal = ? AND kind = ? AND value = ?",
        ).all(principal, external.kind, external.value) as Array<{ ctx_id: string }>;
        return rows.map(({ ctx_id }) => this.get(ctx_id)!);
    }

    byInstance(instance: string): ContextStoredRecord[] {
        const rows = this.#database.prepare(
            "SELECT ctx_id FROM context_instance WHERE instance = ?",
        ).all(instance) as Array<{ ctx_id: string }>;
        return rows.map(({ ctx_id }) => this.get(ctx_id)!);
    }

    collect(record: ContextStoredRecord): void {
        if (
            record.status !== "expired" ||
            record.cleanupPending !== false ||
            (record.pendingEnvironmentCleanup?.length ?? 0) !== 0
        )
            throw new Error("Cannot collect a Context with unfinished cleanup.");

        const identity: ContextStoredRecord = {
            createdAt: record.createdAt,
            ctxId: record.ctxId,
            environments: record.environments.map(({ instance, workspace }) => ({
                instance,
                ...(workspace === undefined ? {} : { workspace }),
            })),
            expiresAt: record.expiresAt,
            lastAccessedAt: record.lastAccessedAt,
            principal: record.principal,
            status: "expired",
            cleanupPending: false,
            ...(record.externalBindings === undefined
                ? {}
                : { externalBindings: record.externalBindings }),
            ...(record.remoteInstanceHandles === undefined
                ? {}
                : { remoteInstanceHandles: record.remoteInstanceHandles }),
            ...(record.maskedInstances === undefined
                ? {}
                : { maskedInstances: record.maskedInstances }),
        };

        this.#database.exec("BEGIN IMMEDIATE");
        try {
            this.#database.prepare(
                "INSERT OR REPLACE INTO context_identity(ctx_id, principal, record) VALUES (?, ?, ?)",
            ).run(identity.ctxId, identity.principal, JSON.stringify(identity));
            this.#database.prepare("DELETE FROM context_binding WHERE ctx_id = ?").run(identity.ctxId);
            this.#database.prepare("DELETE FROM context_instance WHERE ctx_id = ?").run(identity.ctxId);
            const binding = this.#database.prepare(
                "INSERT INTO context_binding(ctx_id, principal, kind, value) VALUES (?, ?, ?, ?)",
            );
            for (const external of identity.externalBindings ?? [])
                binding.run(identity.ctxId, identity.principal, external.kind, external.value);
            const instance = this.#database.prepare(
                "INSERT INTO context_instance(ctx_id, instance) VALUES (?, ?)",
            );
            const instances = new Set([
                ...identity.environments.map((environment) => environment.instance),
                ...(identity.remoteInstanceHandles ?? []).map((handle) => handle.instance),
            ]);
            for (const instanceName of instances)
                instance.run(identity.ctxId, instanceName);
            this.#database.exec("COMMIT");
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    }

    forget(ctxId: string): void {
        this.#database.prepare("DELETE FROM context_identity WHERE ctx_id = ?").run(ctxId);
    }

    close(): void {
        this.#database.close();
    }
}
