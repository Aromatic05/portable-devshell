import type { IncomingMessage, ServerResponse } from "node:http";
import type { ContextTransport } from "@portable-devshell/shared";
import type { HttpHost } from "../../host/Http.js";
import type { McpAppLeaseStore } from "./Lease.js";
import type { McpAppPresenceStore } from "./Presence.js";
import type { createMcpAppViewModel } from "../ViewModel.js";

/** A read-only bearer-capability endpoint. Neither ctxId nor Instance name grants access. */
export function installMcpAppLive(options: {
    contexts: Pick<ContextTransport, "validateForInstance">;
    host: HttpHost;
    instance: string;
    leases: McpAppLeaseStore;
    presence: McpAppPresenceStore;
    view: ReturnType<typeof createMcpAppViewModel>;
}): () => void {
    const base = `/api/live/${encodeURIComponent(options.instance)}/workspace`;
    const pending = new Map<AbortController, ServerResponse>();
    const revalidate = async (ctxId: string, token: string, workspace: string | undefined): Promise<number> => {
        if (!await options.leases.verify(options.instance, ctxId, token)) return 401;
        try {
            const record = await options.contexts.validateForInstance(ctxId, options.instance);
            const environment = record.environments.find((item) => item.instance === options.instance);
            if (record.status !== "active" || environment === undefined || environment.workspace !== workspace) return 403;
        } catch { return 403; }
        return 200;
    };
    const read = async (request: IncomingMessage, response: ServerResponse, watch: boolean) => {
        setHeaders(response);
        const url = new URL(request.url ?? "/", "http://localhost");
        const ctxId = url.searchParams.get("ctxId") ?? "";
        const token = /^Bearer (\S+)$/u.exec(request.headers.authorization ?? "")?.[1];
        if (!ctxId || ctxId.length > 256 || !token || !await options.leases.verify(options.instance, ctxId, token)) {
            reply(response, 401, { error: "Unauthorized" });
            return;
        }
        let workspace: string | undefined;
        try {
            const context = await options.contexts.validateForInstance(ctxId, options.instance);
            if (context.status !== "active") throw new Error("Inactive Context");
            const environment = context.environments.find((item) => item.instance === options.instance);
            if (environment === undefined) throw new Error("Context not attached to Instance");
            workspace = environment.workspace;
        } catch {
            reply(response, 403, { error: "Context unavailable" });
            return;
        }
        const rawCursor = url.searchParams.get("cursor") ?? "0";
        const cursor = Number(rawCursor);
        if (watch && (!/^(0|[1-9]\d*)$/u.test(rawCursor) || !Number.isSafeInteger(cursor) || cursor === Number.MAX_SAFE_INTEGER)) {
            reply(response, 400, { error: "Invalid cursor" });
            return;
        }
        options.presence.touch(options.instance, ctxId);
        if (!watch) {
            const snapshot = await options.view.snapshot(options.instance, ctxId, workspace);
            const access = await revalidate(ctxId, token, workspace);
            if (access !== 200) {
                reply(response, access, { error: "MCP App authorization expired" });
                return;
            }
            reply(response, 200, snapshot);
            return;
        }
        options.presence.beginWatch(options.instance, ctxId);
        const controller = new AbortController();
        pending.set(controller, response);
        const onClose = () => controller.abort();
        response.once("close", onClose);
        try {
            const result = await options.view.watch(options.instance, ctxId, workspace, cursor, controller.signal);
            if (controller.signal.aborted || response.destroyed || response.writableEnded) return;
            const access = await revalidate(ctxId, token, workspace);
            if (controller.signal.aborted || response.destroyed || response.writableEnded) return;
            if (access !== 200) reply(response, access, { error: "MCP App authorization expired" });
            else reply(response, 200, result);
        } finally {
            pending.delete(controller);
            response.off("close", onClose);
            options.presence.endWatch(options.instance, ctxId);
        }
    };
    const safe = async (request: IncomingMessage, response: ServerResponse, watch: boolean) => {
        try { await read(request, response, watch); }
        catch {
            if (response.destroyed || response.writableEnded) return;
            if (response.headersSent) response.end();
            else reply(response, 503, { error: "Workspace temporarily unavailable" });
        }
    };
    const snapshot = options.host.registerRawRoute("get", `${base}/snapshot`, (req, res) => safe(req, res, false));
    const watch = options.host.registerRawRoute("get", `${base}/watch`, (req, res) => safe(req, res, true));
    const preflightSnapshot = options.host.registerRawRoute("options", `${base}/snapshot`, (_req, res) => { setHeaders(res); res.writeHead(204).end(); });
    const preflightWatch = options.host.registerRawRoute("options", `${base}/watch`, (_req, res) => { setHeaders(res); res.writeHead(204).end(); });
    return () => {
        for (const [controller, response] of pending) {
            controller.abort();
            if (!response.destroyed && !response.writableEnded)
                reply(response, 410, { error: "MCP App Instance unavailable" });
        }
        preflightWatch();
        preflightSnapshot();
        watch();
        snapshot();
    };
}

function setHeaders(response: ServerResponse): void {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Authorization");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
}

function reply(response: ServerResponse, status: number, body: unknown): void {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.writeHead(status);
    response.end(JSON.stringify(body));
}
