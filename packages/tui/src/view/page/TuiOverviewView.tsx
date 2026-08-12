import { Box, Text } from "ink";
import stringWidth from "string-width";

import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import type {
    TuiOverviewActivityRowModel,
    TuiOverviewInstanceRowModel,
    TuiOverviewMeterModel,
    TuiOverviewPresentation,
    TuiOverviewTone,
} from "./TuiOverviewModel.js";
import {
    selectTuiOverviewInstanceViewport,
    selectTuiOverviewPresentation,
} from "./TuiOverviewPresentation.js";

interface TuiOverviewViewProps {
    readonly state: TuiAppState;
    readonly viewportRows: number;
    readonly width: number;
}

type InkColor = "blue" | "cyan" | "gray" | "green" | "red" | "yellow";

export function TuiOverviewView(props: TuiOverviewViewProps) {
    const model = selectTuiOverviewPresentation(props.state);
    if (!model.available) {
        return (
            <Box flexDirection="column">
                <Text bold>Operational Overview</Text>
                <Text color="yellow">Operational metrics are unavailable.</Text>
                <Text dimColor>{model.controller.summary}</Text>
            </Box>
        );
    }

    const instanceViewport = selectTuiOverviewInstanceViewport(
        props.state,
        props.viewportRows,
    );
    const offset = instanceViewport.offset;
    const visibleInstances = instanceViewport.rows;
    const fixedRows = 4 + model.meters.length + 2 + visibleInstances.length;
    const alertCapacity =
        model.alerts.length === 0
            ? 0
            : Math.min(3, Math.max(1, props.viewportRows - fixedRows - 3));
    const activityCapacity = Math.max(
        0,
        props.viewportRows -
            fixedRows -
            (alertCapacity === 0 ? 0 : alertCapacity + 1) -
            1,
    );

    return (
        <Box flexDirection="column">
            <OverviewHeader model={model} width={props.width} />
            {model.meters.map((meter) => (
                <MeterLine
                    key={meter.label}
                    meter={meter}
                    width={props.width}
                />
            ))}
            <SectionTitle
                suffix={
                    model.query.length === 0
                        ? `${model.instances.length}`
                        : `${model.instances.length} · filter ${model.query}`
                }
                title="INSTANCES"
                width={props.width}
            />
            <Text dimColor>{instanceHeader(props.width)}</Text>
            {visibleInstances.length === 0 ? (
                <Text dimColor>No matching instances.</Text>
            ) : (
                visibleInstances.map((row) => (
                    <InstanceLine key={row.id} row={row} width={props.width} />
                ))
            )}
            {model.instances.length > visibleInstances.length ? (
                <Text
                    dimColor
                >{`rows ${offset + 1}-${offset + visibleInstances.length} of ${model.instances.length}`}</Text>
            ) : undefined}
            {alertCapacity > 0 ? (
                <>
                    <SectionTitle
                        suffix={`${model.alerts.length}`}
                        title="ALERTS"
                        width={props.width}
                    />
                    {model.alerts.slice(0, alertCapacity).map((alert) => (
                        <Text color={toneColor(alert.tone)} key={alert.id}>
                            {fit(
                                `${alert.instance === undefined ? "control" : alert.instance}  ${alert.title}  ${alert.detail}`,
                                props.width,
                            )}
                        </Text>
                    ))}
                </>
            ) : undefined}
            <SectionTitle
                suffix={`${model.activity.length}`}
                title="RECENT ACTIVITY"
                width={props.width}
            />
            {model.activity.length === 0 ? (
                <Text dimColor>No recent tool activity.</Text>
            ) : (
                model.activity.slice(0, activityCapacity).map((activity) => (
                    <Text
                        color={toneColor(activity.tone)}
                        key={activity.callId}
                    >
                        {activityLine(activity, props.width)}
                    </Text>
                ))
            )}
        </Box>
    );
}

function OverviewHeader(props: {
    model: TuiOverviewPresentation;
    width: number;
}) {
    const generated =
        props.model.generatedAt === undefined
            ? "—"
            : formatClock(props.model.generatedAt);
    const pid =
        props.model.controller.pid === undefined
            ? "—"
            : String(props.model.controller.pid);
    return (
        <>
            <Text bold>
                <Text color={healthColor(props.model.health)}>
                    {props.model.health.toUpperCase()}
                </Text>
                {fit(
                    `  controller pid ${pid}  uptime ${props.model.controller.uptime}  sampled ${generated}`,
                    Math.max(0, props.width - props.model.health.length),
                )}
            </Text>
            <Text>{fit(props.model.controller.summary, props.width)}</Text>
        </>
    );
}

function MeterLine(props: { meter: TuiOverviewMeterModel; width: number }) {
    const barWidth = clamp(Math.floor(props.width * 0.28), 10, 28);
    const label = pad(props.meter.label, 7);
    const value = padLeft(props.meter.value, 6);
    const detailWidth = Math.max(
        0,
        props.width - label.length - barWidth - value.length - 4,
    );
    return (
        <Text color={toneColor(props.meter.tone)}>
            {`${label} [${meterBar(props.meter.percent, barWidth)}] ${value} ${fit(props.meter.detail, detailWidth)}`}
        </Text>
    );
}

function SectionTitle(props: { suffix: string; title: string; width: number }) {
    const prefix = `${props.title} ${props.suffix} `;
    return (
        <Text bold color="cyan">
            {prefix +
                "─".repeat(Math.max(0, props.width - stringWidth(prefix)))}
        </Text>
    );
}

function InstanceLine(props: {
    row: TuiOverviewInstanceRowModel;
    width: number;
}) {
    return (
        <Text
            backgroundColor={props.row.focused ? "blue" : undefined}
            color={toneColor(props.row.tone)}
        >
            {instanceLine(props.row, props.width)}
        </Text>
    );
}

function instanceHeader(width: number): string {
    if (width >= 108) {
        return joinColumns([
            ["NAME", 22],
            ["PROVIDER", 9],
            ["RUNTIME", 10],
            ["CONNECTION", 12],
            ["DAEMON", 10],
            ["MCP", 4],
            ["TODO", 5],
            ["APPR", 5],
            ["DETAIL", remainingWidth(width, [22, 9, 10, 12, 10, 4, 5, 5])],
        ]);
    }
    if (width >= 78) {
        return joinColumns([
            ["NAME", 20],
            ["PROVIDER", 9],
            ["RUNTIME", 10],
            ["CONNECTION", 12],
            ["TODO", 5],
            ["APPR", 5],
        ]);
    }
    return joinColumns([
        ["NAME", 20],
        ["RUNTIME", 10],
        ["CONNECTION", 12],
        ["T", 3],
        ["A", 3],
    ]);
}

function instanceLine(row: TuiOverviewInstanceRowModel, width: number): string {
    if (width >= 108) {
        return joinColumns([
            [row.name, 22],
            [row.provider, 9],
            [row.runtime, 10],
            [row.connection, 12],
            [row.daemon, 10],
            [row.mcpEnabled ? "on" : "off", 4],
            [String(row.todos), 5],
            [String(row.approvals), 5],
            [
                row.lastError ?? "",
                remainingWidth(width, [22, 9, 10, 12, 10, 4, 5, 5]),
            ],
        ]);
    }
    if (width >= 78) {
        return joinColumns([
            [row.name, 20],
            [row.provider, 9],
            [row.runtime, 10],
            [row.connection, 12],
            [String(row.todos), 5],
            [String(row.approvals), 5],
        ]);
    }
    return joinColumns([
        [row.name, 20],
        [row.runtime, 10],
        [row.connection, 12],
        [String(row.todos), 3],
        [String(row.approvals), 3],
    ]);
}

function activityLine(
    activity: TuiOverviewActivityRowModel,
    width: number,
): string {
    const time = formatClock(activity.startedAt);
    if (width >= 90) {
        return joinColumns([
            [time, 9],
            [activity.instance, 22],
            [activity.toolName, 18],
            [activity.status, 12],
            [activity.duration, 9],
            [activity.callId, remainingWidth(width, [9, 22, 18, 12, 9])],
        ]);
    }
    return joinColumns([
        [time, 9],
        [activity.instance, 18],
        [activity.toolName, 16],
        [activity.status, 11],
        [activity.duration, 8],
    ]);
}

function meterBar(percent: number | undefined, width: number): string {
    if (percent === undefined) return "·".repeat(width);
    const filled = clamp(
        Math.round((width * clamp(percent, 0, 100)) / 100),
        0,
        width,
    );
    return "█".repeat(filled) + "░".repeat(width - filled);
}

function joinColumns(
    columns: ReadonlyArray<readonly [string, number]>,
): string {
    return columns
        .filter(([, width]) => width > 0)
        .map(([value, width]) => pad(fit(value, width), width))
        .join(" ")
        .trimEnd();
}

function remainingWidth(total: number, fixed: readonly number[]): number {
    return Math.max(
        0,
        total - fixed.reduce((sum, value) => sum + value, 0) - fixed.length,
    );
}

function fit(value: string, width: number): string {
    if (width <= 0) return "";
    if (stringWidth(value) <= width) return value;
    if (width === 1) return "…";
    let result = "";
    for (const character of value) {
        if (stringWidth(result + character) > width - 1) break;
        result += character;
    }
    return `${result}…`;
}

function pad(value: string, width: number): string {
    return value + " ".repeat(Math.max(0, width - stringWidth(value)));
}

function padLeft(value: string, width: number): string {
    return " ".repeat(Math.max(0, width - stringWidth(value))) + value;
}

function formatClock(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--:--:--Z";
    return `${date.toISOString().slice(11, 19)}Z`;
}

function healthColor(health: TuiOverviewPresentation["health"]): InkColor {
    switch (health) {
        case "healthy":
            return "green";
        case "attention":
            return "yellow";
        case "critical":
            return "red";
        case "unavailable":
            return "gray";
    }
}

function toneColor(tone: TuiOverviewTone): InkColor | undefined {
    switch (tone) {
        case "danger":
            return "red";
        case "warning":
            return "yellow";
        case "accent":
            return "cyan";
        case "success":
            return "green";
        case "muted":
            return "gray";
        case "normal":
            return undefined;
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
