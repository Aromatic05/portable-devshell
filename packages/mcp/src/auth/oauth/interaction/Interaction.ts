import { createHash, timingSafeEqual } from "node:crypto";

import express, { type Express, type Request, type Response } from "express";
import Provider from "oidc-provider";
import type { OAuthApprovalRequest } from "@portable-devshell/shared";

import type { McpOAuthApprovalConfig } from "../../Config.js";

import {
    McpOAuthApprovalService,
    type OAuthApprovalInput,
} from "./Approval.js";

type ProviderGrant = InstanceType<Provider["Grant"]>;

export interface McpOAuthInteractionPageInput {
    accountId: string;
    approvalId: string;
    approvalKind: "authorization" | "registration";
    approvalMode: "token" | "tui";
    approvalStatus: "approved" | "pending";
    approvalTokenConfigured: boolean;
    clientName: string;
    error?: string;
    promptName: "consent" | "login";
    requestedResources: Array<{
        indicator: string;
        scopes: string[];
    }>;
    requiredScopes: string[];
}

export interface McpOAuthInteractionOptions {
    accountId: string;
    approval: McpOAuthApprovalConfig;
    approvals: McpOAuthApprovalService;
    basePath: string;
    provider: () => Provider;
}

export class McpOAuthInteraction {
    readonly #accountId: string;
    readonly #approval: McpOAuthApprovalConfig;
    readonly #approvals: McpOAuthApprovalService;
    readonly #basePath: string;
    readonly #provider: () => Provider;

    constructor(options: McpOAuthInteractionOptions) {
        this.#accountId = options.accountId;
        this.#approval = options.approval;
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
                    request.params.approvalId,
                );
                response.json({ status: approval?.status ?? "missing" });
            },
        );
        app.get(this.interactionRoute, async (request, response) => {
            await this.#renderInteraction(request, response);
        });
        app.post(
            this.interactionRoute,
            parseForm,
            async (request, response) => {
                await this.#submitInteraction(request, response);
            },
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
        const waiting = input.approvalStatus === "pending";
        const approvalPath = `${this.#basePath}/oauth/approvals/${input.approvalId}`;
        const approvedAction =
            input.approvalKind === "registration"
                ? "window.location.reload();"
                : "document.getElementById(\"interaction-form\").submit();";
        const error =
            input.error === undefined
                ? ""
                : `<p class="error" role="alert">${escapeHtml(input.error)}</p>`;
        const approvalUi =
            !waiting
                ? `<section class="approval-box">
      <p>Approved. Continuing…</p>
      <form id="interaction-form" method="post"></form>
    </section>`
                : input.approvalMode === "tui"
                  ? `<section class="approval-box">
      <p>Approve this OAuth2 request from DevShell:</p>
      <ol>
        <li>Open the DevShell TUI.</li>
        <li>Go to <strong>Connections → OAuth Approvals</strong>.</li>
        <li>Approve request <code>${escapeHtml(input.approvalId)}</code>.</li>
      </ol>
      <p>Or run:</p>
      <pre><code>devshell oauth approve ${escapeHtml(input.approvalId)}</code></pre>
      <p id="approval-status">Waiting for approval…</p>
      <form id="interaction-form" method="post"></form>
    </section>`
                  : input.approvalTokenConfigured
                    ? `<section class="approval-box">
      ${error}
      <form id="interaction-form" method="post">
        <label for="approval-token">Approval token</label>
        <input id="approval-token" name="approvalToken" type="password" autocomplete="current-password" required autofocus>
        <button type="submit">Approve</button>
      </form>
    </section>`
                    : `<section class="approval-box">
      <p class="error" role="alert">OAuth2 approval token is not configured.</p>
      <p>Run <code>devshell init</code> to create the initial approval token.</p>
    </section>`;
        const tuiScript =
            !waiting
                ? `<script>${approvedAction}</script>`
                : input.approvalMode !== "tui"
                  ? ""
                  : `<script>
      const status = document.getElementById("approval-status");
      async function checkApproval() {
        const response = await fetch("${escapeHtml(approvalPath)}", { cache: "no-store" });
        const payload = await response.json();
        if (payload.status === "approved") {
          ${approvedAction}
          return;
        }
        if (payload.status === "denied" || payload.status === "expired" || payload.status === "missing") {
          status.textContent = "Approval was not granted.";
          return;
        }
        setTimeout(checkApproval, 1000);
      }
      checkApproval();
    </script>`;

        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>OAuth2 Approval</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; background: #f6f5ef; color: #1e1b16; margin: 0; padding: 32px 16px; }
    main { max-width: 720px; margin: 0 auto; background: #fffdf7; border: 1px solid #ddd3c1; border-radius: 16px; padding: 24px; box-shadow: 0 12px 40px rgba(30, 27, 22, 0.08); }
    h1 { margin-top: 0; font-size: 28px; }
    p, li { line-height: 1.5; }
    ul { margin-top: 8px; }
    .approval-box { margin-top: 24px; padding-top: 20px; border-top: 1px solid #e5ddcf; }
    label { display: block; font-weight: 600; margin-bottom: 8px; }
    input { box-sizing: border-box; width: 100%; max-width: 460px; border: 1px solid #b9ae9b; border-radius: 8px; padding: 11px 12px; font: inherit; }
    button { display: block; margin-top: 12px; border: 0; border-radius: 999px; background: #1e1b16; color: #fffdf7; padding: 12px 20px; font-size: 16px; cursor: pointer; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { overflow-x: auto; background: #f1ede4; border-radius: 8px; padding: 12px; }
    .error { color: #9b1c1c; }
  </style>
</head>
<body>
  <main>
    <h1>OAuth2 Approval</h1>
    <p><strong>${escapeHtml(input.clientName)}</strong> is requesting access as <strong>${escapeHtml(input.accountId)}</strong>.</p>
    ${scopes.length > 0 ? `<p>Scopes:</p><ul>${scopes}</ul>` : ""}
    ${resources.length > 0 ? `<p>Resource access:</p><ul>${resources}</ul>` : ""}
    ${approvalUi}
    ${tuiScript}
  </main>
</body>
</html>`;
    }

    async #renderInteraction(
        request: Request,
        response: Response,
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
            authorizationTransactionId(details),
            toAuthorizationApprovalInput(details),
        );
        if (approval.status === "denied" || approval.status === "expired") {
            await this.#finishDeniedInteraction(
                provider,
                request,
                response,
                approval.status,
            );
            return;
        }

        response
            .status(200)
            .type("html")
            .send(
                this.renderPage(
                    this.#pageInput(details, approval),
                ),
            );
    }

    async #submitInteraction(
        request: Request,
        response: Response,
    ): Promise<void> {
        const provider = this.#provider();
        const interaction = await provider.interactionDetails(request, response);
        const {
            prompt: { details, name },
            grantId,
            params,
            session,
        } = interaction;
        if (name !== "login" && name !== "consent") {
            response
                .status(501)
                .type("text/plain")
                .send(`unsupported interaction prompt: ${name}`);
            return;
        }

        let approval = await this.#approvals.requestAuthorization(
            String(interaction.uid),
            authorizationTransactionId(interaction),
            toAuthorizationApprovalInput(interaction),
        );
        if (approval.status === "denied" || approval.status === "expired") {
            await this.#finishDeniedInteraction(
                provider,
                request,
                response,
                approval.status,
            );
            return;
        }

        if (this.#approval.mode === "token" && approval.status === "pending") {
            const configuredToken = this.#approval.token;
            const suppliedToken = readFormString(request.body, "approvalToken");
            if (configuredToken === undefined) {
                response
                    .status(503)
                    .type("html")
                    .send(this.renderPage(this.#pageInput(interaction, approval)));
                return;
            }
            if (!tokensEqual(configuredToken, suppliedToken)) {
                response
                    .status(403)
                    .type("html")
                    .send(
                        this.renderPage(
                            this.#pageInput(
                                interaction,
                                approval,
                                "The approval token is invalid.",
                            ),
                        ),
                    );
                return;
            }
            if (approval.status === "pending") {
                approval = await this.#approvals.decide(
                    approval.approvalId,
                    "approve",
                    "web",
                );
            }
            if (approval.kind === "registration") {
                approval = await this.#approvals.requestAuthorization(
                    String(interaction.uid),
                    authorizationTransactionId(interaction),
                    toAuthorizationApprovalInput(interaction),
                );
                if (approval.status === "pending") {
                    approval = await this.#approvals.decide(
                        approval.approvalId,
                        "approve",
                        "web",
                    );
                }
            }
        } else if (approval.kind === "registration") {
            response
                .status(409)
                .type("text/plain")
                .send("Client registration approval is still pending.");
            return;
        }

        if (approval.status !== "approved") {
            if (approval.status === "pending") {
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
                approval.status,
            );
            return;
        }

        if (name === "login") {
            await provider.interactionFinished(
                request,
                response,
                { login: { accountId: this.#accountId } },
                { mergeWithLastSubmission: false },
            );
            return;
        }

        let grant: ProviderGrant | undefined;
        if (grantId !== undefined) {
            grant = await provider.Grant.find(grantId);
        }
        if (grant === undefined) {
            grant = new provider.Grant({
                accountId: session?.accountId ?? this.#accountId,
                clientId: String(params.client_id),
            });
        }
        if (details.missingOIDCScope) {
            grant.addOIDCScope(
                readStringArray(details.missingOIDCScope).join(" "),
            );
        }
        if (details.missingOIDCClaims) {
            grant.addOIDCClaims(readStringArray(details.missingOIDCClaims));
        }
        if (details.missingResourceScopes) {
            for (const [indicator, scopes] of Object.entries(
                details.missingResourceScopes,
            )) {
                grant.addResourceScope(
                    indicator,
                    readStringArray(scopes).join(" "),
                );
            }
        }

        await provider.interactionFinished(
            request,
            response,
            { consent: { grantId: await grant.save() } },
            { mergeWithLastSubmission: true },
        );
        await this.#approvals.completeAuthorization(String(interaction.uid));
    }

    #pageInput(
        details: Awaited<ReturnType<Provider["interactionDetails"]>>,
        approval: OAuthApprovalRequest,
        error?: string,
    ): McpOAuthInteractionPageInput {
        return {
            accountId: this.#accountId,
            approvalId: approval.approvalId,
            approvalKind: approval.kind,
            approvalMode: this.#approval.mode,
            approvalStatus:
                approval.status === "approved" ? "approved" : "pending",
            approvalTokenConfigured:
                this.#approval.mode === "token" &&
                this.#approval.token !== undefined,
            clientName: readClientName(
                details.params.client_id,
                details.params.client_name,
            ),
            ...(error === undefined ? {} : { error }),
            promptName: details.prompt.name as "consent" | "login",
            requiredScopes: readStringArray(
                details.prompt.details.missingOIDCScope,
            ),
            requestedResources: readRequestedResources(
                details.prompt.details.missingResourceScopes,
            ),
        };
    }

    async #finishDeniedInteraction(
        provider: Provider,
        request: Request,
        response: Response,
        status: "denied" | "expired" | "missing",
    ): Promise<void> {
        await provider.interactionFinished(
            request,
            response,
            {
                error: "access_denied",
                error_description:
                    status === "expired"
                        ? "Administrator approval expired."
                        : "Administrator approval was denied.",
            },
            { mergeWithLastSubmission: false },
        );
    }
}

function authorizationTransactionId(
    details: Awaited<ReturnType<Provider["interactionDetails"]>>,
): string {
    const clientId =
        typeof details.params.client_id === "string"
            ? details.params.client_id
            : "unknown-client";
    const codeChallenge =
        typeof details.params.code_challenge === "string"
            ? details.params.code_challenge
            : undefined;
    const state =
        typeof details.params.state === "string"
            ? details.params.state
            : undefined;
    const transactionNonce = codeChallenge ?? state;
    if (transactionNonce === undefined) {
        return String(details.uid);
    }
    return JSON.stringify({ clientId, transactionNonce });
}

function toAuthorizationApprovalInput(
    details: Awaited<ReturnType<Provider["interactionDetails"]>>,
): OAuthApprovalInput {
    return {
        clientId:
            typeof details.params.client_id === "string"
                ? details.params.client_id
                : "unknown-client",
        clientName: readClientName(
            details.params.client_id,
            details.params.client_name,
        ),
        redirectUris:
            typeof details.params.redirect_uri === "string"
                ? [details.params.redirect_uri]
                : [],
        requestedResources:
            typeof details.params.resource === "string"
                ? [details.params.resource]
                : [],
        requestedScopes:
            typeof details.params.scope === "string"
                ? details.params.scope
                      .split(/\s+/u)
                      .filter((scope) => scope.length > 0)
                : [],
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
    resources: unknown,
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
            scopes: readStringArray(scopes),
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

function readFormString(body: unknown, key: string): string {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return "";
    const value = (body as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
}

function tokensEqual(expected: string, actual: string): boolean {
    const expectedDigest = createHash("sha256").update(expected).digest();
    const actualDigest = createHash("sha256").update(actual).digest();
    return timingSafeEqual(expectedDigest, actualDigest);
}

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
