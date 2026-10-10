import assert from "node:assert/strict";
import test from "node:test";

import {
    fetchPublicOAuthDocument,
    isPublicOAuthAddress,
} from "../../../src/oauth/provider/SafeFetch.ts";

test("OAuth metadata fetch excludes IPv4/IPv6 special-use and mapped destinations", () => {
    for (const address of [
        "0.0.0.0", "10.8.0.1", "100.64.12.13", "127.0.0.1",
        "169.254.169.254", "172.20.10.5", "192.168.50.1",
        "192.0.2.1", "198.18.1.1", "203.0.113.8", "224.0.0.1",
        "::", "::1", "::ffff:127.0.0.1", "::ffff:192.168.1.1",
        "fc00::1", "fd12::1", "fe80::1", "2001:db8::1",
    ]) {
        assert.equal(isPublicOAuthAddress(address), false, address);
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"]) {
        assert.equal(isPublicOAuthAddress(address), true, address);
    }
});

test("OAuth metadata fetch rejects loopback socket and non-HTTPS URL before dialing", async () => {
    await assert.rejects(
        fetchPublicOAuthDocument("https://127.0.0.1:1/client.json"),
        /special-use|SSRF/u,
    );
    await assert.rejects(
        fetchPublicOAuthDocument("https://[::1]:1/client.json"),
        /special-use|SSRF/u,
    );
    await assert.rejects(
        fetchPublicOAuthDocument("http://example.com/client.json"),
        /HTTPS/u,
    );
    await assert.rejects(
        fetchPublicOAuthDocument("https://user:secret@example.com/client.json"),
        /credentials/u,
    );
});
