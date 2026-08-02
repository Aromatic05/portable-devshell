import { describe, expect, it, vi } from "vitest";

import { BrowserWebSession, oauthStartPath, sessionPath } from "../src/session/WebSession.js";

describe("BrowserWebSession", () => {
    it("uses same-origin cookies and only adds Authorization for token exchange", async () => {
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response(JSON.stringify({ auth: "none", authenticated: false }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true }), { status: 200 }))
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

    it("reads the configured auth mode from the unauthorized session body", async () => {
        const request = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ auth: "oauth2", authenticated: false }), { status: 200 }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ auth: "token", authenticated: false }), { status: 200 }),
            )
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        const session = new BrowserWebSession(request);

        expect(await session.authMode()).toBe("oauth2");
        expect(await session.authMode()).toBe("token");
        expect(await session.authMode()).toBe("none");
    });

    it("navigates to the deployed OAuth start path", () => {
        const navigate = vi.fn();
        const location = { pathname: "/devshell/web/" } as Location;
        const session = new BrowserWebSession(
            vi.fn<typeof fetch>(),
            sessionPath(location),
            oauthStartPath(location),
            navigate,
        );

        session.startOAuth();

        expect(navigate).toHaveBeenCalledWith("/devshell/web/oauth/start");
    });
});
