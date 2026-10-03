export function formatBytes(
    value: number | undefined,
    unavailable = "Unavailable",
): string {
    if (value === undefined || !Number.isFinite(value) || value < 0)
        return unavailable;
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const unit = Math.min(
        Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)),
        units.length - 1,
    );
    const amount = value / 1024 ** unit;
    const digits = amount >= 100 || unit === 0 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(digits).replace(/\.0+$/u, "")} ${units[unit]}`;
}

export function formatDuration(
    seconds: number | undefined,
    unavailable = "Unavailable",
): string {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
        return unavailable;
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86_400)
        return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
    return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
}

export function formatPercent(
    value: number | undefined,
    unavailable = "Unavailable",
): string {
    if (value === undefined || !Number.isFinite(value) || value < 0)
        return unavailable;
    return `${value % 1 === 0 ? value : value.toFixed(1)}%`;
}