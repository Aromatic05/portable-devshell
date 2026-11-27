import type { ExtensionDatabaseConnection } from "@portable-devshell/extension/database";
import { parseSource, type BrowserSource } from "./Source.js";

export type BrowserTarget = { instance: string; profile: string };
export type RuntimeRow = { instance: string; generation: string; executable: string };

export class BrowserStore {
    constructor(private readonly db: ExtensionDatabaseConnection) {}

    async initialize(): Promise<void> {
        await this.db.exec("CREATE TABLE IF NOT EXISTS runtimes (instance TEXT PRIMARY KEY, generation TEXT NOT NULL, executable TEXT NOT NULL)");
        await this.db.exec("CREATE TABLE IF NOT EXISTS profiles (instance TEXT NOT NULL, profile TEXT NOT NULL, PRIMARY KEY(instance, profile))");
        await this.db.exec("CREATE TABLE IF NOT EXISTS profile_sources (instance TEXT NOT NULL, profile TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(instance, profile))");
        await this.db.exec("CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY, instance TEXT, profile TEXT, action TEXT, at INTEGER, ok INTEGER)");
        await this.db.exec("CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY, instance TEXT, profile TEXT, method TEXT, url TEXT, status INTEGER, at INTEGER)");
    }

    runtime(instance: string): Promise<RuntimeRow | undefined> {
        return this.db.get<RuntimeRow>("SELECT * FROM runtimes WHERE instance = ?", [instance]);
    }

    runtimes(): Promise<RuntimeRow[]> {
        return this.db.all<RuntimeRow>("SELECT * FROM runtimes ORDER BY instance");
    }

    async setRuntime(row: RuntimeRow): Promise<void> {
        await this.db.run("INSERT INTO runtimes VALUES (?, ?, ?) ON CONFLICT(instance) DO UPDATE SET generation=excluded.generation, executable=excluded.executable", [row.instance, row.generation, row.executable]);
    }

    async profiles(instance: string): Promise<string[]> {
        return (await this.db.all<{ profile: string }>("SELECT profile FROM profiles WHERE instance=? ORDER BY profile", [instance])).map(row => row.profile);
    }

    async ensureProfile(target: BrowserTarget): Promise<void> {
        await this.db.run("INSERT OR IGNORE INTO profiles VALUES (?, ?)", [target.instance, target.profile]);
    }

    async profileSource(target: BrowserTarget): Promise<BrowserSource> {
        const row = await this.db.get<{ source: string }>("SELECT source FROM profile_sources WHERE instance=? AND profile=?", [target.instance, target.profile]);
        return row ? parseSource(JSON.parse(row.source)) : { kind: "managed" };
    }

    async setProfileSource(target: BrowserTarget, source: BrowserSource): Promise<void> {
        await this.ensureProfile(target);
        await this.db.run("INSERT INTO profile_sources VALUES (?, ?, ?) ON CONFLICT(instance, profile) DO UPDATE SET source=excluded.source",
            [target.instance, target.profile, JSON.stringify(source)]);
    }

    async removeProfile(target: BrowserTarget): Promise<void> {
        await this.db.run("DELETE FROM profile_sources WHERE instance=? AND profile=?", [target.instance, target.profile]);
        await this.db.run("DELETE FROM profiles WHERE instance=? AND profile=?", [target.instance, target.profile]);
    }

    async action(target: BrowserTarget, action: string, ok: boolean): Promise<void> {
        await this.db.run("INSERT INTO actions (instance,profile,action,at,ok) VALUES (?,?,?,?,?)", [target.instance, target.profile, action, Date.now(), Number(ok)]);
    }

    async request(target: BrowserTarget, event: { method: string; url: string; status: number }): Promise<void> {
        await this.db.run("INSERT INTO requests (instance,profile,method,url,status,at) VALUES (?,?,?,?,?,?)", [target.instance, target.profile, event.method, event.url, event.status, Date.now()]);
    }

    actions(target: BrowserTarget) {
        return this.db.all("SELECT action,at,ok FROM actions WHERE instance=? AND profile=? ORDER BY id DESC LIMIT 200", [target.instance, target.profile]);
    }

    requests(target: BrowserTarget) {
        return this.db.all("SELECT method,url,status,at FROM requests WHERE instance=? AND profile=? ORDER BY id DESC LIMIT 200", [target.instance, target.profile]);
    }

    close(): Promise<void> { return this.db.close(); }
}
