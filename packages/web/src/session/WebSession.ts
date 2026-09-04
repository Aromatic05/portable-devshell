import { webRoutePath } from "../routing/webRoute.js";

export type WebAuthMode = "none" | "oauth2" | "token";

export interface WebSession {
    authMode(): Promise<WebAuthMode>;
    check(): Promise<boolean>;
    establish(token?: string): Promise<boolean>;
    logout(): Promise<void>;
    startOAuth(): void;
}

export class BrowserWebSession implements WebSession {
    constructor(
        private readonly request: typeof fetch = (input, init) => globalThis.fetch(input, init),
        private readonly path = sessionPath(),
        private readonly oauthPath = oauthStartPath(),
        private readonly navigate: (url: string) => void = (url) => {
            window.location.href = url;
        },
        private readonly returnTo = webReturnTo(),
    ) {}

    async authMode(): Promise<WebAuthMode> {
        const response = await this.request(this.path, {
            credentials: "same-origin",
            method: "GET",
        });
        if (response.status === 204) {
            return "none";
        }
        try {
            const body = (await response.json()) as { auth?: unknown };
            if (body.auth === "oauth2" || body.auth === "none" || body.auth === "token") {
                return body.auth;
            }
        } catch {
            // Fall through to the default interactive mode.
        }
        return "token";
    }

    async check(): Promise<boolean> {
        const response = await this.request(this.path, {
            credentials: "same-origin",
            method: "GET",
        });
        if (response.status === 204) {
            this.#navigateAfterAuthentication();
            return true;
        }
        if (response.status === 200) {
            const body = (await response.json()) as { authenticated?: unknown };
            const authenticated = body.authenticated === true;
            if (authenticated) this.#navigateAfterAuthentication();
            return authenticated;
        }
        if (response.status === 401) {
            return false;
        }
        throw new Error("Unable to establish a session.");
    }

    async establish(token?: string): Promise<boolean> {
        return await this.send(token);
    }

    async logout(): Promise<void> {
        const response = await this.request(this.path, {
            credentials: "same-origin",
            method: "DELETE",
        });
        if (response.status !== 204) {
            throw new Error("Unable to log out.");
        }
    }

    startOAuth(): void {
        this.navigate(withReturnTo(this.oauthPath, this.returnTo));
    }

    private async send(token?: string): Promise<boolean> {
        const response = await this.request(this.path, {
            credentials: "same-origin",
            headers:
                token === undefined
                    ? undefined
                    : { Authorization: `Bearer ${token}` },
            method: "POST",
        });
        if (response.status === 204) {
            this.#navigateAfterAuthentication();
            return true;
        }
        if (response.status === 200) {
            this.#navigateAfterAuthentication();
            return true;
        }
        if (response.status === 401) {
            return false;
        }
        throw new Error("Unable to establish a session.");
    }

    #navigateAfterAuthentication(): void {
        if (this.returnTo !== undefined) this.navigate(this.returnTo);
    }
}

export function sessionPath(location: Location = window.location): string {
    return webRoutePath(location.pathname, "/session");
}

export function oauthStartPath(location: Location = window.location): string {
    return webRoutePath(location.pathname, "/oauth/start");
}

export function webReturnTo(location: Location = window.location): string | undefined {
    const raw = new URLSearchParams(location.search).get("returnTo");
    if (raw === null || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return undefined;
    const basePath = webRoutePath(location.pathname, "/session").slice(0, -"/session".length);
    const target = new URL(raw, "http://localhost");
    if (target.origin !== "http://localhost") return undefined;
    if (target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) return undefined;
    return `${target.pathname}${target.search}${target.hash}`;
}

function withReturnTo(path: string, returnTo: string | undefined): string {
    if (returnTo === undefined) return path;
    const url = new URL(path, "http://localhost");
    url.searchParams.set("returnTo", returnTo);
    return `${url.pathname}${url.search}`;
}
