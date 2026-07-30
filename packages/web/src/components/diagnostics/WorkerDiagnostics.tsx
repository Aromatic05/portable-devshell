import type { OperationalOverviewWorker } from "../../../../shared/src/dto/overview/DtoOperationalOverview.js";

import { presentWorker } from "../../selectors/workerPresentation.js";

export function WorkerSummary({ worker }: { worker: OperationalOverviewWorker | undefined }) {
    const presentation = presentWorker(worker);
    return presentation === undefined ? <span>Worker: not connected / unavailable</span> : <span>Worker {presentation.version} · protocol {presentation.protocol} · {presentation.platform}</span>;
}

export function WorkerDiagnostics({ worker }: { worker: OperationalOverviewWorker | undefined }) {
    const presentation = presentWorker(worker);
    if (presentation === undefined) {
        return <section className="worker-diagnostics"><h4>Worker diagnostics</h4><p className="empty">Worker handshake is not connected / unavailable.</p></section>;
    }
    return <section className="worker-diagnostics"><h4>Worker diagnostics</h4><dl className="diagnostic-list"><Diagnostic label="Version" value={presentation.version} /><Diagnostic label="Protocol" value={presentation.protocol} /><Diagnostic label="OS / architecture" value={presentation.platform} /><Diagnostic label="Distribution" value={presentation.distribution} /><Diagnostic label="Package manager" value={presentation.packageManager} /><Diagnostic label="Shell" value={presentation.shell} />{presentation.capabilities.map((capability) => <Diagnostic key={capability.label} label={capability.label} value={capability.value} />)}</dl></section>;
}

function Diagnostic({ label, value }: { label: string; value: string }) {
    return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
