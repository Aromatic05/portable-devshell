export class McpAuthPublicBaseUrlValidator {
    isLocalhost(publicBaseUrl: string | undefined): boolean {
        if (publicBaseUrl === undefined) {
            return true;
        }

        const url = new URL(publicBaseUrl);
        return url.hostname === "localhost" || url.hostname === "127.0.0.1";
    }
}
