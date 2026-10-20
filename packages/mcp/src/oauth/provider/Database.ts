import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMcpOAuthStorageMissing } from "../Storage.js";
import { migrateOidcJsonState, McpOAuthModelMigrationError } from "./Migration.js";

export interface OidcRecord {
    payload: string;
    consumed: number | null;
}

interface RequestTransaction {
    active: boolean;
    revoked: boolean;
    notifications: Array<() => void>;
    ready?: Promise<DatabaseSync>;
    release?: () => void;
}

interface SharedStore {
    lock: AsyncMutex;
    context: AsyncLocalStorage<RequestTransaction>;
}

const stores = new Map<string, SharedStore>();
export const MCP_OAUTH_OIDC_DATABASE = "oidc.sqlite3";
const SCHEMA_VERSION = 1;

export class McpOAuthOidcDatabase {
    #preparation?: Promise<void>;
    #shared?: SharedStore;
    readonly #path: string;

    constructor(
        private readonly directory: string,
        private readonly secureStorage: (path: string) => Promise<void>,
        private readonly secureFile: (path: string) => Promise<void>,
    ) {
        this.#path = join(directory, MCP_OAUTH_OIDC_DATABASE);
    }

    async prepare(): Promise<void> {
        if (this.#preparation === undefined) {
            const attempt = this.#prepare();
            this.#preparation = attempt;
            try { await attempt; }
            catch (error) {
                if (this.#preparation === attempt) this.#preparation = undefined;
                throw error;
            }
        } else await this.#preparation;
    }

    async #prepare(): Promise<void> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const directory = await lstat(this.directory);
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("OIDC storage must be a real directory, not a symbolic link.");
        if (process.platform !== "win32") await chmod(this.directory, 0o700);
        await this.secureStorage(this.directory);
        const key = await realpath(this.directory);
        let shared = stores.get(key);
        if (shared === undefined) {
            shared = { lock: new AsyncMutex(), context: new AsyncLocalStorage() };
            stores.set(key, shared);
        }
        this.#shared = shared;
        const release = await shared.lock.acquire();
        try {
            for (const suffix of ["", "-journal", "-wal", "-shm"]) await assertRegularFile(this.#path + suffix);
            // Set permissions before SQLite can write secrets.
            const file = await open(this.#path, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
            try {
                if (!(await file.stat()).isFile()) throw new Error("OIDC database must be a regular file.");
                if (process.platform !== "win32") await file.chmod(0o600);
            } finally { await file.close(); }
            await this.secureFile(this.#path);
            await assertRegularFile(this.#path);
            const database = connect(this.#path);
            try {
                initialize(database);
                await migrateOidcJsonState(database, this.directory);
            } finally { database.close(); }
        } finally { release(); }
    }

    async run<T>(model: string, operation: (database: DatabaseSync) => T): Promise<T> {
        await this.prepare();
        const shared = this.#shared!;
        const request = shared.context.getStore();
        if (request?.active && (request.ready !== undefined || model !== "Client")) {
            // Delay locking until OIDC parsed the body and authenticated the
            // client. Slow bodies and remote client metadata do not hold it.
            request.ready ??= this.#begin(request);
            const database = await request.ready;
            assertModelAvailable(database, model);
            return operation(database);
        }
        const release = await shared.lock.acquire();
        try {
            const database = connect(this.#path);
            try {
                database.exec("BEGIN IMMEDIATE");
                try {
                    assertModelAvailable(database, model);
                    const result = operation(database);
                    database.exec("COMMIT");
                    return result;
                } catch (error) {
                    database.exec("ROLLBACK");
                    throw error;
                }
            } finally { database.close(); }
        } finally { release(); }
    }

    async #begin(request: RequestTransaction): Promise<DatabaseSync> {
        request.release = await this.#shared!.lock.acquire();
        const database = connect(this.#path);
        try {
            database.exec("BEGIN IMMEDIATE");
            return database;
        } catch (error) {
            database.close();
            throw error;
        }
    }

    markRevoked(): void {
        const request = this.#shared?.context.getStore();
        if (request?.active) request.revoked = true;
    }

    afterCommit(notification: () => void): void {
        const request = this.#shared?.context.getStore();
        if (request?.active) request.notifications.push(notification);
        else notification();
    }

    async transaction<T>(operation: () => Promise<T>, status: () => number): Promise<T> {
        await this.prepare();
        const request: RequestTransaction = { active: true, revoked: false, notifications: [] };
        return await this.#shared!.context.run(request, async () => {
            let failed = true;
            try {
                const result = await operation();
                // Replay revocation is a successful security state change even
                // though OIDC returns invalid_grant. Other failed requests must
                // not strand a consumed token or an unreturned successor.
                failed = status() >= 500 || (status() >= 400 && !request.revoked);
                return result;
            } finally {
                request.active = false;
                try {
                    if (request.ready !== undefined) {
                        const database = await request.ready;
                        try { database.exec(failed ? "ROLLBACK" : "COMMIT"); }
                        finally { database.close(); }
                    }
                } finally { request.release?.(); }
                if (!failed) for (const notification of request.notifications) notification();
            }
        });
    }
}

function connect(path: string): DatabaseSync {
    const database = new DatabaseSync(path, { timeout: 5_000 });
    database.exec("PRAGMA synchronous = FULL");
    return database;
}

function initialize(database: DatabaseSync): void {
    database.exec("BEGIN IMMEDIATE");
    try {
        const { user_version: version } = database.prepare("PRAGMA user_version").get() as { user_version: number };
        if (version !== 0 && version !== SCHEMA_VERSION) {
            throw new Error(`Unsupported OIDC database schema version ${version}.`);
        }
        database.exec(`
            CREATE TABLE IF NOT EXISTS oidc_records (
                model TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
                expires_at INTEGER, consumed INTEGER, grant_id TEXT, uid TEXT, user_code TEXT,
                PRIMARY KEY (model, id)
            ) STRICT;
            CREATE INDEX IF NOT EXISTS oidc_grant ON oidc_records(grant_id);
            CREATE INDEX IF NOT EXISTS oidc_uid ON oidc_records(model, uid);
            CREATE INDEX IF NOT EXISTS oidc_user_code ON oidc_records(model, user_code);
            CREATE TABLE IF NOT EXISTS revoked_grants (id TEXT PRIMARY KEY NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS oidc_json_imports (model TEXT PRIMARY KEY NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS oidc_migration_errors (model TEXT PRIMARY KEY NOT NULL, reason TEXT NOT NULL) STRICT;
            PRAGMA user_version = ${SCHEMA_VERSION};
        `);
        database.exec("COMMIT");
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
}

async function assertRegularFile(path: string): Promise<void> {
    try {
        const entry = await lstat(path);
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("OIDC database or journal must not be a symbolic link or special file.");
    } catch (error) {
        if (!isMcpOAuthStorageMissing(error)) throw error;
    }
}

function assertModelAvailable(database: DatabaseSync, model: string): void {
    const error = database.prepare("SELECT reason FROM oidc_migration_errors WHERE model = ?").get(model) as { reason: string } | undefined;
    if (error !== undefined) throw new McpOAuthModelMigrationError(model, error.reason);
}

class AsyncMutex {
    #tail: Promise<void> = Promise.resolve();

    async acquire(): Promise<() => void> {
        const previous = this.#tail;
        let release!: () => void;
        this.#tail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        return release;
    }
}
