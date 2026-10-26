import { useEffect, useRef } from "react";

export function ConfirmationDialog({
    actionLabel,
    busyLabel,
    busy,
    description,
    disabled = false,
    error,
    onCancel,
    onConfirm,
    variant = "default",
}: {
    actionLabel: string;
    busyLabel?: string;
    busy: boolean;
    description: string;
    disabled?: boolean;
    error?: string;
    onCancel(): void;
    onConfirm(): void;
    variant?: "default" | "destructive";
}) {
    const cancelRef = useRef<HTMLButtonElement>(null);
    const confirmRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLElement>(null);
    const destructive = variant === "destructive";
    const progressLabel = actionProgressLabel(actionLabel);

    useEffect(() => {
        const previous =
            document.activeElement instanceof HTMLElement
                ? document.activeElement
                : undefined;
        (destructive ? cancelRef.current : confirmRef.current)?.focus();
        return () => previous?.focus();
    }, [destructive]);

    function keyDown(event: React.KeyboardEvent<HTMLElement>): void {
        if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
            return;
        }
        trapDialogTab(event);
    }

    return (
        <div
            className="dialog-backdrop"
            onMouseDown={() => {
                if (!busy) onCancel();
            }}
            role="presentation"
        >
            <section
                aria-busy={busy}
                aria-labelledby="confirmation-title"
                aria-modal="true"
                className="dialog"
                onKeyDown={keyDown}
                onMouseDown={(event) => event.stopPropagation()}
                ref={dialogRef}
                role="dialog"
                tabIndex={-1}
            >
                <h2 id="confirmation-title">
                    Confirm {actionLabel.toLowerCase()}
                </h2>
                <p>{description}</p>
                {error === undefined ? null : (
                    <p className="error" role="alert">
                        {error}
                    </p>
                )}
                <div className="actions">
                    <button
                        aria-disabled={busy || undefined}
                        onClick={() => {
                            if (busy) return;
                            onCancel();
                        }}
                        ref={cancelRef}
                    >
                        Cancel
                    </button>
                    <button
                        aria-busy={busy || undefined}
                        aria-disabled={busy || disabled || undefined}
                        className={destructive ? "danger" : "primary"}
                        onClick={() => {
                            if (busy || disabled) return;
                            onConfirm();
                        }}
                        ref={confirmRef}
                    >
                        {busy ? (busyLabel ?? progressLabel) : actionLabel}
                    </button>
                </div>
            </section>
        </div>
    );
}

const progressLabels: Record<string, string> = {
    Approve: "Approving…",
    Delete: "Deleting…",
    Deny: "Denying…",
    Disable: "Disabling…",
    Enable: "Enabling…",
    Restart: "Restarting…",
    Revoke: "Revoking…",
    Rotate: "Rotating…",
    Stop: "Stopping…",
};

function actionProgressLabel(actionLabel: string): string {
    return progressLabels[actionLabel] ?? `${actionLabel}…`;
}

/** Keep keyboard focus in the active dialog, including when all controls are disabled. */
export function trapDialogTab(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
    )).filter((control) => !control.hidden);
    const first = controls[0];
    const last = controls.at(-1);
    if (first === undefined || last === undefined) {
        event.preventDefault();
        dialog.focus();
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault();
        first.focus();
    }
}
