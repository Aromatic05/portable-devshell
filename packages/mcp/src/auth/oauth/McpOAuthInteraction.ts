import express, {
    type Express,
    type Request,
    type Response
} from "express";
import Provider from "oidc-provider";

import {
    McpOAuthApprovalService,
    type OAuthApprovalInput
} from "./McpOAuthApprovalService.js";

type ProviderGrant = InstanceType<Provider["Grant"]>;

export interface McpOAuthInteractionPageInput {
    accountId: string;
    approvalId: string;
    approvalKind: "authorization" | "registration";
    approvalStatus: "approved" | "pending";
    clientName: string;
    promptName: "consent" | "login";
    requestedResources: Array<{
        indicator: string;
        scopes: string[];
    }>;
    requiredScopes: string[];
}

export interface McpOAuthInteractionOptions {
    accountId: string;
    approvals: McpOAuthApprovalService;
    basePath: string;
    provider: () => Provider;
}

export class McpOAuthInteraction {
    readonly #accountId: string;
    readonly #approvals: McpOAuthApprovalService;
    readonly #basePath: string;
    readonly #provider: () => Provider;

    constructor(options: McpOAuthInteractionOptions) {
        this.#accountId = options.accountId;
        this.#approvals = options.approvals;
        this.#basePath = options.basePath;
        this.#provider = options.provider;
    }

    install(app: Express): void {
        const parseForm = express.urlencoded({ extended: false });
        app.get(
            `${this.#basePath}/oauth/approvals/:approvalId`,
            async (request, response) => {
                const approval = await this.#approvals.get(
                    request.params.approvalId
                );
                response.json({ status: approval?.status ?? "missing" });
            }
        );
        app.get(this.interactionRoute, async (request, response) => {
            await this.#renderInteraction(request, response);
        });
        app.post(
            this.interactionRoute,
            parseForm,
            async (request, response) => {
                await this.#submitInteraction(request, response);
            }
        );
    }

    get interactionRoute(): string {
        return `${this.#basePath}/interaction/:uid`;
    }

    renderPage(input: McpOAuthInteractionPageInput): string {
        const scopes = input.requiredScopes
            .map((scope) => `<li>${escapeHtml(scope)}</li>`)
            .join("");
        const resources = input.requestedResources
            .map(({ indicator, scopes: requestedScopes }) => {
                const entries = requestedScopes
                    .map((scope) => `<li>${escapeHtml(scope)}</li>`)
                    .join("");
                return `<li><strong>${escapeHtml(indicator)}</strong><ul>${entries}</ul></li>`;
            })
            .join("");
        const title = input.promptName === "login"
            ? "Sign In"
            : "Authorize";
        const action = input.promptName === "login"
            ? "Continue as aromatic"
            : "Approve access";
        const waiting = input.approvalStatus === "pending";
        const approvedAction = input.approvalKind === "registration"
            ? "window.location.reload();"
            : "form.submit();";
        const approvalPath = `${this.#basePath}/oauth/approvals/${input.approvalId}`;

        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; background: #f6f5ef; color: #1e1b16; margin: 0; padding: 32px 16px; }
    main { max-width: 720px; margin: 0 auto; background: #fffdf7; border: 1px solid #ddd3c1; border-radius: 16px; padding: 24px; box-shadow: 0 12px 40px rgba(30, 27, 22, 0.08); }
    h1 { margin-top: 0; font-size: 28px; }
    p, li { line-height: 1.5; }
    button { border: 0; border-radius: 999px; background: #1e1b16; color: #fffdf7; padding: 12px 20px; font-size: 16px; cursor: pointer; }
    ul { margin-top: 8px; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p><strong>${escapeHtml(input.clientName)}</strong> is requesting access as <strong>${escapeHtml(input.accountId)}</strong>.</p>
    ${scopes.length > 0 ? `<p>Scopes:</p><ul>${scopes}</ul>` : ""}
    ${resources.length > 0 ? `<p>Resource access:</p><ul>${resources}</ul>` : ""}
    <p id="approval-status">${waiting ? "Waiting for administrator approval." : "Administrator approved this request."}</p>
    <form id="interaction-form" method="post">
      <button type="submit" ${waiting ? "disabled" : ""}>${action}</button>
    </form>
    <script>
      const status = document.getElementById("approval-status");
      const form = document.getElementById("interaction-form");
      async function checkApproval() {
        const response = await fetch("${escapeHtml(approvalPath)}", { cache: "no-store" });
        const payload = await response.json();
        if (payload.status === "approved") {
          ${approvedAction}
          return;
        }
        if (payload.status === "denied" || payload.status === "expired" || payload.status === "missing") {
          status.textContent = "Administrator approval was not granted.";
          return;
        }
        setTimeout(checkApproval, 1000);
      }
      checkApproval();
    </script>
  </main>
</body>
</html>`;
    }

    async #renderInteraction(
        request: Request,
        response: Response
    ): Promise<void> {
        const provider = this.#provider();
        const details = await provider.interactionDetails(request, response);
        const promptName = details.prompt.name;
        if (promptName !== "login" && promptName !== "consent") {
            response
                .status(501)
                .type("text/plain")
                .send(`unsupported interaction prompt: ${promptName}`);
            return;
        }

        const approval = await this.#approvals.requestAuthorization(
            String(details.uid),
            toAuthorizationApprovalInput(details)
        );
        if (approval.status === "denied" || approval.status === "expired") {
            await this.#finishDeniedInteraction(
                provider,
                request,
                response,
                approval.status
            );
            return;
        }

        response.status(200).type("html").send(this.renderPage({
            accountId: this.#accountId,
            approvalId: approval.approvalId,
            approvalKind: approval.kind,
            approvalStatus: approval.status,
            clientName: readClientName(
                details.params.client_id,
                details.params.client_name
            ),
            promptName,
            requiredScopes: readStringArray(
                details.prompt.details.missingOIDCScope
            ),
            requestedResources: readRequestedResources(
                details.prompt.details.missingResourceScopes
            )
        }));
    }

    async #submitInteraction(
        request: Request,
        response: Response
    ): Promise<void> {
        const provider = this.#provider();
        const interaction = await provider.interactionDetails(request, response);
        const {
            prompt: { details, name },
            grantId,
            params,
            session
        } = interaction;
        const approval = await this.#approvals.getAuthorization(
            String(interaction.uid)
        );

        if (approval?.status !== "approved") {
            if (approval?.status === "pending") {
                response
                    .status(409)
                    .type("text/plain")
                    .send("Administrator approval is still pending.");
                return;
            }
            await this.#finishDeniedInteraction(
                provider,
                request,
                response,
                approval?.status ?? "missing"
            );
            return;
        }

        if (name === "login") {
            await provider.interactionFinished(
                request,
                response,
                { login: { accountId: this.#accountId } },
                { mergeWithLastSubmission: false }
            );
            return;
        }
        if (name !== "consent") {
            response
                .status(501)
                .type("text/plain")
                .send(`unsupported interaction prompt: ${name}`);
            return;
        }

        let grant: ProviderGrant | undefined;
        if (grantId !== undefined) {
            grant = await provider.Grant.find(grantId);
        }
        if (grant === undefined) {
            grant = new provider.Grant({
                accountId: session?.accountId ?? this.#accountId,
                clientId: String(params.client_id)
            });
        }
        if (details.missingOIDCScope) {
            grant.addOIDCScope(
                readStringArray(details.missingOIDCScope).join(" ")
            );
        }
        if (details.missingOIDCClaims) {
            grant.addOIDCClaims(readStringArray(details.missingOIDCClaims));
        }
        if (details.missingResourceScopes) {
            for (const [indicator, scopes] of Object.entries(
                details.missingResourceScopes
            )) {
                grant.addResourceScope(
                    indicator,
                    readStringArray(scopes).join(" ")
                );
            }
        }

        await provider.interactionFinished(
            request,
            response,
            { consent: { grantId: await grant.save() } },
            { mergeWithLastSubmission: true }
        );
    }

    async #finishDeniedInteraction(
        provider: Provider,
        request: Request,
        response: Response,
        status: "denied" | "expired" | "missing"
    ): Promise<void> {
        await provider.interactionFinished(
            request,
            response,
            {
                error: "access_denied",
                error_description: status === "expired"
                    ? "Administrator approval expired."
                    : "Administrator approval was denied."
            },
            { mergeWithLastSubmission: false }
        );
    }
}

function toAuthorizationApprovalInput(
    details: Awaited<ReturnType<Provider["interactionDetails"]>>
): OAuthApprovalInput {
    return {
        clientId: typeof details.params.client_id === "string"
            ? details.params.client_id
            : "unknown-client",
        clientName: readClientName(
            details.params.client_id,
            details.params.client_name
        ),
        redirectUris: typeof details.params.redirect_uri === "string"
            ? [details.params.redirect_uri]
            : [],
        requestedResources: typeof details.params.resource === "string"
            ? [details.params.resource]
            : [],
        requestedScopes: typeof details.params.scope === "string"
            ? details.params.scope
                .split(/\s+/u)
                .filter((scope) => scope.length > 0)
            : []
    };
}

function readClientName(clientId: unknown, clientName: unknown): string {
    if (typeof clientName === "string" && clientName.length > 0) {
        return clientName;
    }
    if (typeof clientId === "string" && clientId.length > 0) {
        return clientId;
    }
    return "unknown-client";
}

function readRequestedResources(
    resources: unknown
): Array<{ indicator: string; scopes: string[] }> {
    if (
        typeof resources !== "object" ||
        resources === null ||
        Array.isArray(resources)
    ) {
        return [];
    }
    return Object.entries(resources)
        .map(([indicator, scopes]) => ({
            indicator,
            scopes: readStringArray(scopes)
        }))
        .filter(({ scopes }) => scopes.length > 0);
}

function readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry): entry is string => {
        return typeof entry === "string";
    });
}

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
