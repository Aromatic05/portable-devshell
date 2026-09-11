import { useEffect, useState } from "react";

import type { WebState, WebStore } from "../state/WebStore.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";

export function ContextIntervention({
    disabled = false,
    ctxId,
    instance,
    state,
    store,
}: {
    disabled?: boolean;
    ctxId: string;
    instance: string;
    state: WebState;
    store: WebStore;
}) {
    const [disableConfirmation, setDisableConfirmation] = useState(false);
    const context = state.readModel.contexts.find((record) => record.ctxId === ctxId);
    const environment = context === undefined
        ? undefined
        : (context.environments ?? [{
              instance: context.instance,
              temporaryDirectory: context.temporaryDirectory,
              workspace: context.workspace,
          }]).find((candidate) => candidate.instance === instance);
    const interactive = state.connection === "online" && !disabled;
    const renewOperation = `context-renew:${ctxId}`;
    const disableOperation = `context-disable:${ctxId}`;

    useEffect(() => {
        setDisableConfirmation(false);
    }, [ctxId, instance]);

    return <section className="card context-intervention" aria-labelledby="context-intervention-title">
        <div className="context-intervention-heading">
            <div>
                <h3 id="context-intervention-title">Context controls</h3>
                <p className="hint">{instance} · {ctxId}</p>
            </div>
            {context === undefined || context.status === "disabled" ? null : <div className="actions">
                <button
                    disabled={!interactive || state.operations[renewOperation] !== undefined}
                    onClick={() => void store.renewContext(ctxId)}
                    type="button"
                >{state.operations[renewOperation] !== undefined ? "Renewing…" : "Renew Context"}</button>
                <button
                    className="danger"
                    disabled={!interactive}
                    onClick={() => setDisableConfirmation(true)}
                    type="button"
                >Disable Context</button>
            </div>}
        </div>
        {context === undefined ? <p className="hint">Context registry record unavailable.</p> : <p className="hint">
            Workspace: {environment?.workspace ?? context.workspace ?? "not attached"} · Status: {context.status} · expires {context.expiresAt}
        </p>}
        {disableConfirmation ? <ConfirmationDialog
            actionLabel="Disable"
            busy={state.operations[disableOperation] !== undefined}
            description={`Disable Context ${ctxId}${environment?.workspace === undefined ? "" : ` from workspace ${environment.workspace}`} across all attached instances? This cannot be renewed; the client must establish a new Context.`}
            disabled={!interactive}
            onCancel={() => setDisableConfirmation(false)}
            onConfirm={() => {
                const request = store.disableContext(ctxId);
                void request.finally(() => setDisableConfirmation(false));
            }}
        /> : null}
    </section>;
}
