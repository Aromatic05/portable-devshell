import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type ReadStream, type WriteStream } from "node:tty";
import test from "node:test";
import { ControlSocketServer } from "../../../../control/src/server/transport/endpoint/Socket.ts";
import { createServerRouteModule } from "../../../../control/src/server/Route.ts";
import { createAuthRouteModule } from "../../../../control/src/server/auth/Route.ts";
import { type McpOAuthApprovalService } from "@portable-devshell/mcp";
import {
    routeModule,
    type ControlHostDefinition,
    type JsonValue,
    type MessageStream,
} from "@portable-devshell/shared";
import { TestMcpHost } from "../../../../mcp/test/ContextRuntime.ts";
import { modernRpcHeaders, modernRpcRequest } from "../../../../mcp/test/integration/ModernProtocol.ts";
import { createTestIpcPath } from "../../../../../test/TestPlatformSupport.ts";
import {
    requireTcpPort,
    startLoopbackHttpProxy,
} from "../../../../../test/TestHttpSupport.ts";
import { TuiRuntime } from "../../../src/app/Runtime.ts";
import {
    createTuiDomainSession,
    currentTuiRoute,
    selectMainScreenModel,
    topTuiOverlay,
} from "../../../src/testing.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

{
    test("real TUI keyboard approval completes first-party client onboarding, authorization, token exchange and modern MCP login", async (t) => {
        const directory = await createTestTempDirectory("tui-oauth-login");
        const socketPath = createTestIpcPath("tui-oauth-login", directory);
        const proxy = await startLoopbackHttpProxy();
        const origin = proxy.origin;
        const endpoint = `${origin}/demo/mcp`;
        // The public DCR endpoint is intentionally retired. This is a real
        // non-DCR client stored in the owning OIDC adapter before Host warmup.
        const client = {
            client_id: "portable-devshell-tui-keyboard-client",
            redirect_uris: ["https://client.example/callback"],
        };
        const adapterDir = join(directory, "oauth", "adapter");
        await mkdir(adapterDir, { recursive: true });
        await writeFile(join(adapterDir, "Client.json"), JSON.stringify({
            [client.client_id]: {
                payload: {
                    ...client,
                    client_name: "TUI keyboard acceptance client",
                    grant_types: ["authorization_code", "refresh_token"],
                    response_types: ["code"],
                    scope: "openid offline_access mcp",
                    token_endpoint_auth_method: "none",
                },
            },
        }));
        const host = new TestMcpHost({
            instances: [
                {
                    auth: {
                        enabled: true,
                        oauth2: {
                            requiredScopes: ["mcp"],
                            resourceName: "demo",
                        },
                        provider: "oauth2",
                    },
                    name: "demo",
                },
            ],
            listenHost: "127.0.0.1",
            listenPort: 0,
            publicBaseUrl: origin,
            storageDir: join(directory, "oauth"),
        });
        await host.start();
        const listenPort = requireTcpPort(host.server.address);
        proxy.setTarget(`http://127.0.0.1:${listenPort}`);
        const configView: JsonValue = {
            instances: [
                {
                    enabled: true,
                    extensions: { model: ["instance"] },
                    mcp: {
                        auth: {
                            mode: "oauth2",
                            oauth2: {
                                requiredScopes: ["mcp"],
                                resourceName: "demo",
                            },
                        },
                        contextMode: "explicit",
                        enabled: true,
                        path: "/demo/mcp",
                    },
                    name: "demo",
                    provider: "local",
                    security: { mode: "disabled" },
                    workspace: { enabled: true },
                },
            ],
            mcp: {
                auth: {
                    mode: "oauth2",
                    oauth2: {
                        requiredScopes: ["mcp"],
                        resourceName: "demo",
                    },
                },
                enabled: true,
                listenHost: "127.0.0.1",
                listenPort,
                oauth2: { approval: "tui" },
                publicBaseUrl: origin,
            },
        };
        const routes = {
            hosts: (): readonly ControlHostDefinition[] => [
                {
                    host: "@control",
                    ports: [
                        createServerRouteModule({
                            instanceCount: () => 0,
                            ready: () => true,
                            shutdown() {},
                        }),
                        createAuthRouteModule({
                            approvals: () => host.oauthApprovals,
                            status: () => {
                                const status = host.status();
                                return {
                                    authMode: status.authMode,
                                    oauthReady: status.oauthReady,
                                    running: status.running,
                                    ...(status.publicBaseUrl === undefined
                                        ? {}
                                        : {
                                              publicBaseUrl:
                                                  status.publicBaseUrl,
                                          }),
                                };
                            },
                        }),
                        // A real TUI client initializes every domain on one
                        // Endpoint. Missing Artifact subscription routes used
                        // to race startup with the OAuth keyboard workflow and
                        // leak a foreign route failure into its confirmation.
                        routeModule(
                            "artifact",
                            {
                                snapshot: () => ({ lastSeq: 0, shares: [], transfers: [] }),
                            },
                            { subscribe: emptySubscription },
                        ),
                        routeModule(
                            "config",
                            {
                                snapshot: () => ({
                                    revision: 1,
                                    view: configView,
                                }),
                            },
                            { subscribe: emptySubscription },
                        ),
                        routeModule(
                            "instance",
                            {
                                snapshotInstances: () => ({
                                    instances: [
                                        {
                                            enabled: true,
                                            homeDirectory: "/workspace/demo",
                                            mcpEnabled: true,
                                            name: "demo",
                                        },
                                    ],
                                    revision: 1,
                                }),
                            },
                            { subscribeInstances: emptySubscription },
                        ),
                        routeModule(
                            "context",
                            {
                                snapshot: () => ({
                                    contexts: [],
                                    revision: 1,
                                }),
                            },
                            { subscribe: emptySubscription },
                        ),
                    ],
                },
            ],
            onChange: () => () => undefined,
        };
        const control = new ControlSocketServer({ routes, socketPath });
        const terminal = createTerminal();
        const runtime = new TuiRuntime(
            { stdin: terminal.stdin, stdout: terminal.stdout },
            {
                domains: createTuiDomainSession({ socketPath }),
                inkDebug: true,
            },
        );

        await control.start();
        t.after(async () => {
            await control.stop();
            await host.stop();
            await proxy.close();
            await rm(directory, { force: true, recursive: true });
        });

        const running = runtime.run();
        try {
            await waitUntil(
                () =>
                    runtime.store.getState().connection.status === "connected",
            );
            runtime.store.setSelectedInstance("demo");
            await waitUntil(
                () => runtime.reader.mcp.status?.authMode === "oauth2",
            );
            await openOAuthPage(runtime, terminal);

            const metadataResponse = await fetch(
                `${origin}/.well-known/openid-configuration`,
            );
            assert.equal(metadataResponse.status, 200);
            const metadata = (await metadataResponse.json()) as {
                authorization_endpoint: string;
                token_endpoint: string;
            };
            assert.equal("registration_endpoint" in metadata, false);

            const verifier = randomBytes(32).toString("base64url");
            const challenge = createHash("sha256")
                .update(verifier)
                .digest("base64url");
            const redirectUri = client.redirect_uris[0]!;
            const authorizationUrl = new URL(metadata.authorization_endpoint);
            authorizationUrl.searchParams.set("client_id", client.client_id);
            authorizationUrl.searchParams.set("redirect_uri", redirectUri);
            authorizationUrl.searchParams.set("response_type", "code");
            authorizationUrl.searchParams.set("scope", "mcp offline_access");
            authorizationUrl.searchParams.set("code_challenge", challenge);
            authorizationUrl.searchParams.set("code_challenge_method", "S256");
            authorizationUrl.searchParams.set("resource", endpoint);

            const code = await authorizeThroughTuiKeyboard(
                runtime,
                terminal,
                host.oauthApprovals!,
                authorizationUrl.href,
                redirectUri,
            );

            const tokenResponse = await fetch(metadata.token_endpoint, {
                body: new URLSearchParams({
                    client_id: client.client_id,
                    code: code!,
                    code_verifier: verifier,
                    grant_type: "authorization_code",
                    redirect_uri: redirectUri,
                    resource: endpoint,
                }),
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                },
                method: "POST",
            });
            assert.equal(tokenResponse.status, 200);
            const tokens = (await tokenResponse.json()) as {
                access_token?: string;
                refresh_token?: string;
            };
            assert.equal(typeof tokens.access_token, "string");
            assert.equal(typeof tokens.refresh_token, "string");

            const login = await fetch(endpoint, {
                body: JSON.stringify(modernRpcRequest("login", "server/discover")),
                headers: {
                    ...modernRpcHeaders("server/discover"),
                    authorization: `Bearer ${tokens.access_token}`,
                },
                method: "POST",
            });
            assert.equal(login.status, 200);
            assert.equal(login.headers.get("mcp-session-id"), null);

            terminal.write("\u0004");
            await running;
        } finally {
            await runtime.stop();
        }
    });

    async function openOAuthPage(
        runtime: TuiRuntime,
        terminal: ReturnType<typeof createTerminal>,
    ): Promise<void> {
        terminal.write("3");
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "connections",
        );
        await enterMainBoxes(runtime);
        await focusWithDownArrow(
            runtime,
            (focus) =>
                focus.kind === "box" &&
                focus.id === "connections:oauth:default",
        );
        terminal.write("\r");
        await waitUntil(() => {
            const route = currentTuiRoute(runtime.store.getState());
            return route.page === "connections" && route.view === "oauth";
        });
    }

    async function approvePendingWithKeyboard(
        runtime: TuiRuntime,
        terminal: ReturnType<typeof createTerminal>,
        approvals: McpOAuthApprovalService,
        kind: "authorization" | "registration",
    ): Promise<void> {
        await waitUntil(
            () =>
                runtime.reader.mcp.approvals.some(
                    (approval) =>
                        approval.kind === kind &&
                        approval.status === "pending",
                ),
            15_000,
        );
        const pending = runtime.reader.mcp.approvals.find(
            (approval) =>
                approval.kind === kind && approval.status === "pending",
        );
        assert.ok(pending);
        const boxId = `oauth-approval-${pending.approvalId}`;

        await enterMainBoxes(runtime);
        await focusWithDownArrow(
            runtime,
            (focus) => focus.kind === "box" && focus.id === boxId,
        );
        terminal.write(" ");
        await waitUntil(
            () =>
                selectMainScreenModel(
                    runtime.store.getState(),
                    runtime.reader,
                ).boxes.find((box) => box.id === boxId)?.expanded === true,
        );
        await focusWithDownArrow(
            runtime,
            (focus) =>
                focus.kind === "line" &&
                focus.id.endsWith(`oauth.approve:${pending.approvalId}`),
        );
        terminal.write("\r");
        await waitUntil(
            () => runtime.store.getState().interaction.focusScope === "confirm",
        );
        terminal.write("\u001B[C");
        await waitUntil(() => {
            const overlay = topTuiOverlay(
                runtime.store.getState().interaction.overlays,
            );
            return (
                overlay?.kind === "confirmation" &&
                overlay.selectedAction === "confirm"
            );
        });
        terminal.write("\r");

        await waitUntil(async () => {
            const current = (await approvals.list()).find(
                (approval) => approval.approvalId === pending.approvalId,
            );
            return current?.status === "approved";
        }).catch(async (error: unknown) => {
            const current = (await approvals.list()).find(
                (approval) => approval.approvalId === pending.approvalId,
            );
            throw new Error(
                `TUI ${kind} approval ${pending.approvalId} not completed: ${JSON.stringify({
                    status: current?.status,
                    overlay: topTuiOverlay(runtime.store.getState().interaction.overlays),
                    focus: runtime.store.getState().interaction.focusScope,
                })}`,
                { cause: error },
            );
        });
        // The persisted approval can be visible before Ink dismisses its
        // confirmation modal. A subsequent keyboard approval must not enter
        // while that modal still owns the focus.
        await waitUntil(() =>
            runtime.store.getState().interaction.focusScope !== "confirm",
        );
    }

    async function enterMainBoxes(runtime: TuiRuntime): Promise<void> {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            if (
                runtime.store.getState().interaction.focusScope === "mainBoxes"
            ) {
                return;
            }
            await runtime.handleInput("", { tab: true });
        }
        assert.equal(
            runtime.store.getState().interaction.focusScope,
            "mainBoxes",
        );
    }

    async function focusWithDownArrow(
        runtime: TuiRuntime,
        predicate: (
            focus: NonNullable<
                ReturnType<TuiRuntime["focusManager"]["currentFocus"]>
            >,
        ) => boolean,
    ): Promise<void> {
        for (let attempt = 0; attempt < 40; attempt += 1) {
            const focus = runtime.focusManager.currentFocus();
            if (focus !== undefined && predicate(focus)) {
                return;
            }
            await runtime.handleInput("", { downArrow: true });
        }
        assert.fail(
            `TUI focus did not reach the requested item; current=${JSON.stringify(runtime.focusManager.currentFocus())}`,
        );
    }

    function createTerminal(): {
        output: string;
        stdin: ReadStream;
        stdout: WriteStream;
        write(value: string): void;
    } {
        class Input extends PassThrough {
            readonly isTTY = true;

            ref(): this {
                return this;
            }

            setRawMode(): this {
                return this;
            }

            unref(): this {
                return this;
            }
        }

        class Output extends PassThrough {
            readonly columns = 120;
            readonly isTTY = true;
            readonly rows = 40;
        }

        const input = new Input();
        const output = new Output();
        let captured = "";
        output.on("data", (chunk) => {
            captured += chunk.toString();
        });
        return {
            get output() {
                return captured;
            },
            stdin: input as unknown as ReadStream,
            stdout: output as unknown as WriteStream,
            write(value: string) {
                input.write(value);
            },
        };
    }

    async function emptySubscription(stream: MessageStream): Promise<void> {
        await stream.send({ name: "seed", payload: { events: [] } });
    }

    function mergeCookieHeader(existing: string, response: Response): string {
        const cookies = new Map<string, string>();
        for (const entry of existing.split(/;\s*/u).filter(Boolean)) {
            const [name, value] = entry.split("=", 2);
            if (name !== undefined && value !== undefined)
                cookies.set(name, value);
        }
        const headers = response.headers as Headers & {
            getSetCookie?: () => string[];
        };
        const entries =
            typeof headers.getSetCookie === "function"
                ? headers.getSetCookie()
                : [response.headers.get("set-cookie")].filter(
                      (value): value is string => value !== null,
                  );
        for (const header of entries) {
            const [pair] = header.split(";", 1);
            const [name, value] = pair.split("=", 2);
            if (name !== undefined && value !== undefined)
                cookies.set(name, value);
        }
        return [...cookies.entries()]
            .map(([name, value]) => `${name}=${value}`)
            .join("; ");
    }

    async function authorizeThroughTuiKeyboard(
        runtime: TuiRuntime,
        terminal: ReturnType<typeof createTerminal>,
        approvals: McpOAuthApprovalService,
        initialUrl: string,
        redirectUri: string,
    ): Promise<string> {
        let currentUrl = initialUrl;
        let cookieHeader = "";
        let method: "GET" | "POST" = "GET";
        let approvalKind: "authorization" | "registration" = "registration";
        for (let step = 0; step < 20; step += 1) {
            const response: Response = await fetch(currentUrl, {
                body:
                    method === "POST"
                        ? new URLSearchParams({ submit: "1" }).toString()
                        : undefined,
                headers: {
                    ...(cookieHeader.length === 0
                        ? {}
                        : { cookie: cookieHeader }),
                    ...(method === "POST"
                        ? {
                              "content-type":
                                  "application/x-www-form-urlencoded",
                          }
                        : {}),
                },
                method,
                redirect: "manual",
            });
            cookieHeader = mergeCookieHeader(cookieHeader, response);

            if (response.status === 200) {
                const html = await response.text();
                assert.match(html, /interaction-form/u);
                if (html.includes("window.location.reload()")) {
                    await approvePendingWithKeyboard(
                        runtime, terminal, approvals, "registration",
                    );
                    approvalKind = "authorization";
                    method = "GET";
                    continue;
                }
                if (html.includes("Waiting for administrator approval.")) {
                    await approvePendingWithKeyboard(
                        runtime,
                        terminal,
                        approvals,
                        approvalKind,
                    );
                }
                method = "POST";
                continue;
            }

            if (response.status === 409) {
                await approvePendingWithKeyboard(
                    runtime,
                    terminal,
                    approvals,
                    approvalKind,
                );
                method = "POST";
                continue;
            }

            assert.equal(
                response.status === 302 || response.status === 303,
                true,
                `unexpected OAuth status ${response.status}: ${await response.text()}`,
            );
            const location = response.headers.get("location");
            assert.notEqual(location, null);
            const nextUrl = new URL(location!, currentUrl);
            if (`${nextUrl.origin}${nextUrl.pathname}` === redirectUri) {
                const code = nextUrl.searchParams.get("code");
                assert.notEqual(code, null, nextUrl.href);
                return code!;
            }
            currentUrl = nextUrl.href;
            method = "GET";
        }
        throw new Error(
            "OAuth authorization did not reach the client callback.",
        );
    }

    async function waitUntil(
        predicate: () => boolean | Promise<boolean>,
        timeoutMs = 10_000,
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!(await predicate())) {
            if (Date.now() >= deadline) {
                throw new Error(
                    "Timed out waiting for OAuth acceptance state.",
                );
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    }
}
