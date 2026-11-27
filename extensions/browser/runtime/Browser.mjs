import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { listFiles } from "./Files.mjs";
import { attachBrowser } from "./Attached.mjs";

const execute = promisify(execFile);

/** Shares a managed or user-owned Chromium browser with the official CLI. */
export class Browser {
    #browser;
    #context;
    #page;
    #casting = false;
    #castPage;
    #attached = false;
    #view = Promise.resolve();
    #name = "devshell-browser-" + randomUUID();
    #closing = false;

    constructor(root, profile, output) {
        this.root = root;
        this.profile = profile;
        this.output = output;
        this.cliDir = join(profile, "cli");
    }

    async probe() {
        process.env.PLAYWRIGHT_BROWSERS_PATH = join(this.root, "browsers");
        const { chromium } = await import("./node_modules/playwright/index.mjs");
        const browser = await chromium.launch({ headless: true });
        try { return { version: browser.version() }; }
        finally { await browser.close(); }
    }

    files() { return listFiles(this.cliDir); }

    async removeProfile() {
        if (this.#context) throw new Error("Close the browser before deleting its profile.");
        await rm(this.profile, { recursive: true, force: true });
        return null;
    }

    async open({ credentials = "", source = { kind: "managed" } } = {}) {
        await mkdir(this.cliDir, { recursive: true });
        this.#attached = source.kind === "extension";
        process.env.PLAYWRIGHT_BROWSERS_PATH = join(this.root, "browsers");
        // Keep CLI metadata in the DevShell profile where possible. On Windows,
        // Playwright also uses LOCALAPPDATA to find the user's actual browser.
        process.env.XDG_CACHE_HOME = join(this.profile, "cache");
        if (!this.#attached || process.platform !== "win32")
            process.env.LOCALAPPDATA = join(this.profile, "cache");
        const { chromium } = await import("./node_modules/playwright/index.mjs");
        const secretFile = join(this.cliDir, ".credentials-" + randomUUID());
        try {
            const env = { ...process.env };
            delete env.PLAYWRIGHT_MCP_SECRETS_FILE;
            if (credentials) {
                await writeFile(secretFile, credentials, { mode: 0o600, flag: "wx" });
                env.PLAYWRIGHT_MCP_SECRETS_FILE = secretFile;
            }
            if (this.#attached) {
                this.#browser = await attachBrowser(chromium, source, this.#name, this.#executeCli.bind(this), env);
                this.#context = this.#browser.contexts()[0];
                if (!this.#context) throw new Error("The attached browser has no accessible context.");
            } else {
                this.#context = await chromium.launchPersistentContext(join(this.profile, "chromium"), { headless: true, viewport: { width: 1280, height: 800 } });
                this.#browser = this.#context.browser();
                const bound = await this.#browser.bind(this.#name);
                await this.#cli(["attach", "--endpoint=" + bound.endpoint], env);
            }
        } finally { await rm(secretFile, { force: true }); }
        this.#browser.on("disconnected", () => {
            if (!this.#closing) this.output.disconnected();
        });
        this.#page = this.#context.pages()[0] ?? await this.#context.newPage();
        const observePage = page => {
            if (!this.#page) void this.#select(page).catch(error => console.error("Browser tab: " + error.message));
            page.on("close", () => {
                if (!this.#closing && this.#page === page)
                    void this.#select(this.#context.pages().find(candidate => candidate !== page && !candidate.isClosed()))
                        .catch(error => console.error("Browser tab: " + error.message));
            });
            page.on("download", download => {
                void (async () => {
                    const dir = join(this.cliDir, "downloads");
                    await mkdir(dir, { recursive: true });
                    const name = download.suggestedFilename().split(/[\\/]/).pop() || "download";
                    await download.saveAs(join(dir, randomUUID() + "-" + name));
                })().catch(error => console.error("Browser download: " + error.message));
            });
        };
        this.#context.pages().forEach(observePage);
        this.#context.on("page", observePage);
        this.#context.on("response", response => {
            this.output.message({ event: "request", method: response.request().method(), url: response.url(), status: response.status() });
        });
        return this.state();
    }

    async #executeCli(argv, env = process.env, timeout = 120000) {
        try {
            return await execute(process.execPath, [
                join(this.root, "node_modules", "@playwright", "cli", "playwright-cli.js"),
                "-s=" + this.#name, ...argv,
            ], { cwd: this.cliDir, env, timeout, maxBuffer: 4 * 1024 * 1024 });
        } catch (error) {
            throw new Error("Playwright CLI failed: " + (error.stderr || error.stdout || String(error.code ?? "unknown error")));
        }
    }

    async #cli(argv, env = process.env, timeout = 120000) {
        const { stdout, stderr } = await this.#executeCli(argv, env, timeout);
        return stdout + stderr;
    }

    async cli(argv) {
        if (["attach", "detach", "open", "close", "close-all", "kill-all", "show", "install", "delete-data"].includes(argv[0]) || argv.some(arg => /^(?:-s(?:=|$)|--session(?:=|$)|--all(?:=|$))/.test(arg)))
            throw new Error("Browser sessions and runtimes are owned by DevShell.");
        const before = this.#context.pages().length;
        const result = await this.#cli(argv);
        if (before === this.#context.pages().length && !argv[0]?.startsWith("tab-") && argv[0] !== "run-code") return result;
        // The Playwright CLI owns tab selection; use the corresponding tab for the Viewer.
        const selected = await this.#cli(["tab-list"]);
        const match = selected.match(/^\s*-\s*(\d+):\s*\(current\)/m);
        const page = this.#context.pages()[Number(match?.[1] ?? 0)];
        if (page !== this.#page) await this.#select(page);
        return result;
    }

    async state() {
        const pages = this.#context.pages();
        return { tabs: await Promise.all(pages.map(async (page, index) => ({ index, url: page.url(), title: await page.title() }))), active: pages.indexOf(this.#page) };
    }

    #changeView(operation) {
        const next = this.#view.then(operation);
        this.#view = next.catch(() => undefined);
        return next;
    }

    #select(page) {
        return this.#changeView(async () => {
            this.#page = page && !page.isClosed() ? page : undefined;
            await this.#setCast(this.#casting);
        });
    }

    cast(enabled) {
        return this.#changeView(() => this.#setCast(enabled));
    }

    async #setCast(enabled) {
        this.#casting = enabled;
        const page = enabled && this.#page && !this.#page.isClosed() ? this.#page : undefined;
        if (page === this.#castPage) return null;
        const previous = this.#castPage;
        this.#castPage = undefined;
        if (previous && !previous.isClosed()) await previous.screencast.stop();
        if (page) {
            await page.screencast.start({
                quality: 75, size: { width: 1280, height: 800 },
                onFrame: frame => this.output.frame(frame),
            });
            this.#castPage = page;
        }
        return null;
    }

    async input(args) {
        const page = this.#page;
        if (!["tab", "newTab", "closeTab"].includes(args.type) && (!page || page.isClosed()))
            throw new Error("Select a browser tab first.");
        switch (args.type) {
            case "move": await page.mouse.move(args.x, args.y); break;
            case "down": await page.mouse.move(args.x, args.y); await page.mouse.down({ button: args.button }); break;
            case "up": await page.mouse.move(args.x, args.y); await page.mouse.up({ button: args.button }); break;
            case "wheel": await page.mouse.wheel(args.dx, args.dy); break;
            case "keyDown": await page.keyboard.down(args.key); break;
            case "keyUp": await page.keyboard.up(args.key); break;
            case "text": await page.keyboard.insertText(args.text); break;
            case "tab": await this.#cli(["tab-select", String(args.index)]); await this.#select(this.#context.pages()[args.index]); break;
            case "newTab": await this.cli(["tab-new"]); break;
            case "closeTab": await this.cli(["tab-close", String(args.index)]); break;
            case "resize":
                if (this.#attached) throw new Error("Resize the attached browser in its own window.");
                await page.setViewportSize({ width: args.width, height: args.height }); break;
            default: throw new Error("Unknown browser input.");
        }
        return ["tab", "newTab", "closeTab"].includes(args.type) ? this.state() : null;
    }

    async close() {
        if (this.#closing) return;
        this.#closing = true;
        try {
            await this.cast(false).catch(() => {});
            // Closing a connected Playwright client only disconnects that client.
            // The CLI owns the extension relay, never the user's browser context.
            if (this.#attached) await this.#browser?.close();
            else await this.#context?.close();
        } finally {
            try {
                if (this.#attached) await this.#cli(["detach"], process.env, 3000);
                else if (this.#context) await this.#cli(["detach"], process.env, 3000).catch(() => {});
            } finally {
                this.#context = undefined;
                this.#browser = undefined;
            }
        }
    }
}
