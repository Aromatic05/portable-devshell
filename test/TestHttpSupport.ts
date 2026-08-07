import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { connect, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

export function requireTcpPort(address: AddressInfo | string | null | undefined): number {
    assert.notEqual(address, null);
    assert.notEqual(address, undefined);
    assert.equal(typeof address, "object");
    return (address as AddressInfo).port;
}

export interface LoopbackHttpProxy {
    close(): Promise<void>;
    readonly origin: string;
    setTarget(origin: string): void;
}

export async function startLoopbackHttpProxy(): Promise<LoopbackHttpProxy> {
    let targetOrigin: URL | undefined;
    const upgradedSockets = new Set<Duplex>();
    const server = createServer((incoming, response) => {
        if (targetOrigin === undefined) {
            response.writeHead(503);
            response.end();
            return;
        }

        const target = new URL(incoming.url ?? "/", targetOrigin);
        const upstream = request(target, {
            headers: incoming.headers,
            method: incoming.method,
        }, (upstreamResponse) => {
            response.writeHead(
                upstreamResponse.statusCode ?? 502,
                upstreamResponse.headers,
            );
            upstreamResponse.pipe(response);
        });
        incoming.once("aborted", () => upstream.destroy());
        response.once("close", () => upstream.destroy());
        upstream.on("error", (error) => {
            if (!response.headersSent) response.writeHead(502);
            response.destroy(error);
        });
        incoming.pipe(upstream);
    });
    server.on("upgrade", (incoming, socket, head) => {
        if (targetOrigin === undefined || targetOrigin.protocol !== "http:") {
            socket.destroy();
            return;
        }

        const targetPort = targetOrigin.port.length === 0
            ? 80
            : Number.parseInt(targetOrigin.port, 10);
        const upstream = connect(targetPort, targetOrigin.hostname);
        upgradedSockets.add(socket);
        upgradedSockets.add(upstream);
        const forget = (candidate: Duplex) => () => upgradedSockets.delete(candidate);
        socket.once("close", forget(socket));
        upstream.once("close", forget(upstream));
        upstream.once("connect", () => {
            const rawHeaders = [];
            for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
                rawHeaders.push(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}`);
            }
            upstream.write(
                `${incoming.method ?? "GET"} ${incoming.url ?? "/"} HTTP/${incoming.httpVersion}\r\n${rawHeaders.join("\r\n")}\r\n\r\n`,
            );
            if (head.length > 0) upstream.write(head);
            socket.pipe(upstream).pipe(socket);
        });
        upstream.once("error", () => socket.destroy());
        socket.once("error", () => upstream.destroy());
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${requireTcpPort(server.address())}`;

    return {
        async close() {
            for (const socket of upgradedSockets) socket.destroy();
            upgradedSockets.clear();
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error === undefined ? resolve() : reject(error));
            });
        },
        origin,
        setTarget(nextOrigin) {
            targetOrigin = new URL(nextOrigin);
        },
    };
}
