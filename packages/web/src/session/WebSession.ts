import { webRoutePath } from "../routing/webRoute.js";

export interface WebSession {
    check(): Promise<boolean>;
    establish(token?: string): Promise<boolean>;
    logout(): Promise<void>;
}

export class BrowserWebSession implements WebSession {
    constructor(
        private readonly request: typeof fetch = fetch,
        private readonly path = sessionPath(),
    ) {}

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
