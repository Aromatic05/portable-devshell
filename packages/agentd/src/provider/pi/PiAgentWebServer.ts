import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type {
    PiModelRuntimeLike,
    PiSessionLike,
    PiSettingsManagerLike
} from "./PiSdkLoader.js";

const MAX_BODY_BYTES = 1024 * 1024;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export interface PiAgentWebServerOptions {
    modelRuntime: PiModelRuntimeLike;
    session: PiSessionLike;
    settingsManager: PiSettingsManagerLike;
}

export class PiAgentWebServer {
    readonly #eventResponses = new Set<ServerResponse>();
    readonly #modelRuntime: PiModelRuntimeLike;
    readonly #session: PiSessionLike;
    readonly #settingsManager: PiSettingsManagerLike;
    #server?: Server;

    constructor(options: PiAgentWebServerOptions) {
        this.#modelRuntime = options.modelRuntime;
        this.#session = options.session;
        this.#settingsManager = options.settingsManager;
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
        if (request.method === "GET" && url.pathname === "/api/config") {
            writeJson(response, 200, await this.#config());
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
        if (request.method === "POST" && url.pathname === "/api/auth/api-key") {
            await this.#setApiKey(await readJsonObject(request));
            writeJson(response, 200, await this.#config());
            return;
        }
        if (request.method === "POST" && url.pathname === "/api/auth/logout") {
            await this.#logout(await readJsonObject(request));
            writeJson(response, 200, await this.#config());
            return;
        }
        if (request.method === "POST" && url.pathname === "/api/model") {
            await this.#setModel(await readJsonObject(request));
            writeJson(response, 200, this.#state());
            return;
        }
        if (request.method === "POST" && ["/api/prompt", "/api/steer", "/api/follow-up"].includes(url.pathname)) {
            const message = readRequiredString(await readJsonObject(request), "message");
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

    async #config(): Promise<object> {
        const providers = await Promise.all(this.#modelRuntime.getProviders().map(async (provider) => {
            const auth = await this.#modelRuntime.checkAuth(provider.id).catch(() => undefined);
            return {
                auth: auth === undefined
                    ? null
                    : { source: auth.source ?? null, type: auth.type },
                id: provider.id,
                name: provider.name ?? provider.id
            };
        }));
        const models = this.#modelRuntime.getModels().map((model) => ({
            id: model.id,
            name: model.name ?? model.id,
            provider: model.provider
        }));
        return {
            defaults: {
                model: this.#settingsManager.getDefaultModel() ?? null,
                provider: this.#settingsManager.getDefaultProvider() ?? null,
                thinkingLevel: this.#settingsManager.getDefaultThinkingLevel() ?? null
            },
            models,
            providers
        };
    }

    async #setApiKey(input: Record<string, unknown>): Promise<void> {
        const provider = readRequiredString(input, "provider");
        const key = readRequiredString(input, "key", false);
        let promptCount = 0;
        await this.#modelRuntime.login(provider, "api_key", {
            notify: () => undefined,
            prompt: async (prompt) => {
                promptCount += 1;
                if (promptCount > 1 || (prompt.type !== "secret" && prompt.type !== "text")) {
                    throw new Error(
                        `Provider ${provider} requires a multi-step authentication flow; use a provider UI that supports interactive login.`
                    );
                }
                return key;
            }
        });
    }

    async #logout(input: Record<string, unknown>): Promise<void> {
        await this.#modelRuntime.logout(readRequiredString(input, "provider"));
    }

    async #setModel(input: Record<string, unknown>): Promise<void> {
        const provider = readRequiredString(input, "provider");
        const modelId = readRequiredString(input, "modelId");
        const model = this.#modelRuntime.getModel(provider, modelId);
        if (model === undefined) throw new Error(`Unknown Pi model: ${provider}/${modelId}`);
        if (this.#session.setModel === undefined) throw new Error("Pi session does not support model changes.");
        await this.#session.setModel(model);
        this.#settingsManager.setDefaultModelAndProvider(provider, modelId);
        const thinkingLevel = readOptionalString(input, "thinkingLevel");
        if (thinkingLevel !== undefined) {
            if (!THINKING_LEVELS.has(thinkingLevel)) {
                throw new Error(`Unsupported thinkingLevel: ${thinkingLevel}`);
            }
            if (this.#session.setThinkingLevel === undefined) {
                throw new Error("Pi session does not support thinking-level changes.");
            }
            this.#session.setThinkingLevel(thinkingLevel);
            this.#settingsManager.setDefaultThinkingLevel(thinkingLevel);
        }
        await this.#settingsManager.flush();
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

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
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
    return value as Record<string, unknown>;
}

function readRequiredString(input: Record<string, unknown>, field: string, trim = true): string {
    const value = input[field];
    if (typeof value !== "string" || (trim ? value.trim().length === 0 : value.length === 0)) {
        throw new Error(`${field} must be a non-empty string.`);
    }
    return trim ? value.trim() : value;
}

function readOptionalString(input: Record<string, unknown>, field: string): string | undefined {
    const value = input[field];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") throw new Error(`${field} must be a string.`);
    return value.trim();
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
<details id="settings"><summary>Runtime settings</summary><div class="settings-grid">
<label>Provider<select id="provider"></select></label><label>API key<input id="api-key" type="password" autocomplete="off"></label><div class="actions"><button id="save-key">Save key</button><button id="logout">Logout</button></div>
<label>Model<select id="model"></select></label><label>Thinking<select id="thinking"><option>off</option><option>minimal</option><option>low</option><option selected>medium</option><option>high</option><option>xhigh</option></select></label><div class="actions"><button id="apply-model">Apply model</button></div>
<div id="config-status" class="config-status"></div></div></details>
<section id="messages"></section>
<footer><textarea id="input" rows="3" placeholder="Message the agent"></textarea><div class="actions"><button id="send">Send</button><button id="steer">Steer</button><button id="abort">Stop turn</button></div></footer>
</main><script type="module" src="./app.js"></script></body></html>`;

const STYLE_CSS = `:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#101114;color:#e7e7e9}*{box-sizing:border-box}body{margin:0}main{min-height:100vh;display:grid;grid-template-rows:auto auto 1fr auto;max-width:1100px;margin:auto}header,footer{padding:14px 18px;border-color:#2b2d33;border-style:solid;border-width:0 0 1px}header{display:flex;justify-content:space-between}#status,.config-status{color:#9da1ac}#settings{padding:10px 18px;border-bottom:1px solid #2b2d33}.settings-grid{display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end;padding:12px 0 4px}.settings-grid label{display:grid;gap:5px;font-size:12px;color:#9da1ac}select,input,textarea{background:#17191e;color:inherit;border:1px solid #343741;border-radius:6px;padding:9px;font:inherit}#messages{padding:18px;overflow:auto}.msg{border-left:2px solid #3a3d45;padding:8px 12px;margin:0 0 14px;white-space:pre-wrap;overflow-wrap:anywhere}.msg.user{border-color:#6f91ff}.msg.assistant{border-color:#6bcf9a}.role{font-size:12px;color:#9da1ac;margin-bottom:5px}footer{border-width:1px 0 0}textarea{width:100%;resize:vertical}.actions{display:flex;gap:8px}button{background:#252832;color:inherit;border:1px solid #3c414d;border-radius:5px;padding:7px 12px;font:inherit;cursor:pointer}button:hover{background:#303440}@media(max-width:760px){.settings-grid{grid-template-columns:1fr}.actions{align-items:center}}`;

const APP_JS = `const q=(s)=>document.querySelector(s);const messages=q('#messages'),status=q('#status'),input=q('#input'),provider=q('#provider'),model=q('#model'),thinking=q('#thinking'),configStatus=q('#config-status');let config;
const text=(m)=>{const c=m?.content;if(typeof c==='string')return c;if(!Array.isArray(c))return JSON.stringify(m,null,2);return c.map(x=>x?.text??x?.thinking??(x?.type==='toolCall'?('[tool] '+(x.name??'')+' '+JSON.stringify(x.arguments??{})):JSON.stringify(x))).join('\\n')};
async function json(path,options){const r=await fetch(path,options);const body=await r.json().catch(()=>({}));if(!r.ok)throw new Error(body.error??('HTTP '+r.status));return body}
async function refresh(){const s=await json('./api/state');status.textContent=(s.isStreaming?'running':'idle')+(s.model?.id?' · '+s.model.provider+'/'+s.model.id:'');messages.replaceChildren(...s.messages.map(m=>{const d=document.createElement('div');d.className='msg '+(m.role??'');const h=document.createElement('div');h.className='role';h.textContent=m.role??'message';const b=document.createElement('div');b.textContent=text(m);d.append(h,b);return d}));messages.scrollTop=messages.scrollHeight}
function populateModels(){const selected=provider.value;const current=model.value;model.replaceChildren(...config.models.filter(m=>m.provider===selected).map(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=m.name===m.id?m.id:(m.name+' · '+m.id);return o}));if([...model.options].some(o=>o.value===current))model.value=current;else if(config.defaults.provider===selected&&config.defaults.model)model.value=config.defaults.model}
async function refreshConfig(){config=await json('./api/config');const current=provider.value;provider.replaceChildren(...config.providers.map(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name+(p.auth?' · configured':'');return o}));if([...provider.options].some(o=>o.value===current))provider.value=current;else if(config.defaults.provider)provider.value=config.defaults.provider;populateModels();if(config.defaults.thinkingLevel)thinking.value=config.defaults.thinkingLevel;configStatus.textContent=''}
provider.onchange=populateModels;
q('#save-key').onclick=async()=>{try{const key=q('#api-key').value;if(!key)throw new Error('API key is required');configStatus.textContent='saving…';await json('./api/auth/api-key',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:provider.value,key})});q('#api-key').value='';await refreshConfig()}catch(e){configStatus.textContent=e.message}};
q('#logout').onclick=async()=>{try{await json('./api/auth/logout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:provider.value})});await refreshConfig()}catch(e){configStatus.textContent=e.message}};
q('#apply-model').onclick=async()=>{try{if(!model.value)throw new Error('Select a model');configStatus.textContent='applying…';await json('./api/model',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:provider.value,modelId:model.value,thinkingLevel:thinking.value})});await Promise.all([refreshConfig(),refresh()])}catch(e){configStatus.textContent=e.message}};
async function send(path){const m=input.value.trim();if(!m)return;input.value='';try{await json(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:m})});await refresh()}catch(e){status.textContent=e.message}}
q('#send').onclick=()=>send('./api/prompt');q('#steer').onclick=()=>send('./api/steer');q('#abort').onclick=async()=>{try{await json('./api/abort',{method:'POST'});await refresh()}catch(e){status.textContent=e.message}};
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();q('#send').click()}});const events=new EventSource('./api/events');events.onmessage=()=>refresh();events.onerror=()=>status.textContent='reconnecting';Promise.all([refreshConfig(),refresh()]).catch(e=>status.textContent=e.message);`;
