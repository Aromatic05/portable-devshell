export interface CliRenderedControlStatus {
    instanceCount: number;
    pid?: number;
    running: boolean;
}

export function renderControlStatus(status: CliRenderedControlStatus): string {
    if (!status.running) {
        return "control: stopped\n";
    }

    const lines = ["control: running"];

    if (status.pid !== undefined) {
        lines.push(`pid: ${status.pid}`);
    }

    lines.push(`instances: ${status.instanceCount}`);
    return `${lines.join("\n")}\n`;
}
