import { pathToFileURL } from "node:url";

import { resolvePreparedWorker, runCommand } from "./AcceptanceSupport.mjs";
import { runCiSteps } from "../scripts/run-development-ci.mjs";

export const functionalChains = Object.freeze([
    { id: "L07", name: "Artifact cross-worker lifecycle", file: "acceptance/run-artifact-chain-smoke.mjs", timeoutMs: 480_000 },
    { id: "L05", name: "Workspace wait and reentry recovery", file: "acceptance/run-workflow-chain-smoke.mjs", timeoutMs: 480_000 },
    { id: "L03", name: "Multi-client authoritative consistency", file: "acceptance/run-cross-client-chain-smoke.mjs", timeoutMs: 480_000 },
    { id: "L01-L04", name: "Provider and reverse worker lifecycle", file: "acceptance/run-provider-chain-smoke.mjs", timeoutMs: 480_000 },
]);

export function selectFunctionalChains(args) {
    if (args.length === 0 || (args.length === 1 && args[0] === "--all"))
        return functionalChains;
    if (args.length === 2 && args[0] === "--only") {
        const selected = functionalChains.find((chain) => chain.id === args[1]);
        if (selected) return [selected];
    }
    throw new Error("Unknown chain selection: " + args.join(" ") + ". Use --all, --only one of " + functionalChains.map((chain) => chain.id).join(", ") + ", or --list.");
}

export function runFunctionalChains(chains, options = {}) {
    if (chains.length === 0)
        throw new Error("No functional chains selected; empty validation is not a passing result.");
    const execute = options.execute ?? ((chain) => {
        runCommand(process.execPath, [chain.file], {
            env: options.env ?? process.env,
            inherit: true,
            timeoutMs: chain.timeoutMs,
        });
        return { status: 0 };
    });
    const result = runCiSteps(chains.map((chain) => ({
        name: chain.id + ": " + chain.name,
        chain,
    })), {
        execute: (step) => execute(step.chain),
        log: options.log,
    });
    return {
        ok: result.ok,
        completed: chains.length,
        failures: result.failures,
        testedChains: chains.map(({ id }) => id),
    };
}

if (process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (process.argv.includes("--list")) {
        if (process.argv.length !== 3 || process.argv[2] !== "--list")
            throw new Error("--list must be the only argument.");
        for (const chain of functionalChains)
            process.stdout.write([chain.id, chain.name, chain.file].join("\t") + "\n");
    } else {
        resolvePreparedWorker();
        const result = runFunctionalChains(selectFunctionalChains(process.argv.slice(2)));
        process.stdout.write("FUNCTIONAL_CHAIN_MATRIX " + JSON.stringify(result) + "\n");
        if (!result.ok) process.exitCode = 1;
    }
}
