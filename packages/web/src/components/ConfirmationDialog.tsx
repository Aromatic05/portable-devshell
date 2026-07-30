import { useEffect, useRef } from "react";

export function ConfirmationDialog({
    actionLabel,
    busy,
    description,
    onCancel,
    onConfirm,
}: {
    actionLabel: string;
    busy: boolean;
    description: string;
    onCancel(): void;
    onConfirm(): void;
}) {
    const confirmRef = useRef<HTMLButtonElement>(null);
    useEffect(() => confirmRef.current?.focus(), []);
    return (
        <div className="dialog-backdrop" onMouseDown={onCancel} role="presentation">
            <section aria-labelledby="confirmation-title" aria-modal="true" className="dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
                <h2 id="confirmation-title">Confirm {actionLabel.toLowerCase()}</h2>
                <p>{description}</p>
                <div className="actions">
                    <button disabled={busy} onClick={onCancel}>Cancel</button>
                    <button autoFocus className={actionLabel === "Deny" || actionLabel === "Stop" ? "danger" : "primary"} disabled={busy} onClick={onConfirm} ref={confirmRef}>
                        {busy ? `${actionLabel}ing…` : actionLabel}
                    </button>
                </div>
            </section>
        </div>
    );
}
