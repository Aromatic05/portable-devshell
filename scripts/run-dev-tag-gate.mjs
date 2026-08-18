import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { runDevelopmentCi } from "./run-development-ci.mjs";

export function runDevTagGate(options = {}) {
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    if (platform !== "linux" || arch !== "x64") {
        throw new Error("dev tag push gate requires a Linux x64 host so it can reproduce Linux x64 development CI.");
    }

    if ((options.isWorktreeClean ?? isWorktreeClean)() !== true) {
        throw new Error("dev tag push gate requires a clean working tree.");
    }

    const ciOptions = { ...options };
    delete ciOptions.arch;
    delete ciOptions.isWorktreeClean;
    return runDevelopmentCi("linux-x64", {
        ...ciOptions,
        platform: "linux",
    });
}

export function writeDevTagGateProof(commitSha, proofDirectory) {
    validateCommitSha(commitSha);
    const path = resolve(proofDirectory, commitSha);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${commitSha}\n`, { encoding: "utf8", mode: 0o600 });
}

export function hasDevTagGateProof(commitSha, proofDirectory) {
    validateCommitSha(commitSha);
    const path = resolve(proofDirectory, commitSha);
    return existsSync(path) && readFileSync(path, "utf8").trim() === commitSha;
}

function gitOutput(args) {
    const result = spawnSync("git", args, { encoding: "utf8", shell: false });
    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
    }
    return result.stdout.trim();
}

function isWorktreeClean() {
    return gitOutput(["status", "--porcelain"]).length === 0;
}

function validateCommitSha(commitSha) {
    if (!/^[0-9a-f]{40}$/u.test(commitSha)) {
        throw new Error("dev tag gate proof requires a full 40-character commit SHA.");
    }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const [mode, commitSha] = process.argv.slice(2);
        const proofDirectory = gitOutput(["rev-parse", "--git-path", "portable-devshell/dev-tag-gate"]);
        if (mode === "--check") {
            if (commitSha === undefined || !hasDevTagGateProof(commitSha, proofDirectory)) {
                throw new Error(`dev tag push blocked: commit ${commitSha ?? "<missing>"} has not passed the local Linux x64 development gate. Run: node scripts/run-dev-tag-gate.mjs`);
            }
        } else if (mode !== undefined) {
            throw new Error("usage: run-dev-tag-gate.mjs [--check <commit-sha>]");
        } else {
            const initialCommit = gitOutput(["rev-parse", "HEAD"]);
            const repositoryRoot = gitOutput(["rev-parse", "--show-toplevel"]);
            const ciArtifacts = resolve(repositoryRoot, "ci-artifacts");
            const ciArtifactsExisted = existsSync(ciArtifacts);
            let result;
            try {
                result = runDevTagGate();
            } finally {
                if (!ciArtifactsExisted) {
                    rmSync(ciArtifacts, { force: true, recursive: true });
                }
            }
            if (!result.ok) {
                process.exitCode = 1;
            } else {
                const currentCommit = gitOutput(["rev-parse", "HEAD"]);
                if (currentCommit !== initialCommit || !isWorktreeClean()) {
                    throw new Error("dev tag gate passed, but HEAD or the working tree changed while it was running; proof was not recorded.");
                }
                writeDevTagGateProof(initialCommit, proofDirectory);
                console.log(`Recorded local dev tag gate proof for ${initialCommit}.`);
            }
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
