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
        if (event.key !== "Tab") return;
        const controls = [cancelRef.current, confirmRef.current].filter(
            (control): control is HTMLButtonElement => control !== null,
        );
        if (controls.length === 0) {
            event.preventDefault();
            dialogRef.current?.focus();
            return;
        }
        const first = controls[0]!;
        const last = controls[controls.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
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
