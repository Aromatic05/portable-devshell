import { resolve } from "node:path";
import type { ExtensionContext, ExtensionJsonValue } from "@portable-devshell/extension";
import { nativeCommands, modelCommands, type CliCommandResult } from "@portable-devshell/extension/cli";
import { routes, streams } from "@portable-devshell/extension/control";
import { applications } from "@portable-devshell/extension/web";
import { BrowserRuntime, identity } from "./Browser.js";
import { BrowserStore, type BrowserTarget } from "./Store.js";

let runtime: BrowserRuntime | undefined;
const usage = [
    "devshell browser [--instance <name>] [--profile <name>] <command>",
    "  open [url] | close | profile list | profile create <name>",
    "  snapshot | click <ref> | fill <ref> <text> | goto <url> | screenshot | ...",
    "  files list | files export <file> <workspace-relative-path>",
    "  credential list",
    "User commands:",
    "  runtime install <instance> <runtime-directory>",
    "  runtime list | runtime use <instance> <generation>",
    "  profile delete | credential import <dotenv-file> | credential clear",
    "The model uses its current Instance. The native CLI requires --instance for profile operations.",
    "Open Browser from the DevShell WebUI for human control and profile management.",
].join("\n");

function isHelp(args: readonly string[]): boolean {
    return args.length === 0 || (args.length === 1 && ["help", "--help", "-h"].includes(args[0]!));
}

function result(value: ExtensionJsonValue): CliCommandResult {
    return typeof value === "string" ? { kind: "text", text: value } : { kind: "json", value };
}

function parse(args: readonly string[], instance?: string): { target: BrowserTarget; argv: string[] } {
    const argv = [...args];
    if (instance === undefined && argv[0] === "--instance") { argv.shift(); instance = argv.shift(); }
    let profile = "default";
    if (argv[0] === "--profile") { argv.shift(); profile = argv.shift() ?? ""; }
    if (!instance) throw new Error("Specify --instance <name>.");
    return { target: { instance, profile }, argv };
}

function payload(value: ExtensionJsonValue | undefined): Record<string, ExtensionJsonValue> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Browser request.");
    return value as Record<string, ExtensionJsonValue>;
}

function string(value: ExtensionJsonValue | undefined): string {
    if (typeof value !== "string") throw new Error("Expected a string.");
    return value;
}

export async function activate(context: ExtensionContext): Promise<void> {
    const store = new BrowserStore(await context.capabilities.database!.open("browser"));
    await store.initialize();
    const browser = runtime = new BrowserRuntime(context, store);
    context.register(nativeCommands, "browser", async (args, invocation) => {
        if (!invocation.localOwner) throw new Error("Browser management requires the local Control owner.");
        if (isHelp(args)) return result(usage);
        if (args[0] === "runtime" && args[1] === "install") {
            if (args.length !== 4) throw new Error("Usage: devshell browser runtime install <instance> <directory>");
            return result(await browser.install(args[2]!, resolve(invocation.workingDirectory ?? ".", args[3]!), invocation.signal));
        }
        if (args[0] === "runtime" && args[1] === "list") return result(await store.runtimes());
        if (args[0] === "runtime" && args[1] === "use" && args.length === 4)
            return result(await browser.useRuntime(args[2]!, args[3]!, invocation.signal));
        const { target, argv } = parse(args);
        if (argv[0] === "profile" && argv[1] === "delete" && argv.length === 2) {
            await browser.removeProfile(target);
            return result("Profile deleted.");
        }
        if (argv[0] === "credential") {
            identity(target);
            if (argv[1] === "list" && argv.length === 2) return result(await browser.credentials.names(target));
            if (argv[1] === "import" && argv.length === 3) {
                return result(await browser.credentials.import(target, resolve(invocation.workingDirectory ?? ".", argv[2]!)));
            }
            if (argv[1] === "clear" && argv.length === 2) {
                await browser.credentials.clear(target);
                return result("Credentials cleared.");
            }
            throw new Error("Usage: credential list | import <dotenv file> | clear");
        }
        return result(await browser.command(target, argv));
    });
    context.register(modelCommands, "browser", async (args, invocation) => {
        if (isHelp(args)) return result(usage);
        const { target, argv } = parse(args, invocation.instance);
        if (argv[0] === "credential" && argv[1] === "list" && argv.length === 2) return result(await browser.credentials.names(target));
        if (argv[0] === "credential") throw new Error("Credential management requires the local Control owner.");
        if (argv[0] === "profile" && argv[1] === "delete") throw new Error("Profile deletion requires the user.");
        return result(await browser.command(target, argv, invocation.workspace));
    });
    context.register(applications, "browser", { source: { kind: "files", directory: "web" } });
    context.register(routes, "browser-request", async (request, invocation) => {
        if (invocation.peer !== "web") throw new Error("Browser Viewer requests require WebUI.");
        const body = payload(request.payload);
        if (body.op === "runtimes") {
            const runtimes = await store.runtimes();
            const instances = await context.capabilities.instanceObserve!.list();
            return instances.filter(instance => instance.enabled).map(instance => ({
                instance: instance.name, ready: instance.snapshot?.ready ?? false,
                installed: runtimes.some(runtime => runtime.instance === instance.name),
            }));
        }
        if (body.op === "bundles") return (await context.capabilities.assets!.listBundles()).map(bundle => bundle.generation);
        const instance = string(body.instance);
        if (body.op === "profiles") return store.profiles(instance);
        if (body.op === "runtime-use") return browser.useRuntime(instance, string(body.args), invocation.signal);
        const target = { instance, profile: string(body.profile) };
        identity(target);
        if (body.op === "credentials") return browser.credentials.names(target);
        if (body.op === "credentials-import") return browser.credentials.replace(target, string(body.args));
        if (body.op === "credentials-clear") { await browser.credentials.clear(target); return null; }
        if (body.op === "profile-delete") { await browser.removeProfile(target); return null; }
        if (body.op === "files") return (await browser.files(target)).entries;
        if (body.op === "actions") return store.actions(target);
        if (body.op === "requests") return store.requests(target);
        if (body.op === "file-share") return browser.shareFile(target, string(body.args));
        if (body.op === "command") {
            if (!Array.isArray(body.args)) throw new Error("Invalid Browser command.");
            return browser.command(target, body.args.map(string));
        }
        if (body.op === "state") return (await browser.existing(target))?.request("state") ?? null;
        if (body.op === "input") return browser.input(target, body.args);
        throw new Error("Unknown Browser Viewer operation.");
    });
    context.register(streams, "browser-frames", async (stream, request, invocation) => {
        if (invocation.peer !== "web") throw new Error("Browser Viewer streams require WebUI.");
        const body = payload(request.payload);
        const session = await browser.existing({ instance: string(body.instance), profile: string(body.profile) });
        if (!session) throw new Error("Open the browser first.");
        for await (const frame of session.frames(invocation.signal)) await stream.write(frame);
    });
}

export async function deactivate(): Promise<void> {
    const browser = runtime;
    runtime = undefined;
    if (browser !== undefined) { await browser.retire(); await browser.store.close(); }
}

export async function instanceGenerationRetired(event: { instance: string }): Promise<void> {
    await runtime?.retire(event.instance);
}
