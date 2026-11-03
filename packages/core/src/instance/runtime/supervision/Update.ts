import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import type { WorkerHandshakeResult, WorkerProtocolRange } from "../../Api.js";
import { assertNegotiatedWorkerProtocolVersion } from "../../transport/packet/Client.js";
import type { WorkerTunnel } from "../execution/capability/tunnel/Tunnel.js";
import { WorkerAssetResolver } from "../provision/Asset.js";
import {
    getWorkerTargetByKey,
    supportedWorkerTargetKeys,
    type WorkerTargetKey,
} from "../provision/Target.js";

const assets = new WorkerAssetResolver();

export interface ReverseWorkerUpdateTarget {
    version: string;
    sha256: string;
}

export function canContinueWithWorkerVersion(
    handshake: WorkerHandshakeResult,
    protocolRange: WorkerProtocolRange,
): boolean {
    assertNegotiatedWorkerProtocolVersion(handshake.protocolVersion, protocolRange);
    // Compatibility belongs to the negotiated protocol, independently of the
    // product version used to select an optional binary update.
    return true;
}

export async function updateReverseWorker(
    tunnel: WorkerTunnel,
    instance: string,
    handshake: WorkerHandshakeResult,
    options: {
        generation: number;
        signal?: AbortSignal;
        isCurrent(): boolean;
        beforeRestart(target: ReverseWorkerUpdateTarget): void;
    },
): Promise<ReverseWorkerUpdateTarget | undefined> {
    const signal = options.signal === undefined
        ? AbortSignal.timeout(120_000)
        : AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]);
    const assertCurrent = () => {
        signal.throwIfAborted();
        if (!options.isCurrent()) throw new Error("Reverse Worker update connection was superseded.");
    };
    const desiredVersion = assets.publishedVersion();
    if (desiredVersion === undefined || !isNewerWorkerVersion(handshake.workerVersion, desiredVersion))
        return undefined;
    const os = handshake.platform.os === "macos" ? "darwin" : handshake.platform.os;
    if (os !== "darwin" && os !== "linux")
        throw new Error(`Reverse Worker updates are unsupported on ${os}.`);
    const arch = handshake.platform.arch === "aarch64"
        ? "arm64"
        : handshake.platform.arch === "x86_64"
          ? "x64"
          : handshake.platform.arch;
    const key = `${os}-${arch}`;
    if (!supportedWorkerTargetKeys.includes(key as WorkerTargetKey))
        throw new Error(`Reverse Worker updates are unsupported for ${key}.`);
    const { asset, version } = await assets.resolvePublished(getWorkerTargetByKey(key as WorkerTargetKey));
    assertCurrent();
    if (version !== desiredVersion) throw new Error("Published Worker version changed during update.");

    const size = (await stat(asset.binaryPath)).size;
    if (!Number.isSafeInteger(size) || size <= 0 || size > 128 * 1024 * 1024)
        throw new Error("Published Worker asset size is invalid.");
    const target = { version, sha256: asset.sha256 };
    const script = unixUpdateScript(instance, key, asset.sha256, size, options.generation);
    assertCurrent();
    const stream = await tunnel.execProcess({ executable: "/bin/sh", args: ["-c", script] }, signal);
    try {
        for await (const bytes of createReadStream(asset.binaryPath)) {
            assertCurrent();
            await stream.write(bytes);
        }
        assertCurrent();
        // EOF lets the script launch the helper. A lost reply after this point
        // cannot safely be treated as an optional, unstarted update.
        options.beforeRestart(target);
        await stream.finish();
        const response: Buffer[] = [];
        for (let bytes = await stream.read(); bytes !== undefined; bytes = await stream.read())
            response.push(Buffer.from(bytes));
        if (Buffer.concat(response).toString("utf8").trim() !== "staged")
            throw new Error("Reverse Worker did not confirm the staged update.");
        await stream.close();
    } catch (error) {
        await stream.cancel({ message: "Worker update transfer failed." }).catch(() => undefined);
        throw error;
    }
    return target;
}

function unixUpdateScript(instance: string, target: string, sha: string, size: number, generation: number): string {
    const quotedInstance = `'${instance.replaceAll("'", "'\\''")}'`;
    return [
        "set -eu",
        // process.exec spawns this shell directly from the old daemon.
        'expected_pid="$(ps -o ppid= -p "$$" | tr -d "[:space:]")"',
        `dir="\${PORTABLE_DEVSHELL_HOME:-$HOME/.devshell}/workers/${target}/${sha}"`,
        'mkdir -p "$dir"',
        'chmod 700 "$dir"',
        'stage="$dir/.devshell-worker.$$.tmp"',
        "trap 'rm -f \"$stage\"' EXIT",
        'cat > "$stage"',
        `test "$(wc -c < "$stage" | tr -d '[:space:]')" = "${size}"`,
        'if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$stage" | cut -d " " -f 1); else actual=$(openssl dgst -sha256 -r "$stage" | cut -d " " -f 1); fi',
        `test "$actual" = "${sha}"`,
        'chmod 700 "$stage"',
        'mv -f "$stage" "$dir/devshell-worker"',
        "trap - EXIT",
        `nohup sh -c 'unset DEVSHELL_WORKER_INTERNAL_INSTANCE DEVSHELL_WORKER_INTERNAL_SECURITY_MODE DEVSHELL_WORKER_INTERNAL_WORKSPACE; sleep 2; exec "$1" _upgrade-restart --instance "$2" --expected-pid "$3" --expected-generation "$4"' sh "$dir/devshell-worker" ${quotedInstance} "$expected_pid" "${generation}" </dev/null >/dev/null 2>&1 &`,
        'echo staged',
    ].join("\n");
}

export function isNewerWorkerVersion(current: string, desired: string): boolean {
    const parse = (value: string) => {
        const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
        if (match === null) return undefined;
        return { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split(".") };
    };
    const old = parse(current);
    const next = parse(desired);
    if (old === undefined || next === undefined) return false;
    for (let i = 0; i < 3; i++) {
        if (old.numbers[i]! < next.numbers[i]!) return true;
        if (old.numbers[i]! > next.numbers[i]!) return false;
    }
    if (old.pre === undefined) return false;
    if (next.pre === undefined) return true;
    for (let i = 0; i < Math.max(old.pre.length, next.pre.length); i++) {
        const a = old.pre[i];
        const b = next.pre[i];
        if (a === undefined) return b !== undefined;
        if (b === undefined) return false;
        if (a === b) continue;
        const an = /^\d+$/u.test(a);
        const bn = /^\d+$/u.test(b);
        if (an && bn) return Number(a) < Number(b);
        if (an !== bn) return an;
        return a < b;
    }
    return false;
}
