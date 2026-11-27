import { join, posix } from "node:path";
import { readFile } from "node:fs/promises";
import type { ExtensionContext, ExtensionJsonValue } from "@portable-devshell/extension";
import { BrowserCredentials } from "./Credentials.js";
import { BrowserSession } from "./Session.js";
import { BrowserStore, type BrowserTarget } from "./Store.js";
import type { BrowserSource } from "./Source.js";

export function identity(target: BrowserTarget): string {
    if (!/^[A-Za-z0-9_-]+$/.test(target.profile)) throw new Error("Invalid browser profile name.");
    return JSON.stringify([target.instance, target.profile]);
}

export class BrowserRuntime {
    readonly #sessions = new Map<string, Promise<BrowserSession>>();
    readonly #transitions = new Map<string, Promise<unknown>>();

    readonly credentials: BrowserCredentials;

    constructor(private readonly context: ExtensionContext, readonly store: BrowserStore) {
        this.credentials = new BrowserCredentials(join(context.paths.dataDirectory, "credentials"));
    }

    async install(instance: string, directory: string, signal: AbortSignal): Promise<ExtensionJsonValue> {
        const assets = this.context.capabilities.assets!;
        const bundle = await assets.installDirectory(directory);
        return this.useRuntime(instance, bundle.generation, signal);
    }

    async useRuntime(instance: string, generation: string, signal: AbortSignal): Promise<ExtensionJsonValue> {
        const assets = this.context.capabilities.assets!;
        const bundle = await assets.resolveBundle(generation);
        if (!bundle) throw new Error("Browser runtime bundle is not installed.");
        const manifest = JSON.parse(await readFile(join(bundle.directory, "runtime.json"), "utf8")) as { executable: string };
        if (!["bin/node", "bin/node.exe"].includes(manifest.executable)) throw new Error("Invalid Browser runtime executable.");
        let transferredBytes = 0;
        try {
            // The Worker projection commits independently of the final launch check.
            // Reuse a committed bundle after an interrupted install.
            await this.#probe(instance, generation, manifest.executable, signal);
        } catch {
            signal.throwIfAborted();
            const active = [...this.#sessions.entries()].filter(([key]) => (JSON.parse(key) as string[])[0] === instance);
            for (const [, pending] of active) {
                const session = await pending.catch(() => undefined);
                if (session && !session.closed) throw new Error("Close the instance's browser sessions before repairing its runtime.");
            }
            const projected = await assets.projectBundle({
                generation: bundle.generation, target: { instance, collection: "runtime", key: bundle.generation },
                overwrite: true, signal,
            });
            transferredBytes = projected.transferredBytes;
            await this.#probe(instance, generation, manifest.executable, signal);
        }
        await this.store.setRuntime({ instance, generation: bundle.generation, executable: manifest.executable });
        return { generation: bundle.generation, transferredBytes };
    }

    async #probe(instance: string, generation: string, executable: string, signal: AbortSignal): Promise<void> {
        const process = await this.context.capabilities.workerProcesses!.start({
            instance, executable: { collection: "runtime", key: generation, path: executable },
            args: [{ collection: "runtime", key: generation, path: "helper.mjs" }, "--probe"],
        }, signal);
        const probe = new BrowserSession(process, async () => {}, () => {});
        try { await probe.request("probe"); }
        finally { await probe.close(); }
    }

    async #transition<T>(target: BrowserTarget, operation: () => Promise<T>): Promise<T> {
        const key = identity(target);
        const previous = this.#transitions.get(key) ?? Promise.resolve();
        const pending = previous.catch(() => undefined).then(operation);
        this.#transitions.set(key, pending);
        try { return await pending; }
        finally { if (this.#transitions.get(key) === pending) this.#transitions.delete(key); }
    }

    session(target: BrowserTarget): Promise<BrowserSession> {
        return this.#transition(target, () => this.#session(target));
    }

    async #session(target: BrowserTarget): Promise<BrowserSession> {
        const key = identity(target);
        let pending = this.#sessions.get(key);
        if (pending !== undefined) {
            const existing = await pending;
            if (!existing.closed) return existing;
            if (this.#sessions.get(key) === pending) this.#sessions.delete(key);
            return this.#session(target);
        }
        pending = this.#start(target);
        this.#sessions.set(key, pending);
        try { return await pending; }
        catch (error) {
            if (this.#sessions.get(key) === pending) this.#sessions.delete(key);
            throw error;
        }
    }

    async existing(target: BrowserTarget): Promise<BrowserSession | undefined> {
        const pending = this.#sessions.get(identity(target));
        if (!pending) return undefined;
        const session = await pending;
        return session.closed ? undefined : session;
    }

    async #helper(target: BrowserTarget): Promise<BrowserSession> {
        const runtime = await this.store.runtime(target.instance);
        if (runtime === undefined) throw new Error("Install a Browser runtime for this instance first.");
        const root = { collection: "runtime", key: runtime.generation };
        const process = await this.context.capabilities.workerProcesses!.start({
            instance: target.instance,
            executable: { ...root, path: runtime.executable },
            args: [{ ...root, path: "helper.mjs" }, { collection: "profiles", key: target.profile }],
        });
        return new BrowserSession(process,
            event => this.store.request(target, event),
            error => this.context.logger.error("Browser process failed: " + String(error)));
    }

    async #start(target: BrowserTarget): Promise<BrowserSession> {
        await this.store.ensureProfile(target);
        const source = await this.store.profileSource(target);
        const session = await this.#helper(target);
        try {
            if (source.kind === "extension") {
                const capabilities = await session.request("capabilities").catch(() => null);
                if (!Array.isArray(capabilities) || !capabilities.includes("extension"))
                    throw new Error("Install a Browser runtime that supports attached browsers.");
            }
            await session.request("open", { source, credentials: await this.credentials.read(target) });
            return session;
        }
        catch (error) { await session.close().catch(() => undefined); throw error; }
    }

    async configureSource(target: BrowserTarget, source: BrowserSource): Promise<BrowserSource> {
        return this.#transition(target, async () => {
            if (await this.existing(target)) throw new Error("Close or disconnect the browser session before changing its source.");
            await this.store.setProfileSource(target, source);
            return source;
        });
    }

    async command(target: BrowserTarget, argv: readonly string[], workspace?: string): Promise<ExtensionJsonValue> {
        identity(target);
        if (argv[0] === "files") {
            if (argv.length === 1 || argv[1] === "list") return (await this.files(target)).entries;
            if (argv[1] === "export" && argv.length === 4 && workspace) return this.exportFile(target, argv[2]!, workspace, argv[3]!);
            throw new Error("Usage: files list | files export <file> <workspace destination> (model command)");
        }
        const command = argv[0];
        if (command === undefined || command === "help") return "Use open [url], close, snapshot, click, fill, goto, screenshot or other Playwright CLI commands.";
        if (command === "close") {
            await this.close(target);
            await this.store.action(target, command, true);
            return (await this.store.profileSource(target)).kind === "extension" ? "Browser disconnected." : "Browser closed.";
        }
        if (command === "profile" && argv[1] === "list") return this.store.profiles(target.instance);
        if (command === "profile" && argv[1] === "source") {
            if (argv.length !== 2) throw new Error("Changing a browser profile source requires the user.");
            return this.store.profileSource(target);
        }
        if (command === "profile" && argv[1] === "create" && argv[2] !== undefined) {
            const created = { ...target, profile: argv[2] };
            identity(created); await this.store.ensureProfile(created); return created.profile;
        }
        try {
            const session = command === "open" ? await this.session(target) : await this.existing(target);
            if (session === undefined) throw new Error("Open the browser first.");
            const result = command === "open"
                ? (argv[1] === undefined ? await session.request("state") : await session.request("cli", ["goto", argv[1]]))
                : await session.request("cli", [...argv]);
            await this.store.action(target, command, true);
            return result;
        } catch (error) {
            await this.store.action(target, command, false);
            throw error;
        }
    }

    async input(target: BrowserTarget, args: ExtensionJsonValue | undefined): Promise<ExtensionJsonValue> {
        const session = await this.existing(target);
        if (!session) throw new Error("Open the browser first.");
        if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.type !== "string")
            throw new Error("Invalid browser input.");
        const action = "viewer:" + args.type;
        const log = args.type !== "move";
        try {
            const result = await session.request("input", args);
            if (log) await this.store.action(target, action, true);
            return result;
        } catch (error) {
            if (log) await this.store.action(target, action, false);
            throw error;
        }
    }

    close(target: BrowserTarget): Promise<void> {
        return this.#transition(target, () => this.#close(target));
    }

    async #close(target: BrowserTarget): Promise<void> {
        const key = identity(target);
        const pending = this.#sessions.get(key);
        if (pending === undefined) return;
        try { await (await pending).close(); }
        finally { if (this.#sessions.get(key) === pending) this.#sessions.delete(key); }
    }

    async removeProfile(target: BrowserTarget): Promise<void> {
        await this.#transition(target, async () => {
            await this.#close(target);
            const helper = await this.#helper(target);
            try { await helper.request("profile-delete"); }
            finally { await helper.close(); }
            await this.credentials.clear(target);
            await this.store.removeProfile(target);
        });
    }

    async files(target: BrowserTarget): Promise<{ directory: string; entries: { path: string; bytes: number }[] }> {
        return this.#transition(target, async () => {
            const current = await this.existing(target);
            const helper = current ?? await this.#helper(target);
            try { return await helper.request("files") as { directory: string; entries: { path: string; bytes: number }[] }; }
            finally { if (!current) await helper.close(); }
        });
    }

    async #source(target: BrowserTarget, name: string) {
        const files = await this.files(target);
        if (!files.entries.some(file => file.path === name)) throw new Error("Browser output file not found.");
        return { instance: target.instance, workspace: files.directory, path: './' + name };
    }

    async exportFile(target: BrowserTarget, name: string, workspace: string, destination: string): Promise<ExtensionJsonValue> {
        if (!destination || destination.startsWith("/") || destination.includes("\\") || destination.split("/").some(part => part === "..") || posix.isAbsolute(destination))
            throw new Error("Destination must be a relative path in the model workspace.");
        const artifacts = this.context.capabilities.artifacts!;
        const transfer = await artifacts.startTransfer({
            authorityInstance: target.instance, source: await this.#source(target, name),
            target: { instance: target.instance, workspace, path: './' + destination.replace(/^\.\//, '') },
        });
        const completed = await artifacts.waitForTransfer(transfer.transfer.transferId);
        if (completed.status !== "completed") throw new Error(completed.failure?.message ?? "Browser file export failed.");
        return { path: destination, bytes: completed.transferredBytes };
    }

    async shareFile(target: BrowserTarget, name: string): Promise<ExtensionJsonValue> {
        const share = await this.context.capabilities.artifacts!.createShare({
            authorityInstance: target.instance, source: await this.#source(target, name), expiresInSeconds: 300,
        });
        return { url: share.url, name: share.downloadName };
    }

    async retire(instance?: string): Promise<void> {
        const sessions = [...this.#sessions.entries()].filter(([key]) => instance === undefined || (JSON.parse(key) as string[])[0] === instance);
        await Promise.allSettled(sessions.map(async ([key, pending]) => {
            try { await (await pending).close(); }
            finally { if (this.#sessions.get(key) === pending) this.#sessions.delete(key); }
        }));
    }
}
