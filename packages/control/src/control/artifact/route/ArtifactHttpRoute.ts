import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { HttpHost } from "@portable-devshell/mcp";
import { errorCodes, toControlErrorBody } from "@portable-devshell/shared";

import type { ArtifactService } from "../ArtifactService.js";

const ROUTE_SUFFIX = "/artifacts/share";
const HTTP_CHUNK_BYTES = 512 * 1024;

interface ByteRange {
    end: number;
    start: number;
}

interface ArtifactHttpRouteOptions {
    publicBaseUrl?: string;
}

class UnsatisfiableRangeError extends Error {}

export class ArtifactHttpRoute {
    readonly #routeBase: string;
    readonly #service: ArtifactService;

    constructor(service: ArtifactService, options?: ArtifactHttpRouteOptions) {
        this.#service = service;
        this.#routeBase = artifactShareRoute(options?.publicBaseUrl);
    }

    install(server: HttpHost): void {
        const path = `${this.#routeBase}/:token`;
        server.registerRawRoute("head", path, async (request, response) => {
            await this.#handle(request, response, true);
        });
        server.registerRawRoute("get", path, async (request, response) => {
            await this.#handle(request, response, false);
        });
    }

    async #handle(request: IncomingMessage, response: ServerResponse, headOnly: boolean): Promise<void> {
        setSecurityHeaders(response);
        const token = readToken(request, this.#routeBase);
        if (token === undefined) {
            sendText(response, 404, "Artifact share was not found.");
            return;
        }

        let access;
        try {
            access = await this.#service.resolveShare(token);
        } catch (error) {
            sendShareError(response, error);
            return;
        }

        const totalBytes = access.share.bytes;
        let range: ByteRange | undefined;
        try {
            range = parseRange(request.headers.range, totalBytes);
        } catch (error) {
            if (error instanceof UnsatisfiableRangeError) {
                response.statusCode = 416;
                response.setHeader("Content-Range", `bytes */${totalBytes}`);
                response.setHeader("Content-Length", "0");
                response.end();
                return;
            }
            throw error;
        }

        const start = range?.start ?? 0;
        const end = range?.end ?? Math.max(totalBytes - 1, 0);
        const length = totalBytes === 0 ? 0 : end - start + 1;
        if (headOnly) {
            response.statusCode = range === undefined ? 200 : 206;
            setDownloadHeaders(response, access.share, range, start, end, totalBytes, length);
            response.end();
            return;
        }

        try {
            access = await this.#service.beginShareDownload(token);
        } catch (error) {
            sendShareError(response, error);
            return;
        }

        response.statusCode = range === undefined ? 200 : 206;
        setDownloadHeaders(response, access.share, range, start, end, totalBytes, length);
        const exclusiveEnd = length === 0 ? start : end + 1;
        let offset = start;
        let downloadFinished = false;
        let finalBytes: Buffer | undefined;
        try {
            while (offset < exclusiveEnd && length > 0) {
                const requested = Math.min(HTTP_CHUNK_BYTES, exclusiveEnd - offset);
                const chunk = await this.#service.readSharePayload(access, offset, requested);
                if (
                    chunk.encoding !== "base64" ||
                    chunk.offsetBytes !== offset ||
                    chunk.returnedBytes <= 0 ||
                    chunk.returnedBytes > requested ||
                    chunk.totalBytes !== totalBytes
                ) {
                    throw new Error("Artifact payload returned an invalid HTTP chunk.");
                }
                const bytes = Buffer.from(chunk.content, "base64");
                if (bytes.length !== chunk.returnedBytes) {
                    throw new Error("Artifact payload byte count does not match its encoded content.");
                }
                const nextOffset = offset + bytes.length;
                if (nextOffset >= exclusiveEnd) {
                    finalBytes = bytes;
                    offset = nextOffset;
                    break;
                }
                if (!response.write(bytes)) {
                    await once(response, "drain");
                }
                offset = nextOffset;
            }
            await this.#service.finishShareDownload(token, true, {
                endBytes: exclusiveEnd,
                range: range !== undefined,
                startBytes: start
            });
            downloadFinished = true;
            if (finalBytes !== undefined && !response.write(finalBytes)) {
                await once(response, "drain");
            }
            response.end();
        } catch (error) {
            if (!response.headersSent) {
                sendShareError(response, error);
                return;
            }
            response.destroy(error instanceof Error ? error : new Error(String(error)));
        } finally {
            if (!downloadFinished) {
                await this.#service.finishShareDownload(token, false).catch(() => undefined);
            }
        }
    }
}

function setDownloadHeaders(
    response: ServerResponse,
    share: { downloadName: string; mediaType: string },
    range: ByteRange | undefined,
    start: number,
    end: number,
    totalBytes: number,
    length: number
): void {
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", share.mediaType);
    response.setHeader("Content-Disposition", contentDisposition(share.downloadName));
    response.setHeader("Content-Length", String(length));
    if (range !== undefined) {
        response.setHeader("Content-Range", `bytes ${start}-${end}/${totalBytes}`);
    }
}

export function artifactShareRoute(publicBaseUrl?: string): string {
    if (publicBaseUrl === undefined) {
        return ROUTE_SUFFIX;
    }
    const url = new URL(publicBaseUrl);
    const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, "");
    return `${basePath}${ROUTE_SUFFIX}`;
}

function readToken(request: IncomingMessage, routeBase: string): string | undefined {
    if (request.url === undefined) {
        return undefined;
    }
    try {
        const pathname = new URL(request.url, "http://localhost").pathname;
        const prefix = `${routeBase}/`;
        if (!pathname.startsWith(prefix)) {
            return undefined;
        }
        const encoded = pathname.slice(prefix.length);
        if (encoded.length === 0 || encoded.includes("/")) {
            return undefined;
        }
        const token = decodeURIComponent(encoded);
        return token.length > 0 ? token : undefined;
    } catch {
        return undefined;
    }
}

function parseRange(header: string | undefined, totalBytes: number): ByteRange | undefined {
    if (header === undefined) {
        return undefined;
    }
    if (totalBytes <= 0 || !header.startsWith("bytes=") || header.includes(",")) {
        throw new UnsatisfiableRangeError();
    }
    const value = header.slice("bytes=".length).trim();
    const match = /^(\d*)-(\d*)$/u.exec(value);
    if (match === null || (match[1] === "" && match[2] === "")) {
        throw new UnsatisfiableRangeError();
    }

    if (match[1] === "") {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
            throw new UnsatisfiableRangeError();
        }
        return {
            end: totalBytes - 1,
            start: Math.max(totalBytes - suffixLength, 0)
        };
    }

    const start = Number(match[1]);
    if (!Number.isSafeInteger(start) || start < 0 || start >= totalBytes) {
        throw new UnsatisfiableRangeError();
    }
    if (match[2] === "") {
        return { end: totalBytes - 1, start };
    }
    const requestedEnd = Number(match[2]);
    if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) {
        throw new UnsatisfiableRangeError();
    }
    return {
        end: Math.min(requestedEnd, totalBytes - 1),
        start
    };
}

function contentDisposition(name: string): string {
    const fallback =
        name
            .replace(/[\r\n\\/"]/gu, "_")
            .replace(/[^\x20-\x7e]/gu, "_")
            .slice(0, 180) || "download";
    const encoded = encodeURIComponent(name).replace(/[!'()*]/gu, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function setSecurityHeaders(response: ServerResponse): void {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendShareError(response: ServerResponse, error: unknown): void {
    const body = toControlErrorBody(error);
    const status =
        body?.code === errorCodes.artifactShareExpired ||
        body?.code === errorCodes.artifactShareRevoked ||
        body?.code === errorCodes.artifactShareExhausted
            ? 410
            : body?.code === errorCodes.artifactShareNotFound
              ? 404
              : 500;
    const message =
        status === 410
            ? "Artifact share is no longer available."
            : status === 404
              ? "Artifact share was not found."
              : "Artifact download failed.";
    sendText(response, status, message);
}

function sendText(response: ServerResponse, status: number, message: string): void {
    const body = Buffer.from(`${message}\n`, "utf8");
    response.statusCode = status;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Content-Length", String(body.length));
    response.end(body);
}
