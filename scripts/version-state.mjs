import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = fileURLToPath(new URL("../", import.meta.url));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(value) {
    const match = versionPattern.exec(value);
    if (match === null) {
        throw new Error(`version must use x.y.z without a prefix or prerelease suffix: ${value}`);
    }
    return match.slice(1).map(Number);
}

export function compareVersions(left, right) {
    const leftParts = parseVersion(left);
    const rightParts = parseVersion(right);
    for (let index = 0; index < leftParts.length; index += 1) {
        const difference = leftParts[index] - rightParts[index];
        if (difference !== 0) return Math.sign(difference);
    }
    return 0;
}

export function nextPatchVersion(version) {
    const [major, minor, patch] = parseVersion(version);
    return `${major}.${minor}.${patch + 1}`;
}

export async function readProjectVersions(root = defaultRepoRoot) {
    const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    const cargoToml = await readFile(resolve(root, "crates/devshell-worker/Cargo.toml"), "utf8");
    const cargoLock = await readFile(resolve(root, "Cargo.lock"), "utf8");
    return {
        app: requireVersion(packageJson.version, "package.json"),
        workerManifest: readCargoPackageVersion(cargoToml, "Cargo.toml"),
        workerLock: readCargoLockVersion(cargoLock)
    };
}

export async function setProjectVersion(version, root = defaultRepoRoot) {
    parseVersion(version);
    const packagePath = resolve(root, "package.json");
    const cargoTomlPath = resolve(root, "crates/devshell-worker/Cargo.toml");
    const cargoLockPath = resolve(root, "Cargo.lock");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    const cargoToml = await readFile(cargoTomlPath, "utf8");
    const cargoLock = await readFile(cargoLockPath, "utf8");

    packageJson.version = version;
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 4)}\n`, "utf8");
    await writeFile(cargoTomlPath, replaceCargoPackageVersion(cargoToml, version), "utf8");
    await writeFile(cargoLockPath, replaceCargoLockVersion(cargoLock, version), "utf8");
}

export async function checkDevelopmentVersion(root = defaultRepoRoot) {
    const current = await requireSynchronizedVersions(root);
    const latestRelease = readLatestReleaseVersion(root);
    if (latestRelease !== undefined && compareVersions(current, latestRelease) <= 0) {
        throw new Error(
            `development version ${current} must be greater than latest release v${latestRelease}; bump immediately after publishing`
        );
    }
    return { current, latestRelease };
}

export async function checkReleaseVersion(tag, root = defaultRepoRoot) {
    const current = await requireSynchronizedVersions(root);
    if (tag !== `v${current}`) {
        throw new Error(`release tag ${tag} does not match synchronized project version ${current}`);
    }
    return current;
}

export async function advanceAfterRelease(tag, root = defaultRepoRoot) {
    if (!tag.startsWith("v")) throw new Error(`release tag must start with v: ${tag}`);
    const released = tag.slice(1);
    parseVersion(released);
    const current = await requireSynchronizedVersions(root);
    const comparison = compareVersions(current, released);
    if (comparison < 0) {
        throw new Error(`default branch version ${current} is behind released version ${released}`);
    }
    if (comparison > 0) {
        return { changed: false, version: current };
    }
    const next = nextPatchVersion(released);
    await setProjectVersion(next, root);
    return { changed: true, version: next };
}

async function requireSynchronizedVersions(root) {
    const versions = await readProjectVersions(root);
    const unique = new Set(Object.values(versions));
    if (unique.size !== 1) {
        throw new Error(
            `project versions are inconsistent: app=${versions.app}, workerManifest=${versions.workerManifest}, workerLock=${versions.workerLock}`
        );
    }
    return versions.app;
}

function readLatestReleaseVersion(root) {
    let output;
    try {
        output = execFileSync("git", ["tag", "--list", "v[0-9]*"], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"]
        });
    } catch (error) {
        throw new Error(`unable to read release tags: ${error instanceof Error ? error.message : String(error)}`);
    }
    const versions = output
        .split(/\r?\n/u)
        .filter((tag) => /^v\d+\.\d+\.\d+$/u.test(tag))
        .map((tag) => tag.slice(1))
        .sort(compareVersions);
    return versions.at(-1);
}

function requireVersion(value, source) {
    if (typeof value !== "string") throw new Error(`${source} version is missing`);
    parseVersion(value);
    return value;
}

function readCargoPackageVersion(content, source) {
    const packageBlock = /\[package\][\s\S]*?(?=\n\[|$)/u.exec(content)?.[0];
    const version = packageBlock === undefined ? undefined : /^version = "([^"]+)"$/mu.exec(packageBlock)?.[1];
    if (version === undefined) throw new Error(`${source} package version is missing`);
    return requireVersion(version, source);
}

function readCargoLockVersion(content) {
    const version = /\[\[package\]\]\nname = "devshell-worker"\nversion = "([^"]+)"/u.exec(content)?.[1];
    if (version === undefined) throw new Error("Cargo.lock devshell-worker version is missing");
    return requireVersion(version, "Cargo.lock");
}

function replaceCargoPackageVersion(content, version) {
    const packageBlockPattern = /\[package\][\s\S]*?(?=\n\[|$)/u;
    const packageBlock = packageBlockPattern.exec(content)?.[0];
    if (packageBlock === undefined || !/^version = "[^"]+"$/mu.test(packageBlock)) {
        throw new Error("Cargo.toml package version is missing");
    }
    return content.replace(packageBlockPattern, packageBlock.replace(/^version = "[^"]+"$/mu, `version = "${version}"`));
}

function replaceCargoLockVersion(content, version) {
    const pattern = /(\[\[package\]\]\nname = "devshell-worker"\nversion = ")[^"]+("\n)/u;
    if (!pattern.test(content)) throw new Error("Cargo.lock devshell-worker version is missing");
    return content.replace(pattern, `$1${version}$2`);
}

async function main(args) {
    const { commandArgs, root } = readRootOption(args);
    const [command, value] = commandArgs;
    switch (command) {
        case "set":
            if (value === undefined) throw new Error("usage: version-state.mjs set <x.y.z>");
            await setProjectVersion(value, root);
            process.stdout.write(`${value}\n`);
            return;
        case "check-development": {
            const result = await checkDevelopmentVersion(root);
            process.stdout.write(
                `development version ${result.current} is newer than ${result.latestRelease === undefined ? "no release" : `v${result.latestRelease}`}\n`
            );
            return;
        }
        case "check-release":
            if (value === undefined) throw new Error("usage: version-state.mjs check-release <vX.Y.Z>");
            process.stdout.write(`${await checkReleaseVersion(value, root)}\n`);
            return;
        case "advance-after-release": {
            if (value === undefined) throw new Error("usage: version-state.mjs advance-after-release <vX.Y.Z>");
            const result = await advanceAfterRelease(value, root);
            process.stdout.write(`${result.changed ? "advanced" : "already advanced"} ${result.version}\n`);
            return;
        }
        default:
            throw new Error(
                "usage: version-state.mjs <set|check-development|check-release|advance-after-release> [value] [--root path]"
            );
    }
}

function readRootOption(args) {
    const rootIndex = args.indexOf("--root");
    if (rootIndex === -1) return { commandArgs: args, root: defaultRepoRoot };
    const rootValue = args[rootIndex + 1];
    if (rootValue === undefined) throw new Error("--root requires a path");
    return {
        commandArgs: args.filter((_value, index) => index !== rootIndex && index !== rootIndex + 1),
        root: resolve(rootValue)
    };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(scriptPath)) {
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
