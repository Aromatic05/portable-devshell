import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

const MAX_OAUTH_DOCUMENT_BYTES = 1024 * 1024;

// Reject special-use addresses before opening a socket. This covers both
// literal-IP client IDs and DNS responses, including DNS rebinding: the same
// verified addresses are pinned into the socket's lookup callback.
const denied = new BlockList();
for (const [prefix, bits] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
    ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24],
    ["192.52.193.0", 24], ["192.88.99.0", 24],
    ["192.168.0.0", 16], ["192.175.48.0", 24],
    ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) denied.addSubnet(prefix, bits, "ipv4");

for (const [prefix, bits] of [
    ["::", 128], ["::1", 128], ["::", 96],
    ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
    ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
    ["2620:4f:8000::", 48], ["3fff::", 20],
    ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) denied.addSubnet(prefix, bits, "ipv6");

export function isPublicOAuthAddress(address: string): boolean {
    const family = isIP(address);
    return family !== 0 && !denied.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Outbound OIDC fetch with a verified, pinned TLS destination. oidc-provider's
 * undici Agent 'connect' event guard does not intercept all HTTPS sockets on
 * Node 24, so the security decision must precede the connection itself.
 */
export const fetchPublicOAuthDocument: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("OAuth document fetch requires an HTTPS URL without credentials");
    }
    const hostname = url.hostname.startsWith("[")
        ? url.hostname.slice(1, -1)
        : url.hostname;
    const literalFamily = isIP(hostname);
    const addresses = literalFamily === 0
        ? await dnsLookup(hostname, { all: true, verbatim: true })
        : [{ address: hostname, family: literalFamily }];
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicOAuthAddress(address))) {
        throw new Error("OAuth document hostname resolves to a special-use IP address (SSRF blocked)");
    }

    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = init?.body;
    if (body !== undefined && body !== null &&
        typeof body !== "string" && !(body instanceof URLSearchParams) &&
        !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
        throw new TypeError("Unsupported outbound OAuth document request body");
    }
    return await new Promise<Response>((resolve, reject) => {
        const outgoing = request(url, {
                agent: false,
                headers: Object.fromEntries(headers),
                method,
                signal: init?.signal ?? undefined,
                // No second DNS lookup is allowed: the chosen socket address
                // comes solely from the vetted results above.
                lookup: (_host, options, callback) => {
                    if (options.all) callback(null, addresses);
                    else callback(null, addresses[0]!.address, addresses[0]!.family);
                },
            }, (incoming) => {
                void (async () => {
                const status = incoming.statusCode ?? 502;
                // Deliberately never follow redirects to an unchecked location.
                const chunks: Buffer[] = [];
                let bytes = 0;
                for await (const chunk of incoming) {
                    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    bytes += data.length;
                    if (bytes > MAX_OAUTH_DOCUMENT_BYTES) {
                        incoming.destroy();
                        throw new Error("OAuth document response exceeds the size limit");
                    }
                    chunks.push(data);
                }
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(incoming.headers)) {
                    if (value !== undefined) responseHeaders.set(
                        name,
                        Array.isArray(value) ? value.join(", ") : value,
                    );
                }
                const responseBody = [204, 205, 304].includes(status)
                    ? null : Buffer.concat(chunks).toString("utf8");
                resolve(new Response(responseBody, {
                    headers: responseHeaders,
                    status,
                    statusText: incoming.statusMessage,
                }));
                })().catch(reject);
            });
        outgoing.on("error", reject);
        if (body !== undefined && body !== null) outgoing.write(body.toString());
        outgoing.end();
    });
};
