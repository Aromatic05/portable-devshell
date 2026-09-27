import { type FormEvent, useState } from "react";

export function Login({
    error,
    onLogin,
}: {
    error?: string;
    onLogin(token: string): Promise<boolean>;
}) {
    const [token, setToken] = useState("");
    const [showToken, setShowToken] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        setSubmitting(true);
        try {
            if (await onLogin(token)) setToken("");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <main className="session">
            <form onSubmit={(event) => void submit(event)}>
                <h1>portable-devshell</h1>
                <p className="hint">
                    Enter the access token configured for the Web UI in TUI →
                    Connections → Connector.
                </p>
                <label htmlFor="access-token">Access token</label>
                <span className="token-field">
                    <input
                        autoComplete="current-password"
                        id="access-token"
                        onChange={(event) => setToken(event.target.value)}
                        type={showToken ? "text" : "password"}
                        value={token}
                    />
                    <button
                        aria-label={
                            showToken
                                ? "Hide access token"
                                : "Show access token"
                        }
                        aria-pressed={showToken}
                        className="token-toggle"
                        onClick={() => setShowToken((value) => !value)}
                        type="button"
                    >
                        {showToken ? "Hide" : "Show"}
                    </button>
                </span>
                {error === undefined ? null : (
                    <p className="error" role="alert">
                        {error}
                    </p>
                )}
                <button
                    disabled={submitting || token.length === 0}
                    type="submit"
                >
                    {submitting ? "Signing in…" : "Sign in"}
                </button>
            </form>
        </main>
    );
}
