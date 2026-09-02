import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { PiSessionLike } from "./PiSdkLoader.js";

const MAX_BODY_BYTES = 1024 * 1024;

export class PiAgentWebServer {
    readonly #eventResponses = new Set<ServerResponse>();
    readonly #session: PiSessionLike;
    #server?: Server;

    constructor(session: PiSessionLike) {
        this.#session = session;
    }

    async start(): Promise<URL> {
        if (this.#server !== undefined) throw new Error("Pi Agent WebUI is already running.");
        const server = createServer((request, response) => {
            void this.#handle(request, response).catch((error) => {
                if (response.headersSent) {
                    response.destroy(error instanceof Error ? error : undefined);
                    return;
                }
                writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
            });
        });
        this.#server = server;
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) {
            await this.stop();
            throw new Error("Pi Agent WebUI failed to bind a loopback TCP port.");
        }
        return new URL(`http://127.0.0.1:${address.port}/`);
    }

    async stop(): Promise<void> {
        const server = this.#server;
        this.#server = undefined;
        if (server === undefined) return;
        for (const response of this.#eventResponses) {
            if (!response.writableEnded) response.end();
        }
        this.#eventResponses.clear();
        const closed = new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
        server.closeIdleConnections();
        server.closeAllConnections();
        await closed;
    }

    async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? "/", "http://localhost");
        setSecurityHeaders(response);
        if (request.method === "GET" && url.pathname === "/") {
            writeText(response, 200, "text/html; charset=utf-8", HTML);
            return;
        }
        if (request.method === "GET" && url.pathname === "/app.js") {
            writeText(response, 200, "text/javascript; charset=utf-8", APP_JS);
            return;
        }
        if (request.method === "GET" && url.pathname === "/style.css") {
            writeText(response, 200, "text/css; charset=utf-8", STYLE_CSS);
            return;
        }
        if (request.method === "GET" && url.pathname === "/api/state") {
            writeJson(response, 200, this.#state());
            return;
        }
        if (request.method === "GET" && url.pathname === "/api/events") {
            this.#events(request, response);
            return;
        }
        if (request.method === "POST" && url.pathname === "/api/abort") {
            await this.#session.abort();
            writeJson(response, 200, this.#state());
            return;
        }
        if (request.method === "POST" && ["/api/prompt", "/api/steer", "/api/follow-up"].includes(url.pathname)) {
            const message = await readMessage(request);
            if (url.pathname === "/api/steer") {
                await this.#session.prompt(message, { streamingBehavior: "steer" });
            } else if (url.pathname === "/api/follow-up") {
                await this.#session.prompt(message, { streamingBehavior: "followUp" });
            } else {
                await this.#session.prompt(message);
            }
            writeJson(response, 200, this.#state());
            return;
        }
        writeJson(response, 404, { error: "Not found" });
    }

    #state(): object {
        const state = this.#session.agent?.state;
        return jsonSafe({
            isStreaming: state?.isStreaming === true,
            messages: state?.messages ?? [],
            model: summarizeModel(state?.model),
            thinkingLevel: state?.thinkingLevel ?? null
        }) as object;
    }

    #events(request: IncomingMessage, response: ServerResponse): void {
        this.#eventResponses.add(response);
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-cache, no-store");
        response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        response.setHeader("Connection", "keep-alive");
        response.flushHeaders();
        const push = (event: unknown) => {
            if (response.writableEnded) return;
            const type = typeof event === "object" && event !== null && "type" in event
                ? String((event as { type?: unknown }).type ?? "update")
                : "update";
            response.write(`data: ${JSON.stringify({ type })}\n\n`);
        };
        const unsubscribe = this.#session.subscribe?.(push) ?? (() => undefined);
        response.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
        const close = () => {
            this.#eventResponses.delete(response);
            unsubscribe();
            if (!response.writableEnded) response.end();
        };
        request.once("close", close);
        response.once("close", close);
    }
}

async function readMessage(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += data.length;
        if (size > MAX_BODY_BYTES) throw new Error("Agent WebUI request body is too large.");
        chunks.push(data);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Agent WebUI request must be a JSON object.");
    }
    const message = (value as { message?: unknown }).message;
    if (typeof message !== "string" || message.trim().length === 0) {
        throw new Error("message must be a non-empty string.");
    }
    return message;
}

function summarizeModel(value: unknown): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value ?? null;
    const model = value as Record<string, unknown>;
    return jsonSafe({
        id: model.id ?? model.name ?? null,
        name: model.name ?? null,
        provider: model.provider ?? null
    });
}

function jsonSafe(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value, (_key, current) => typeof current === "bigint" ? current.toString() : current));
}

function setSecurityHeaders(response: ServerResponse): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
    writeText(response, statusCode, "application/json; charset=utf-8", JSON.stringify(value));
}

function writeText(response: ServerResponse, statusCode: number, contentType: string, body: string): void {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", contentType);
    response.setHeader("Content-Length", Buffer.byteLength(body));
    response.end(body);
}

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi Agent</title><link rel="stylesheet" href="./style.css"></head>
<body><main><header><strong>Pi Agent</strong><span id="status">connecting</span></header>
<section id="messages"></section>
<footer><textarea id="input" rows="3" placeholder="Message the agent"></textarea><div class="actions"><button id="send">Send</button><button id="steer">Steer</button><button id="abort">Stop turn</button></div></footer>
</main><script type="module" src="./app.js"></script></body></html>`;

const STYLE_CSS = `:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#101114;color:#e7e7e9}*{box-sizing:border-box}body{margin:0}main{min-height:100vh;display:grid;grid-template-rows:auto 1fr auto;max-width:1100px;margin:auto}header,footer{padding:14px 18px;border-color:#2b2d33;border-style:solid;border-width:0 0 1px}header{display:flex;justify-content:space-between}#status{color:#9da1ac}#messages{padding:18px;overflow:auto}.msg{border-left:2px solid #3a3d45;padding:8px 12px;margin:0 0 14px;white-space:pre-wrap;overflow-wrap:anywhere}.msg.user{border-color:#6f91ff}.msg.assistant{border-color:#6bcf9a}.role{font-size:12px;color:#9da1ac;margin-bottom:5px}footer{border-width:1px 0 0}textarea{width:100%;resize:vertical;background:#17191e;color:inherit;border:1px solid #343741;border-radius:6px;padding:10px;font:inherit}.actions{display:flex;gap:8px;margin-top:8px}button{background:#252832;color:inherit;border:1px solid #3c414d;border-radius:5px;padding:7px 12px;font:inherit;cursor:pointer}button:hover{background:#303440}`;

const APP_JS = `const q=(s)=>document.querySelector(s);const messages=q('#messages'),status=q('#status'),input=q('#input');
const text=(m)=>{const c=m?.content;if(typeof c==='string')return c;if(!Array.isArray(c))return JSON.stringify(m,null,2);return c.map(x=>x?.text??x?.thinking??(x?.type==='toolCall'?('[tool] '+(x.name??'')+' '+JSON.stringify(x.arguments??{})):JSON.stringify(x))).join('\\n')};
async function refresh(){const r=await fetch('./api/state');if(!r.ok)return;const s=await r.json();status.textContent=(s.isStreaming?'running':'idle')+(s.model?.id?' · '+s.model.id:'');messages.replaceChildren(...s.messages.map(m=>{const d=document.createElement('div');d.className='msg '+(m.role??'');const h=document.createElement('div');h.className='role';h.textContent=m.role??'message';const b=document.createElement('div');b.textContent=text(m);d.append(h,b);return d}));messages.scrollTop=messages.scrollHeight}
async function send(path){const m=input.value.trim();if(!m)return;input.value='';await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:m})});await refresh()}
q('#send').onclick=()=>send('./api/prompt');q('#steer').onclick=()=>send('./api/steer');q('#abort').onclick=async()=>{await fetch('./api/abort',{method:'POST'});await refresh()};
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();q('#send').click()}});const events=new EventSource('./api/events');events.onmessage=()=>refresh();events.onerror=()=>status.textContent='reconnecting';refresh();`;
