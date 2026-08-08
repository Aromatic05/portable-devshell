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
    const cancelRef = useRef<HTMLButtonElement>(null);
    const confirmRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLElement>(null);
    const destructive = actionLabel === "Deny" || actionLabel === "Disable" || actionLabel === "Stop";
    const progressLabel = actionProgressLabel(actionLabel);

    useEffect(() => {
        const previous = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : undefined;
        (destructive ? cancelRef.current : confirmRef.current)?.focus();
        return () => previous?.focus();
    }, [destructive]);

    useEffect(() => {
        if (busy) dialogRef.current?.focus();
    }, [busy]);

    function keyDown(event: React.KeyboardEvent<HTMLElement>): void {
        if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
            return;
        }
        if (event.key !== "Tab") return;
        const controls = [cancelRef.current, confirmRef.current]
            .filter((control): control is HTMLButtonElement =>
                control !== null && !control.disabled
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
            onMouseDown={() => { if (!busy) onCancel(); }}
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
                <h2 id="confirmation-title">Confirm {actionLabel.toLowerCase()}</h2>
                <p>{description}</p>
                <div className="actions">
                    <button disabled={busy} onClick={onCancel} ref={cancelRef}>Cancel</button>
                    <button
                        className={destructive ? "danger" : "primary"}
                        disabled={busy}
                        onClick={onConfirm}
                        ref={confirmRef}
                    >
                        {busy ? progressLabel : actionLabel}
                    </button>
                </div>
            </section>
        </div>
    );
}

function actionProgressLabel(actionLabel: string): string {
    if (actionLabel === "Stop") return "Stopping…";
    if (actionLabel.endsWith("e")) return `${actionLabel.slice(0, -1)}ing…`;
    return `${actionLabel}ing…`;
}
