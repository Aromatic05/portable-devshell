import { type FormEvent, useState } from "react";

export function Login({
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

    return <main className="session">
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
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
            <button disabled={submitting || token.length === 0} type="submit">
                {submitting ? "Signing in…" : "Sign in"}
            </button>
        </form>
    </main>;
}
