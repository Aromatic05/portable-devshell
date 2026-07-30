import { describe, expect, it, vi } from "vitest";

import { BrowserWebSession, sessionPath } from "../src/session/WebSession.js";

describe("BrowserWebSession", () => {
    it("uses same-origin cookies and only adds Authorization for token exchange", async () => {
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response(null, { status: 401 }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        const session = new BrowserWebSession(request);

        expect(await session.check()).toBe(false);
        expect(await session.establish()).toBe(true);
        expect(await session.establish("short-lived-token")).toBe(true);

        expect(request).toHaveBeenNthCalledWith(1, "/web/session", {
            credentials: "same-origin",
            method: "GET",
        });
        expect(request).toHaveBeenNthCalledWith(2, "/web/session", {
            credentials: "same-origin",
            headers: undefined,
            method: "POST",
        });
        expect(request).toHaveBeenNthCalledWith(3, "/web/session", {
            credentials: "same-origin",
            headers: { Authorization: "Bearer short-lived-token" },
            method: "POST",
        });
    });

    it("uses the deployed WebUI path prefix for session requests", async () => {
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status: 204 }));
        const location = { pathname: "/devshell/web/" } as Location;
        const session = new BrowserWebSession(request, sessionPath(location));

        await session.check();
        await session.logout();

        expect(request).toHaveBeenNthCalledWith(1, "/devshell/web/session", {
            credentials: "same-origin",
            method: "GET",
        });
        expect(request).toHaveBeenNthCalledWith(2, "/devshell/web/session", {
            credentials: "same-origin",
            method: "DELETE",
        });
    });

    it("deletes the cookie-backed session", async () => {
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status: 204 }));
        const session = new BrowserWebSession(request);

        await session.logout();

        expect(request).toHaveBeenCalledWith("/web/session", {
            credentials: "same-origin",
            method: "DELETE",
        });
    });
});
