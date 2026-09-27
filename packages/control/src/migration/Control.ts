import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { WORKER_PROTOCOL_RANGE } from "@portable-devshell/core";
import { parseExtensionManifest } from "@portable-devshell/extension";
import { CONTROL_PROTOCOL_RANGE } from "@portable-devshell/shared";
import { FRAME_PROTOCOL_RANGE } from "@portable-devshell/shared/transport/frame";

import { ControlConfigStore } from "../control/config/storage/Store.js";
import { ExtensionHostModuleResolver } from "../control/extension/generation/discovery/ModuleResolver.js";
import { ExtensionPathLayout } from "../control/extension/state/Layout.js";
import { ExtensionRegistryStore } from "../control/extension/state/Store.js";

export interface ControlMigrationResult {
    changed: boolean;
    domains: readonly string[];
}

export interface ControlMigrationOptions {
    homeDirectory?: string;
}

export interface ControlUpdatePreflightOptions extends ControlMigrationOptions {
    currentApplicationDirectory?: string;
    environment?: NodeJS.ProcessEnv;
}

export interface ControlUpdateProtocolRange {
    readonly max: string;
    readonly min: string;
}

export interface ControlUpdateProtocolCompatibility {
    readonly candidate: ControlUpdateProtocolRange;
    readonly compatible: boolean;
    readonly current: ControlUpdateProtocolRange | null;
}

export type ControlUpdateRollbackBlocker = "persistentMigrationRequired";

export interface ControlUpdatePreflightResult {
    extensions: {
        checkedGenerations: number;
    };
    migration: {
        domains: readonly string[];
        required: boolean;
    };
    protocols: {
        control: ControlUpdateProtocolCompatibility;
        frame: ControlUpdateProtocolCompatibility;
        worker: ControlUpdateProtocolCompatibility;
    };
    rollback: {
        blockers: readonly ControlUpdateRollbackBlocker[];
        feasible: boolean;
    };
}

export async function migrateControlState(
    options: ControlMigrationOptions = {},
): Promise<ControlMigrationResult> {
    const config = await new ControlConfigStore().migrate(options.homeDirectory);
    return {
        changed: config.changed,
        domains: config.changed ? ["config"] : [],
    };
}

export async function preflightControlUpdate(
    options: ControlUpdatePreflightOptions = {},
): Promise<ControlUpdatePreflightResult> {
    const config = await new ControlConfigStore().inspectMigration(
        options.homeDirectory,
    );
    const protocols = await inspectProtocolCompatibility(
        options.currentApplicationDirectory,
    );
    const paths = new ExtensionPathLayout({
        environment: options.environment,
        homeDirectory: options.homeDirectory,
    });
    const registry = await new ExtensionRegistryStore(paths.registryFile).read();
    const resolver = new ExtensionHostModuleResolver(import.meta.url);
    let checkedGenerations = 0;
    try {
        for (const [id, entry] of Object.entries(registry.extensions)) {
            const generations = new Set(
                [entry.selectedGeneration, entry.lastKnownGoodGeneration].filter(
                    (value): value is string => value !== undefined,
                ),
            );
            for (const generation of generations) {
                const manifest = parseExtensionManifest(
                    JSON.parse(
                        await readFile(paths.manifestFile(id, generation), "utf8"),
                    ) as unknown,
                );
                if (manifest.id !== id) {
                    throw new Error(
                        `Extension generation ${generation} declares id ${manifest.id}, expected ${id}.`,
                    );
                }
                const lease = resolver.register(
                    paths.generationDirectory(id, generation),
                    manifest.hostDependencies,
                );
                lease.release();
                checkedGenerations += 1;
            }
        }
    } finally {
        resolver.dispose();
    }
    const rollbackBlockers: ControlUpdateRollbackBlocker[] = config.changed
        ? ["persistentMigrationRequired"]
        : [];
    return {
        extensions: { checkedGenerations },
        migration: {
            domains: config.changed ? ["config"] : [],
            required: config.changed,
        },
        protocols,
        rollback: {
            blockers: rollbackBlockers,
            feasible: rollbackBlockers.length === 0,
        },
    };
}

type ProtocolSurface = "control" | "frame" | "worker";

const candidateProtocolRanges = {
    control: CONTROL_PROTOCOL_RANGE,
    frame: FRAME_PROTOCOL_RANGE,
    worker: WORKER_PROTOCOL_RANGE,
} satisfies Record<ProtocolSurface, ControlUpdateProtocolRange>;

/**
 * @compat update-preflight-legacy-protocol-generations
 * @removeAt 0.7.10
 */
const legacyProtocolVersions: Record<ProtocolSurface, ReadonlyMap<number, string>> = {
    control: new Map([[1, "1.0.0"]]),
    frame: new Map([[1, "1.0.0"]]),
    worker: new Map([[7, "1.0.0"]]),
};

async function inspectProtocolCompatibility(
    currentApplicationDirectory: string | undefined,
): Promise<ControlUpdatePreflightResult["protocols"]> {
    const current =
        currentApplicationDirectory === undefined
            ? undefined
            : await readCurrentProtocolRanges(currentApplicationDirectory);
    return {
        control: protocolCompatibility(
            "control",
            candidateProtocolRanges.control,
            current?.control,
        ),
        frame: protocolCompatibility(
            "frame",
            candidateProtocolRanges.frame,
            current?.frame,
        ),
        worker: protocolCompatibility(
            "worker",
            candidateProtocolRanges.worker,
            current?.worker,
        ),
    };
}

function protocolCompatibility(
    surface: ProtocolSurface,
    candidate: ControlUpdateProtocolRange,
    current: ControlUpdateProtocolRange | undefined,
): ControlUpdateProtocolCompatibility {
    const normalizedCandidate = validateProtocolRange(candidate, `${surface} candidate`);
    if (current === undefined) {
        return {
            candidate: normalizedCandidate,
            compatible: true,
            current: null,
        };
    }
    const normalizedCurrent = validateProtocolRange(current, `${surface} current`);
    if (!protocolRangesOverlap(normalizedCandidate, normalizedCurrent)) {
        throw new Error(
            `Current ${surface} protocol range ${normalizedCurrent.min}..${normalizedCurrent.max} is incompatible with candidate range ${normalizedCandidate.min}..${normalizedCandidate.max}.`,
        );
    }
    return {
        candidate: normalizedCandidate,
        compatible: true,
        current: normalizedCurrent,
    };
}

async function readCurrentProtocolRanges(
    applicationDirectory: string,
): Promise<Record<ProtocolSurface, ControlUpdateProtocolRange>> {
    const shared = join(
        applicationDirectory,
        "node_modules",
        "@portable-devshell",
        "shared",
        "dist",
    );
    const core = join(
        applicationDirectory,
        "node_modules",
        "@portable-devshell",
        "core",
        "dist",
    );
    const [control, frame, worker] = await Promise.all([
        readProtocolModuleRange(
            "control",
            join(shared, "protocol", "control", "ControlProtocol.js"),
            "CONTROL_PROTOCOL_RANGE",
            "CONTROL_PROTOCOL_VERSION",
        ),
        readProtocolModuleRange(
            "frame",
            join(shared, "transport", "frame", "Codec.js"),
            "FRAME_PROTOCOL_RANGE",
            "FRAME_PROTOCOL_VERSION",
        ),
        readProtocolModuleRange(
            "worker",
            join(core, "worker", "protocol", "Client.js"),
            "WORKER_PROTOCOL_RANGE",
            "WORKER_PROTOCOL_VERSION",
        ),
    ]);
    return { control, frame, worker };
}

async function readProtocolModuleRange(
    surface: ProtocolSurface,
    modulePath: string,
    rangeExport: string,
    versionExport: string,
): Promise<ControlUpdateProtocolRange> {
    const exports = (await import(pathToFileURL(modulePath).href)) as Record<
        string,
        unknown
    >;
    const range = exports[rangeExport];
    if (range !== undefined) {
        return validateProtocolRangeValue(range, `${surface} current`);
    }
    const version = exports[versionExport];
    if (typeof version === "string") {
        parseProtocolVersion(version);
        return { max: version, min: version };
    }
    if (typeof version === "number") {
        const mapped = legacyProtocolVersions[surface].get(version);
        if (mapped !== undefined) return { max: mapped, min: mapped };
    }
    throw new Error(
        `Current ${surface} protocol contract does not expose a supported range.`,
    );
}

function validateProtocolRangeValue(
    value: unknown,
    label: string,
): ControlUpdateProtocolRange {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} protocol range must be an object.`);
    }
    const range = value as { max?: unknown; min?: unknown };
    if (typeof range.min !== "string" || typeof range.max !== "string") {
        throw new Error(`${label} protocol range requires string min and max.`);
    }
    return validateProtocolRange({ max: range.max, min: range.min }, label);
}

function validateProtocolRange(
    range: ControlUpdateProtocolRange,
    label: string,
): ControlUpdateProtocolRange {
    const minimum = parseProtocolVersion(range.min);
    const maximum = parseProtocolVersion(range.max);
    if (compareProtocolVersionParts(minimum, maximum) > 0) {
        throw new Error(`${label} protocol range min must not exceed max.`);
    }
    return { max: range.max, min: range.min };
}

function protocolRangesOverlap(
    left: ControlUpdateProtocolRange,
    right: ControlUpdateProtocolRange,
): boolean {
    return (
        compareProtocolVersions(left.min, right.max) <= 0 &&
        compareProtocolVersions(right.min, left.max) <= 0
    );
}

function compareProtocolVersions(left: string, right: string): number {
    return compareProtocolVersionParts(
        parseProtocolVersion(left),
        parseProtocolVersion(right),
    );
}

function compareProtocolVersionParts(
    left: readonly [number, number, number],
    right: readonly [number, number, number],
): number {
    for (let index = 0; index < left.length; index += 1) {
        const difference = left[index]! - right[index]!;
        if (difference !== 0) return difference;
    }
    return 0;
}

function parseProtocolVersion(value: string): readonly [number, number, number] {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
    if (match === null) throw new Error(`Invalid protocol version ${value}.`);
    const version = [
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
    ] as const;
    if (!version.every(Number.isSafeInteger)) {
        throw new Error(`Invalid protocol version ${value}.`);
    }
    return version;
}
