import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { BrowserTarget } from "./Store.js";

/** User-imported Playwright dotenv files, separate from the browser audit database. */
export class BrowserCredentials {
    constructor(private readonly directory: string) {}

    private path(target: BrowserTarget): string {
        return join(this.directory, Buffer.from(JSON.stringify([target.instance, target.profile])).toString("base64url") + ".env");
    }

    async read(target: BrowserTarget): Promise<string> {
        try { return await readFile(this.path(target), "utf8"); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
            throw error;
        }
    }

    async names(target: BrowserTarget): Promise<string[]> {
        return Object.keys(parseEnv(await this.read(target))).sort();
    }

    async import(target: BrowserTarget, source: string): Promise<string[]> {
        return this.replace(target, await readFile(source, "utf8"));
    }

    async replace(target: BrowserTarget, content: string): Promise<string[]> {
        if (Buffer.byteLength(content) > 65536) throw new Error("Credential file exceeds 64 KiB.");
        const names = Object.keys(parseEnv(content)).sort();
        if (names.length === 0) throw new Error("Credential file does not contain any names.");
        if (names.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error("Invalid credential name.");
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const destination = this.path(target);
        const temporary = destination + "." + randomUUID();
        try {
            await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
            await rename(temporary, destination);
        } finally { await rm(temporary, { force: true }); }
        return names;
    }

    async clear(target: BrowserTarget): Promise<void> {
        await rm(this.path(target), { force: true });
    }
}
