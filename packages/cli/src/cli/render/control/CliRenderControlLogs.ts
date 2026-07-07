export function renderControlLogs(logs: string): string {
    return logs.endsWith("\n") || logs.length === 0 ? logs : `${logs}\n`;
}
