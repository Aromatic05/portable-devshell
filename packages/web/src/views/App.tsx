import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
    ApprovalRequest,
    OAuthApprovalRequest,
} from "@portable-devshell/shared/browser";

import { createWebClients, type WebClients } from "../client/WebClients.js";
import { BrowserWebSession, type WebSession } from "../session/WebSession.js";
import { WebStore } from "../state/WebStore.js";

type Page = "overview" | "instances" | "approvals" | "activity";
type SessionState = "checking" | "login" | "ready";

const navigation: Array<[Page, string]> = [
    ["overview", "Overview"],
    ["instances", "Instances"],
    ["approvals", "Approvals"],
    ["activity", "Activity"],
];

export interface AppProps {
    createClients?(): WebClients;
    session?: WebSession;
}

export function App({
    createClients = createWebClients,
    session,
}: AppProps) {
    const activeSession = useMemo(
        () => session ?? new BrowserWebSession(),
        [session],
    );
    const [sessionState, setSessionState] = useState<SessionState>("checking");
    const [store, setStore] = useState<WebStore>();
    const storeRef = useRef<WebStore>();
    const [error, setError] = useState<string>();

    useEffect(() => {
        let disposed = false;
        void bootstrap();
        return () => {
            disposed = true;
            storeRef.current?.close();
        };

        async function bootstrap(): Promise<void> {
            try {
                const available =
                    (await activeSession.check()) ||
                    (await activeSession.establish());
                if (disposed) {
                    return;
                }
                if (!available) {
                    setSessionState("login");
                    return;
                }
                const nextStore = new WebStore(createClients());
                storeRef.current = nextStore;
                setStore(nextStore);
                setSessionState("ready");
                void nextStore.load();
            } catch {
                if (!disposed) {
                    setError("Unable to establish a session.");
                    setSessionState("login");
                }
            }
        }
    }, [activeSession, createClients]);

    async function login(token: string): Promise<void> {
        try {
            if (!(await activeSession.establish(token))) {
                setError("Sign-in was not accepted.");
                return;
            }
            const nextStore = new WebStore(createClients());
            storeRef.current = nextStore;
            setError(undefined);
            setStore(nextStore);
            setSessionState("ready");
            void nextStore.load();
        } catch {
            setError("Unable to establish a session.");
        }
    }

    async function logout(): Promise<void> {
        try {
            await activeSession.logout();
            storeRef.current?.close();
            storeRef.current = undefined;
            setStore(undefined);
            setError(undefined);
            setSessionState("login");
        } catch (logoutError) {
            setError(
                logoutError instanceof Error
                    ? logoutError.message
                    : "Unable to log out.",
            );
        }
    }

    if (sessionState === "checking") {
        return (
            <main className="session">
                <p>Checking session…</p>
            </main>
        );
    }
    if (sessionState === "login" || store === undefined) {
        return <Login error={error} onLogin={login} />;
    }
    return <Application store={store} onLogout={logout} />;
}

function Login({
    error,
    onLogin,
}: {
    error?: string;
    onLogin(token: string): Promise<void>;
}) {
    const [token, setToken] = useState("");
    const [submitting, setSubmitting] = useState(false);

    async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        setSubmitting(true);
        await onLogin(token);
        setToken("");
        setSubmitting(false);
    }

    return (
        <main className="session">
            <form onSubmit={(event) => void submit(event)}>
                <h1>portable-devshell</h1>
                <label>
                    Access token
                    <input
                        autoComplete="off"
                        onChange={(event) => setToken(event.target.value)}
                        type="password"
                        value={token}
                    />
                </label>
                {error !== undefined && <p className="error">{error}</p>}
                <button
                    disabled={submitting || token.length === 0}
                    type="submit"
                >
                    Sign in
                </button>
            </form>
        </main>
    );
}

function Application({
    store,
    onLogout,
}: {
    store: WebStore;
    onLogout(): Promise<void>;
}) {
    const [state, setState] = useState(store.state);
    const [page, setPage] = useState<Page>("overview");
    const [selected, setSelected] = useState<string>();

    useEffect(() => store.subscribe(() => setState(store.state)), [store]);

    const pending =
        Object.values(state.approvals)
            .flat()
            .filter((approval) => approval.status === "pending").length +
        state.oauthApprovals.filter((approval) => approval.status === "pending")
            .length;
    return (
        <div className="app">
            <aside>
                <h1>portable-devshell</h1>
                <Nav page={page} pending={pending} setPage={setPage} />
            </aside>
            <main>
                <header className={`connection ${state.connection}`}>
                    <span>{connectionLabel(state.connection)}</span>
                    {state.connection !== "online" && (
                        <button onClick={() => void store.reconnect()}>
                            Reconnect
                        </button>
                    )}
                    <button onClick={() => void onLogout()}>Log out</button>
                </header>
                {state.error !== undefined && (
                    <p className="error">{state.error}</p>
                )}
                {page === "overview" && (
                    <Overview state={state} pending={pending} />
                )}
                {page === "instances" && (
                    <Instances
                        selected={selected}
                        setSelected={setSelected}
                        state={state}
                        store={store}
                    />
                )}
                {page === "approvals" && (
                    <Approvals state={state} store={store} />
                )}
                {page === "activity" && <Activity state={state} />}
            </main>
            <nav className="bottom">
                <Nav page={page} pending={pending} setPage={setPage} />
            </nav>
        </div>
    );
}

function connectionLabel(connection: WebStore["state"]["connection"]): string {
    if (connection === "online") return "Online";
    if (connection === "connecting") return "Connecting…";
    return "Offline";
}

function Nav({
    page,
    pending,
    setPage,
}: {
    page: Page;
    pending: number;
    setPage(page: Page): void;
}) {
    return (
        <>
            {navigation.map(([id, label]) => (
                <button
                    className={page === id ? "selected" : ""}
                    key={id}
                    onClick={() => setPage(id)}
                >
                    {label}
                    {id === "approvals" && pending > 0 ? ` (${pending})` : ""}
                </button>
            ))}
        </>
    );
}

function Overview({
    pending,
    state,
}: {
    pending: number;
    state: WebStore["state"];
}) {
    const warnings = state.instances.filter(
        (item) =>
            item.snapshot.status === "failed" ||
            item.snapshot.status === "stale",
    );
    return (
        <section>
            <h2>Overview</h2>
            <div className="metrics">
                <Metric
                    label="Service"
                    value={state.service?.ok ? "Ready" : "Unavailable"}
                />
                <Metric
                    label="Instances"
                    value={String(
                        state.service?.instanceCount ?? state.instances.length,
                    )}
                />
                <Metric label="Pending approvals" value={String(pending)} />
            </div>
            <h3>Warnings</h3>
            {warnings.length === 0 ? (
                <p className="empty">No current warnings.</p>
            ) : (
                <ul>
                    {warnings.map(({ name, snapshot }) => (
                        <li key={name}>
                            {name}:{" "}
                            {snapshot.lastErrorMessage ?? snapshot.status}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="card">
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

function Instances({
    selected,
    setSelected,
    state,
    store,
}: {
    selected?: string;
    setSelected(value?: string): void;
    state: WebStore["state"];
    store: WebStore;
}) {
    const entry = state.instances.find(({ name }) => name === selected);
    return (
        <section>
            <h2>Instances</h2>
            {state.instances.length === 0 ? (
                <p className="empty">No instances are available.</p>
            ) : (
                <div className="instances">
                    {state.instances.map((item) => (
                        <button
                            className="instance card"
                            key={item.name}
                            onClick={() => {
                                setSelected(item.name);
                                void store.refreshInstance(item.name);
                            }}
                        >
                            <strong>{item.name}</strong>
                            <span>
                                {item.snapshot.status} ·{" "}
                                {item.snapshot.connectionState}
                            </span>
                        </button>
                    ))}
                </div>
            )}
            {entry !== undefined && (
                <article className="detail">
                    <button
                        className="back"
                        onClick={() => setSelected(undefined)}
                    >
                        Back to instances
                    </button>
                    <h3>{entry.name}</h3>
                    <p>
                        Runtime: {entry.snapshot.status}; daemon:{" "}
                        {entry.snapshot.daemonState}; sequence:{" "}
                        {entry.snapshot.lastSeq}
                    </p>
                    <div className="actions">
                        {entry.snapshot.status === "stopped" ? (
                            <button
                                onClick={() => void store.start(entry.name)}
                            >
                                Start
                            </button>
                        ) : (
                            <button
                                className="danger"
                                onClick={() => void store.stop(entry.name)}
                            >
                                Stop
                            </button>
                        )}
                    </div>
                    <h4>Recent logs</h4>
                    <pre>
                        {(state.logs[entry.name] ?? [])
                            .map((log) => `${log.at} ${log.message}`)
                            .join("\n") || "No recent logs."}
                    </pre>
                </article>
            )}
        </section>
    );
}

function Approvals({
    state,
    store,
}: {
    state: WebStore["state"];
    store: WebStore;
}) {
    const tools = Object.values(state.approvals).flatMap((approvals) =>
        approvals.filter((item) => item.status === "pending"),
    );
    const oauth = state.oauthApprovals.filter(
        (item) => item.status === "pending",
    );
    return (
        <section>
            <h2>Approvals</h2>
            {tools.length + oauth.length === 0 ? (
                <p className="empty">Nothing needs approval.</p>
            ) : (
                <div className="approval-list">
                    {tools.map((item) => (
                        <ToolApproval
                            decide={(decision) =>
                                store.decideTool(
                                    item.instance,
                                    item.approvalId,
                                    decision,
                                )
                            }
                            item={item}
                            key={item.approvalId}
                        />
                    ))}
                    {oauth.map((item) => (
                        <OAuthApproval
                            decide={(decision) =>
                                store.decideOAuth(item.approvalId, decision)
                            }
                            item={item}
                            key={item.approvalId}
                        />
                    ))}
                </div>
            )}
        </section>
    );
}

function ToolApproval({
    decide,
    item,
}: {
    decide(decision: "approve" | "deny"): Promise<void>;
    item: ApprovalRequest;
}) {
    return (
        <article className="card">
            <h3>{item.toolName}</h3>
            <p>
                {item.instance} · {item.reason}
            </p>
            <details>
                <summary>Open details</summary>
                <p>
                    Risk: {item.riskLevel}; expires: {item.expiresAt}
                </p>
                <p>{item.inputSummary}</p>
            </details>
            <Decision decide={decide} />
        </article>
    );
}

function OAuthApproval({
    decide,
    item,
}: {
    decide(decision: "approve" | "deny"): Promise<void>;
    item: OAuthApprovalRequest;
}) {
    return (
        <article className="card">
            <h3>OAuth {item.kind}</h3>
            <p>
                {item.clientName} ·{" "}
                {item.requestedScopes.join(", ") || "no scopes"}
            </p>
            <details>
                <summary>Open details</summary>
                <p>Redirects: {item.redirectUris.join(", ") || "none"}</p>
                <p>Resources: {item.requestedResources.join(", ") || "none"}</p>
            </details>
            <Decision decide={decide} />
        </article>
    );
}

function Decision({
    decide,
}: {
    decide(decision: "approve" | "deny"): Promise<void>;
}) {
    function act(decision: "approve" | "deny"): void {
        if (
            window.confirm(
                `${decision === "approve" ? "Approve" : "Deny"} this request?`,
            )
        ) {
            void decide(decision);
        }
    }
    return (
        <div className="actions">
            <button onClick={() => act("approve")}>Approve</button>
            <button className="danger" onClick={() => act("deny")}>
                Deny
            </button>
        </div>
    );
}

function Activity({ state }: { state: WebStore["state"] }) {
    return (
        <section>
            <h2>Activity</h2>
            {state.activity.length === 0 ? (
                <p className="empty">No recent activity.</p>
            ) : (
                <ol className="feed">
                    {[...state.activity].reverse().map((event) => (
                        <li key={`${event.instanceName}-${event.seq}`}>
                            <time>{event.at}</time>
                            <strong>{event.instanceName}</strong> {event.type}
                        </li>
                    ))}
                </ol>
            )}
        </section>
    );
}
