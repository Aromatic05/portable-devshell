import { useEffect, useRef, useState } from "react";

import type {
    WebPageAction,
    WebPageDescriptor,
    WebPageSnapshot,
} from "@portable-devshell/shared";

import { useWebDomains } from "../../app/domain/Context.js";
import { ConfirmationDialog } from "../component/Confirm.js";

interface PendingAction {
    action: WebPageAction;
    rowId: string;
}

export function ExtensionPage({
    descriptor,
}: {
    descriptor?: WebPageDescriptor;
}) {
    const domains = useWebDomains();
    const extension = domains.extension;
    const [snapshot, setSnapshot] = useState<WebPageSnapshot>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState<string>();
    const [pending, setPending] = useState<PendingAction>();

    const generation = useRef(0);

    useEffect(() => {
        generation.current += 1;
        setBusy(undefined);
        setPending(undefined);
        const pageId = descriptor?.id;
        if (pageId === undefined) return;
        let active = true;
        setSnapshot(undefined);
        setError(undefined);
        void extension.readWebPage(pageId).then(
            (value) => {
                if (active) setSnapshot(value);
            },
            (failure: unknown) => {
                if (active) setError(message(failure));
            },
        );
        return () => {
            active = false;
            generation.current += 1;
        };
    }, [descriptor?.id, extension]);

    if (descriptor === undefined) {
        return (
            <section className="extension-page">
                <h1>Extension page unavailable</h1>
            </section>
        );
    }

    async function invoke(action: WebPageAction, rowId: string): Promise<void> {
        const operation = `${rowId}:${action.id}`;
        setBusy(operation);
        setError(undefined);
        const requestGeneration = generation.current;
        try {
            const next = await extension.webAction(descriptor!.id, action.id, rowId);
            if (generation.current !== requestGeneration) return;
            setSnapshot(next);
            setPending(undefined);
        } catch (failure) {
            if (generation.current === requestGeneration) setError(message(failure));
        } finally {
            if (generation.current === requestGeneration) setBusy(undefined);
        }
    }

    return (
        <section className="extension-page">
            <h1>{descriptor.title}</h1>
            {error === undefined ? null : (
                <p className="error" role="alert">
                    {error}
                </p>
            )}
            {snapshot === undefined && error === undefined ? (
                <p className="hint">Loading…</p>
            ) : null}
            {snapshot?.tables.map((table) => {
                const hasActions = table.rows.some(
                    (row) => (row.actions?.length ?? 0) > 0,
                );
                return (
                    <section className="extension-table" key={table.id}>
                        {table.title === undefined ? null : <h2>{table.title}</h2>}
                        <div className="extension-table-scroll">
                            <table>
                                <thead>
                                    <tr>
                                        {table.columns.map((column) => (
                                            <th key={column.id}>{column.label}</th>
                                        ))}
                                        {hasActions ? <th>Actions</th> : null}
                                    </tr>
                                </thead>
                                <tbody>
                                    {table.rows.map((row) => (
                                        <tr key={row.id}>
                                            {table.columns.map((column) => {
                                                const cell = row.cells[column.id];
                                                return (
                                                    <td
                                                        className={
                                                            cell?.tone === undefined
                                                                ? undefined
                                                                : `tone-${cell.tone}`
                                                        }
                                                        key={column.id}
                                                    >
                                                        {cell === undefined ? (
                                                            "—"
                                                        ) : cell.href === undefined ? (
                                                            cell.text
                                                        ) : (
                                                            <a
                                                                href={cell.href}
                                                                rel="noreferrer"
                                                                target="_blank"
                                                            >
                                                                {cell.text}
                                                            </a>
                                                        )}
                                                    </td>
                                                );
                                            })}
                                            {hasActions ? (
                                                <td>
                                                    <div className="actions">
                                                        {(row.actions ?? []).map(
                                                            (action) => {
                                                                const operation = `${row.id}:${action.id}`;
                                                                return (
                                                                    <button
                                                                        className={
                                                                            action.tone ===
                                                                            "danger"
                                                                                ? "danger"
                                                                                : undefined
                                                                        }
                                                                        disabled={
                                                                            busy !== undefined
                                                                        }
                                                                        key={action.id}
                                                                        onClick={() => {
                                                                            if (
                                                                                action.tone ===
                                                                                "danger"
                                                                            )
                                                                                setPending({
                                                                                    action,
                                                                                    rowId: row.id,
                                                                                });
                                                                            else
                                                                                void invoke(
                                                                                    action,
                                                                                    row.id,
                                                                                );
                                                                        }}
                                                                    >
                                                                        {busy === operation
                                                                            ? `${action.label}…`
                                                                            : action.label}
                                                                    </button>
                                                                );
                                                            },
                                                        )}
                                                    </div>
                                                </td>
                                            ) : null}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                );
            })}
            {pending === undefined ? null : (
                <ConfirmationDialog
                    actionLabel={pending.action.label}
                    busy={busy !== undefined}
                    description={`${pending.action.label} ${pending.rowId}?`}
                    error={error}
                    onCancel={() => setPending(undefined)}
                    onConfirm={() => void invoke(pending.action, pending.rowId)}
                    variant="destructive"
                />
            )}
        </section>
    );
}

function message(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
}
