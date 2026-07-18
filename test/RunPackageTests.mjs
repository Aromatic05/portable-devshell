import { globSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const options = parseArguments(process.argv.slice(2));
const cwd = process.cwd();
const files = [];
const seenFiles = new Set();
for (const pattern of options.patterns) {
    for (const file of globSync(pattern, { cwd }).sort()) {
        if (seenFiles.has(file)) continue;
        seenFiles.add(file);
        files.push(file);
    }
}

if (files.length === 0) {
    throw new Error(`no test files matched: ${options.patterns.join(", ")}`);
}

const args = [
    "--import",
    "tsx",
    "--import",
    pathToFileURL(resolve(cwd, options.loader)).href,
    "--test",
    ...(options.concurrency === undefined ? [] : [`--test-concurrency=${options.concurrency}`]),
    ...files
];
const result = spawnSync(process.execPath, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    windowsHide: true
});

if (result.error !== undefined) {
    throw result.error;
}
process.exit(result.status ?? 1);

function parseArguments(args) {
    let concurrency;
    let loader;
    const patterns = [];
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--loader") {
            loader = requireValue(args, ++index, argument);
            continue;
        }
        if (argument === "--concurrency") {
            const value = Number.parseInt(requireValue(args, ++index, argument), 10);
            if (!Number.isSafeInteger(value) || value < 1) {
                throw new Error("--concurrency must be a positive integer");
            }
            concurrency = value;
            continue;
        }
        if (argument.startsWith("--")) {
            throw new Error(`unsupported option: ${argument}`);
        }
        patterns.push(argument);
    }
    if (loader === undefined) {
        throw new Error("--loader is required");
    }
    if (patterns.length === 0) {
        throw new Error("at least one test file pattern is required");
    }
    return { concurrency, loader, patterns };
}

function requireValue(args, index, option) {
    const value = args[index];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${option} requires a value`);
    }
    return value;
}
