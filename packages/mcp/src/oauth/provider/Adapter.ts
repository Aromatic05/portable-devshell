import type { Adapter, AdapterFactory, AdapterPayload } from "oidc-provider";
import { errors } from "oidc-provider";
import type { DatabaseSync } from "node:sqlite";
import { McpOAuthOidcDatabase, type OidcRecord, type OidcRevocation } from "./Database.js";

const MAX_CLIENT_RECORDS = 256;
const MAX_DEFAULT_RECORDS = 4096;

export function createMcpOAuthOidcAdapterFactory(
    storageDir: string,
    secureStorage: (path: string) => Promise<void> = async () => {},
    secureFile: (path: string) => Promise<void> = async () => {},
): AdapterFactory & {
    prepare(): Promise<void>;
    transaction<T>(operation: () => Promise<T>, status: () => number): Promise<T>;
    afterCommit(notification: () => void): void;
    revocationsSince(sequence: number): OidcRevocation[];
} {
    const store = new McpOAuthOidcDatabase(storageDir, secureStorage, secureFile);
    const factory: AdapterFactory = (name) => new McpOidcAdapter(name, store);
    return Object.assign(factory, {
        prepare: () => store.prepare(),
        transaction: <T>(operation: () => Promise<T>, status: () => number) =>
            store.transaction(operation, status),
        afterCommit: (notification: () => void) => store.afterCommit(notification),
        revocationsSince: (sequence: number) => store.revocationsSince(sequence),
    });
}

class McpOidcAdapter implements Adapter {
    constructor(private readonly name: string, private readonly store: McpOAuthOidcDatabase) {}

    async consume(id: string): Promise<void> {
        const consumed = await this.store.run(this.name, (database) => {
            const result = database.prepare(`
                UPDATE oidc_records SET consumed = ?
                WHERE model = ? AND id = ? AND consumed IS NULL
                    AND (expires_at IS NULL OR expires_at > ?)
                    AND (grant_id IS NULL OR grant_id NOT IN (SELECT id FROM revoked_grants))
            `).run(now(), this.name, id, now());
            if (result.changes === 1) return true;
            const record = database.prepare("SELECT grant_id FROM oidc_records WHERE model = ? AND id = ?")
                .get(this.name, id) as { grant_id: string | null } | undefined;
            if (record?.grant_id && this.name === "RefreshToken") this.#revoke(database, record.grant_id);
            return false;
        });
        if (!consumed) throw new errors.InvalidGrant("token already used or revoked");
    }

    async destroy(id: string): Promise<void> {
        await this.store.run(this.name, (database) => {
            database.prepare("DELETE FROM oidc_records WHERE model = ? AND id = ?").run(this.name, id);
        });
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
        return await this.#find("id", id);
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
        return await this.#find("uid", uid);
    }

    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
        return await this.#find("user_code", userCode);
    }

    async revokeByGrantId(grantId: string): Promise<void> {
        await this.store.run(this.name, (database) => {
            this.#revoke(database, grantId);
        });
    }

    #revoke(database: DatabaseSync, grantId: string): void {
        // Fence saves from stale model instances, including other processes.
        // Grant IDs are random and never reused; this fence must not expire.
        database.prepare("INSERT OR IGNORE INTO revoked_grants (id) VALUES (?)").run(grantId);
        database.prepare("DELETE FROM oidc_records WHERE grant_id = ?").run(grantId);
        this.store.markRevoked();
    }

    async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
        await this.store.run(this.name, (database) => {
            const grantId = this.name === "Grant" ? id : payload.grantId ?? null;
            if (grantId !== null && database.prepare("SELECT id FROM revoked_grants WHERE id = ?").get(grantId)) {
                throw new errors.InvalidGrant("grant is revoked");
            }
            database.prepare("DELETE FROM oidc_records WHERE expires_at <= ?").run(now());
            const exists = database.prepare("SELECT id FROM oidc_records WHERE model = ? AND id = ?").get(this.name, id);
            const count = database.prepare("SELECT count(*) AS count FROM oidc_records WHERE model = ?").get(this.name) as { count: number };
            const limit = this.name === "Client" ? MAX_CLIENT_RECORDS : MAX_DEFAULT_RECORDS;
            if (!exists && count.count >= limit) {
                throw new Error(`OIDC ${this.name} storage limit of ${limit} records was reached.`);
            }
            database.prepare(`
                INSERT INTO oidc_records (model, id, payload, expires_at, consumed, grant_id, uid, user_code)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(model, id) DO UPDATE SET
                    payload = excluded.payload, expires_at = excluded.expires_at,
                    consumed = coalesce(oidc_records.consumed, excluded.consumed),
                    grant_id = excluded.grant_id, uid = excluded.uid, user_code = excluded.user_code
            `).run(this.name, id, JSON.stringify(payload),
                expiresIn !== undefined && expiresIn > 0 ? now() + expiresIn : null,
                typeof payload.consumed === "number" ? payload.consumed : null,
                grantId, payload.uid ?? null, payload.userCode ?? null);
        });
    }

    async #find(column: "id" | "uid" | "user_code", value: string): Promise<AdapterPayload | undefined> {
        return await this.store.run(this.name, (database) => {
            const record = database.prepare(`
                SELECT payload, consumed FROM oidc_records
                WHERE model = ? AND ${column} = ? AND (expires_at IS NULL OR expires_at > ?)
                    AND (grant_id IS NULL OR grant_id NOT IN (SELECT id FROM revoked_grants))
            `).get(this.name, value, now()) as OidcRecord | undefined;
            if (record === undefined) return undefined;
            return { ...JSON.parse(record.payload) as AdapterPayload,
                ...(record.consumed === null ? {} : { consumed: record.consumed }) };
        });
    }
}

function now(): number {
    return Math.floor(Date.now() / 1000);
}
