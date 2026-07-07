export class McpAuthProviderToken {
    authorize(authorizationHeader: string | undefined): boolean {
        if (authorizationHeader === undefined) {
            return false;
        }

        const [scheme, token] = authorizationHeader.split(/\s+/, 2);
        return scheme === "Bearer" && typeof token === "string" && token.length > 0;
    }
}
