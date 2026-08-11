import { useEffect, useMemo, useRef, useState } from "react";

import type { McpContextRecord } from "@portable-devshell/shared/browser";

type InactivityPreset = "20" | "60" | "360" | "1440" | "custom";

export function ContextBatchDisableDialog({
    busy,
    contexts,
    disabled = false,
    onClose,
    onDisable,
}: {
    busy: boolean;
    contexts: readonly McpContextRecord[];
    disabled?: boolean;
    onClose(): void;
    onDisable(ctxIds: string[]): Promise<boolean>;
}) {
    const closeRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLElement>(null);
    const [preset, setPreset] = useState<InactivityPreset>("60");
    const [customMinutes, setCustomMinutes] = useState(90);
    const [selected, setSelected] = useState<Set<string>>(() => new Set());
    const [confirming, setConfirming] = useState(false);
    const [failure, setFailure] = useState<string>();
    const thresholdMinutes = preset === "custom" ? customMinutes : Number(preset);
    const candidates = useMemo(() => {
        const cutoff = Date.now() - thresholdMinutes * 60_000;
        return contexts
            .filter((context) =>
                context.status !== "disabled" &&
                Date.parse(context.lastAccessedAt) <= cutoff
            )
            .sort((left, right) => left.lastAccessedAt.localeCompare(right.lastAccessedAt));
    }, [contexts, thresholdMinutes]);
    const candidateIds = useMemo(
        () => new Set(candidates.map((context) => context.ctxId)),
        [candidates],
    );

    useEffect(() => {
        const previous = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : undefined;
        closeRef.current?.focus();
        return () => previous?.focus();
    }, []);

    useEffect(() => {
        setSelected((current) => {
            const next = new Set([...current].filter((ctxId) => candidateIds.has(ctxId)));
            if (next.size === current.size && [...next].every((ctxId) => current.has(ctxId))) {
                return current;
            }
            return next;
        });
    }, [candidateIds]);

    useEffect(() => {
        if (selected.size === 0) setConfirming(false);
    }, [selected.size]);

    useEffect(() => {
        if (busy) dialogRef.current?.focus();
    }, [busy]);

    function keyDown(event: React.KeyboardEvent<HTMLElement>): void {
        if (event.key !== "Escape" || busy) return;
        event.preventDefault();
        if (confirming) {
            setConfirming(false);
        } else {
            onClose();
        }
    }

    function toggle(ctxId: string): void {
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(ctxId)) next.delete(ctxId);
            else next.add(ctxId);
            return next;
        });
    }

    async function disableSelected(): Promise<void> {
        const ctxIds = candidates
            .map((context) => context.ctxId)
            .filter((ctxId) => selected.has(ctxId));
        if (ctxIds.length === 0) return;
        setFailure(undefined);
        const succeeded = await onDisable(ctxIds);
        setConfirming(false);
        if (succeeded) {
            setSelected(new Set());
        } else {
            setFailure("Some selected Contexts could not be disabled. Successful disables were kept; failed Contexts remain available to retry.");
        }
    }

    const allSelected = candidates.length > 0 && candidates.every((context) => selected.has(context.ctxId));
    const selectedCount = selected.size;

    return <div
        className="dialog-backdrop"
        onMouseDown={() => { if (!busy) onClose(); }}
        role="presentation"
    >
        <section
            aria-busy={busy}
            aria-labelledby="context-batch-title"
            aria-modal="true"
            className="dialog context-batch-dialog"
            onKeyDown={keyDown}
            onMouseDown={(event) => event.stopPropagation()}
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
        >
            <div className="context-batch-heading">
                <div>
                    <h2 id="context-batch-title">Disable inactive Contexts</h2>
                    <p className="hint">Only explicitly selected Contexts are disabled.</p>
                </div>
                <button disabled={busy} onClick={onClose} ref={closeRef} type="button">Close</button>
            </div>

            <div className="context-batch-controls">
                <label>
                    Inactive for
                    <select
                        disabled={busy || confirming}
                        onChange={(event) => setPreset(event.target.value as InactivityPreset)}
                        value={preset}
                    >
                        <option value="20">20 minutes</option>
                        <option value="60">1 hour</option>
                        <option value="360">6 hours</option>
                        <option value="1440">24 hours</option>
                        <option value="custom">Custom</option>
                    </select>
                </label>
                {preset === "custom" ? <label>
                    Custom inactivity minutes
                    <input
                        disabled={busy || confirming}
                        min={1}
                        onChange={(event) => setCustomMinutes(Math.max(1, Number(event.target.value) || 1))}
                        type="number"
                        value={customMinutes}
                    />
                </label> : null}
                <button
                    disabled={busy || confirming || candidates.length === 0}
                    onClick={() => setSelected(allSelected
                        ? new Set()
                        : new Set(candidates.map((context) => context.ctxId))
                    )}
                    type="button"
                >
                    {allSelected ? "Clear selection" : "Select all matching"}
                </button>
            </div>

            <p aria-live="polite" className="hint">
                {candidates.length} Context{candidates.length === 1 ? "" : "s"} unused for at least {formatThreshold(thresholdMinutes)}.
            </p>
            {failure === undefined ? null : <p className="error" role="alert">{failure}</p>}

            {candidates.length === 0 ? <p className="empty">No non-disabled Contexts match this inactivity threshold.</p> : <div className="context-batch-table-wrap">
                <table className="context-batch-table">
                    <thead>
                        <tr><th>Select</th><th>Context</th><th>Instance</th><th>Status</th><th>Last used</th></tr>
                    </thead>
                    <tbody>
                        {candidates.map((context) => <tr key={context.ctxId}>
                            <td><input
                                aria-label={`Select ${context.ctxId}`}
                                checked={selected.has(context.ctxId)}
                                disabled={busy || confirming}
                                onChange={() => toggle(context.ctxId)}
                                type="checkbox"
                            /></td>
                            <td><code>{context.ctxId}</code></td>
                            <td>{context.instance}</td>
                            <td><span className={`result ${context.status === "active" ? "success" : "pending"}`}>{context.status}</span></td>
                            <td><time dateTime={context.lastAccessedAt}>{context.lastAccessedAt}</time><small>{formatIdle(context.lastAccessedAt)}</small></td>
                        </tr>)}
                    </tbody>
                </table>
            </div>}

            {confirming ? <div className="context-batch-confirmation" aria-live="polite">
                <p>Disable {selectedCount} selected Context{selectedCount === 1 ? "" : "s"}? Disabled Contexts cannot be renewed.</p>
                <div className="actions">
                    <button disabled={busy} onClick={() => setConfirming(false)} type="button">Back</button>
                    <button
                        className="danger"
                        disabled={busy || selectedCount === 0 || disabled}
                        onClick={() => void disableSelected()}
                        type="button"
                    >
                        {busy
                            ? "Disabling…"
                            : `Disable ${selectedCount} Context${selectedCount === 1 ? "" : "s"}`}
                    </button>
                </div>
            </div> : <div className="actions">
                <button
                    className="danger"
                    disabled={busy || disabled || selectedCount === 0}
                    onClick={() => setConfirming(true)}
                    type="button"
                >
                    Review disable
                </button>
            </div>}
        </section>
    </div>;
}

function formatThreshold(minutes: number): string {
    if (minutes < 60) return `${minutes} minutes`;
    if (minutes % 1_440 === 0) return `${minutes / 1_440} day${minutes === 1_440 ? "" : "s"}`;
    if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
    return `${minutes} minutes`;
}

function formatIdle(lastAccessedAt: string): string {
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(lastAccessedAt)) / 60_000));
    if (minutes < 60) return `${minutes}m idle`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h idle`;
    return `${Math.floor(hours / 24)}d idle`;
}
