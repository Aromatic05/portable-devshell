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
        private readonly request: typeof fetch = fetch,
        private readonly path = sessionPath(),
        private readonly oauthPath = oauthStartPath(),
        private readonly navigate: (url: string) => void = (url) => {
            window.location.href = url;
        },
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
        return await this.send("GET");
    }

    async establish(token?: string): Promise<boolean> {
        return await this.send("POST", token);
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
        this.navigate(this.oauthPath);
    }

    private async send(
        method: "GET" | "POST",
        token?: string,
    ): Promise<boolean> {
        const response = await this.request(this.path, {
            credentials: "same-origin",
            headers:
                token === undefined
                    ? undefined
                    : { Authorization: `Bearer ${token}` },
            method,
        });
        if (response.status === 204) {
            return true;
        }
        if (response.status === 401) {
            return false;
        }
        throw new Error("Unable to establish a session.");
    }
}

export function sessionPath(location: Location = window.location): string {
    return webRoutePath(location.pathname, "/session");
}

export function oauthStartPath(location: Location = window.location): string {
    return webRoutePath(location.pathname, "/oauth/start");
}
