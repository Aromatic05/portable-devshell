import { formatBytes, formatDuration, formatPercent } from "@portable-devshell/shared";

export const formatOverviewDuration = (seconds: number): string => formatDuration(seconds, "—");
export const formatOverviewPercent = (value: number | undefined): string => formatPercent(value, "—");
export const formatOverviewBytes = (bytes: number): string => formatBytes(bytes, "0 B");
