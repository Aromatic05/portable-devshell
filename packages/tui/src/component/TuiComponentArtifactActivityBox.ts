import {
    isArtifactTransferTerminal,
    type ArtifactShareResult,
    type ArtifactTransferRecord
} from "@portable-devshell/shared";

export interface TuiComponentArtifactActivityDetailLine {
    disabled?: boolean;
    id: string;
    text: string;
    tone?: "accent" | "danger" | "muted" | "normal" | "success" | "warning";
}

export interface TuiComponentArtifactActivityView {
    detailLines: Array<string | TuiComponentArtifactActivityDetailLine>;
    summary: string;
}

export function buildArtifactActivityView(
    instance: string,
    shares: readonly ArtifactShareResult[],
    transfers: readonly ArtifactTransferRecord[],
    nowMs: number = Date.now()
): TuiComponentArtifactActivityView {
    const instanceShares = shares.filter((share) => share.source.instance === instance).slice(0, 3);
    const instanceTransfers = transfers
        .filter((transfer) => transfer.source.instance === instance || transfer.target.instance === instance)
        .slice(0, 5);
    const activeShares = instanceShares.filter((share) => share.state === "active").length;
    const activeTransfers = instanceTransfers.filter((transfer) => !isArtifactTransferTerminal(transfer.status)).length;
    const detailLines: Array<string | TuiComponentArtifactActivityDetailLine> = ["Artifact activity"];

    if (instanceShares.length === 0 && instanceTransfers.length === 0) {
        detailLines.push("No active or recent artifact activity.");
    }

    for (const share of instanceShares) {
        const remainingSeconds = Math.max(0, Math.ceil((share.expiresAtMs - nowMs) / 1000));
        detailLines.push(
            `share ${shortId(share.shareId)}  ${share.downloadName}  ${share.state}  expires=${formatDuration(remainingSeconds)}`
        );
        if (share.state === "active") {
            detailLines.push({
                id: `button:artifact-revoke:${share.shareId}`,
                text: `[ Revoke share ${shortId(share.shareId)} ]`,
                tone: "warning"
            });
        }
    }

    for (const transfer of instanceTransfers) {
        const total = transfer.totalBytes;
        const progress =
            total === undefined
                ? formatBytes(transfer.transferredBytes)
                : `${formatBytes(transfer.transferredBytes)} / ${formatBytes(total)}`;
        detailLines.push(
            `transfer ${shortId(transfer.transferId)}  ${transfer.source.instance} -> ${transfer.target.instance}:${transfer.target.path}  ${transfer.status}  ${progress}`
        );
        if (!isArtifactTransferTerminal(transfer.status) && transfer.status !== "cancelling") {
            detailLines.push({
                id: `button:artifact-cancel:${transfer.transferId}`,
                text: `[ Cancel transfer ${shortId(transfer.transferId)} ]`,
                tone: "warning"
            });
        }
    }

    return {
        detailLines,
        summary: `artifacts shares=${instanceShares.length} transfers=${instanceTransfers.length} active=${activeShares + activeTransfers}`
    };
}

function shortId(value: string): string {
    return value.length <= 8 ? value : value.slice(0, 8);
}

function formatDuration(seconds: number): string {
    if (seconds < 60) {
        return `${seconds}s`;
    }
    if (seconds < 3600) {
        return `${Math.ceil(seconds / 60)}m`;
    }
    return `${Math.ceil(seconds / 3600)}h`;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
