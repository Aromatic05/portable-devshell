export function formatBytes(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value) || value < 0) {
        return "Unavailable";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)), units.length - 1);
    const amount = value / 1024 ** index;
    return `${amount % 1 === 0 ? amount : amount.toFixed(1)} ${units[index]}`;
}

export function formatPercent(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value) || value < 0) {
        return "Unavailable";
    }
    return `${value % 1 === 0 ? value : value.toFixed(1)}%`;
}

export function formatDuration(seconds: number | undefined): string {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
        return "Unavailable";
    }
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
