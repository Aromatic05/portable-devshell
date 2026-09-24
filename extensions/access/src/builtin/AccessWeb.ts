import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ExtensionJsonValue } from "@portable-devshell/extension";

import type { AccessRuntime } from "./AccessRuntime.js";

const maxBodyBytes = 1024 * 1024;

export class AccessWebServer {
    readonly #runtime: AccessRuntime;
    #server?: Server;
    #starting?: Promise<URL>;

    constructor(runtime: AccessRuntime) {
        this.#runtime = runtime;
    }

    async start(): Promise<URL> {
        const server = this.#server;
        if (server !== undefined) return serverUrl(server);
        this.#starting ??= this.#startOnce().finally(() => {
            this.#starting = undefined;
        });
        return await this.#starting;
    }

    async close(): Promise<void> {
        const server = this.#server;
        this.#server = undefined;
        if (server === undefined) return;
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
        );
    }

    async #startOnce(): Promise<URL> {
        const server = createServer((request, response) => {
            void this.#handle(request, response).catch((error: unknown) => {
                if (!response.headersSent) writeJson(response, 500, { error: toError(error).message });
                else response.destroy();
            });
        });
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => reject(error);
            server.once("error", onError);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", onError);
                resolve();
            });
        });
        this.#server = server;
        return serverUrl(server);
    }

    async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? "/", "http://localhost");
        const method = (request.method ?? "GET").toUpperCase();
        if (method === "GET" && url.pathname === "/") {
            response.writeHead(200, {
                "cache-control": "no-store",
                "content-type": "text/html; charset=utf-8",
            });
            response.end(accessHtml);
            return;
        }
        if (method === "GET" && url.pathname === "/api/status") {
            writeJson(response, 200, this.#runtime.list() as unknown as ExtensionJsonValue);
            return;
        }
        if (method === "POST" && url.pathname === "/api/reload") {
            await this.#runtime.reload();
            writeJson(response, 200, { reloaded: true });
            return;
        }
        if (method === "PUT" && url.pathname === "/api/endpoints") {
            const value = await readJson(request);
            const record = await this.#runtime.upsert(value);
            writeJson(response, 200, record as unknown as ExtensionJsonValue);
            return;
        }
        const match = /^\/api\/endpoints\/([a-z][a-z0-9-]*)(?:\/(enable|disable))?$/u.exec(url.pathname);
        if (match !== null && method === "DELETE" && match[2] === undefined) {
            writeJson(response, 200, await this.#runtime.remove(match[1]!));
            return;
        }
        if (match !== null && method === "POST" && match[2] !== undefined) {
            const record = await this.#runtime.setEnabled(match[1]!, match[2] === "enable");
            writeJson(response, 200, record as unknown as ExtensionJsonValue);
            return;
        }
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
    }
}

async function readJson(request: IncomingMessage): Promise<ExtensionJsonValue> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBodyBytes) throw new Error("Access Web request body is too large.");
        chunks.push(buffer);
    }
    const source = Buffer.concat(chunks).toString("utf8");
    try {
        return JSON.parse(source) as ExtensionJsonValue;
    } catch (error) {
        throw new TypeError("Access Web request body must be valid JSON.", { cause: error });
    }
}

function writeJson(response: ServerResponse, status: number, value: ExtensionJsonValue): void {
    response.writeHead(status, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
    });
    response.end(`${JSON.stringify(value)}\n`);
}

function serverUrl(server: Server): URL {
    const address = server.address();
    if (address === null || typeof address === "string")
        throw new Error("Access Web server has no TCP address.");
    return new URL(`http://127.0.0.1:${address.port}/`);
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

const accessHtml = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:72rem}table{border-collapse:collapse;width:100%}th,td{padding:.6rem;border-bottom:1px solid #ddd;text-align:left}button{margin-right:.4rem}code{font-family:ui-monospace,monospace}</style></head>
<body><h1>Access</h1><p>Managed remote access endpoints.</p><button id="reload">Reload</button><table><thead><tr><th>ID</th><th>Provider</th><th>Target</th><th>State</th><th>Public URL</th><th>Error</th></tr></thead><tbody id="rows"></tbody></table>
<script>
async function refresh(){const r=await fetch('api/status');const data=await r.json();rows.innerHTML=data.map(x=>'<tr><td><code>'+e(x.id)+'</code></td><td>'+e(x.provider)+'</td><td>'+e(x.target)+'</td><td>'+e(x.state)+'</td><td>'+(x.publicUrl?'<a href="'+e(x.publicUrl)+'">'+e(x.publicUrl)+'</a>':'')+'</td><td>'+e(x.error||'')+'</td></tr>').join('')}
function e(v){return String(v).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]))}
reload.onclick=async()=>{await fetch('api/reload',{method:'POST'});await refresh()};refresh();setInterval(refresh,2000);
</script></body></html>`;
