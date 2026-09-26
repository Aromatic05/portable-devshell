import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareVersions, parseVersion } from "./version-state.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceExtensions = new Set([
    ".cjs",
    ".cts",
    ".js",
    ".mjs",
    ".mts",
    ".ps1",
    ".rs",
    ".sh",
    ".ts",
    ".tsx",
]);

export class CompatibilityExpiryError extends Error {
    constructor(message, issues) {
        super(message);
        this.name = "CompatibilityExpiryError";
        this.issues = issues;
    }
}

export function parseCompatibilityAnnotations(source, path = "<source>") {
    const annotations = [];
    const issues = [];
    for (const comment of sourceComments(source)) {
        const compat = [...comment.text.matchAll(/@compat\s+([a-z0-9][a-z0-9._-]*)/gu)];
        const removeAt = [...comment.text.matchAll(/@removeAt\s+([^\s*]+)/gu)];
        if (compat.length === 0 && removeAt.length === 0) continue;
        const line = comment.line;
        if (compat.length !== 1 || removeAt.length !== 1) {
            issues.push({
                kind: "invalid-annotation",
                line,
                path,
            });
            continue;
        }
        const version = removeAt[0][1];
        try {
            parseVersion(version);
        } catch {
            issues.push({
                compat: compat[0][1],
                kind: "invalid-version",
                line,
                path,
                removeAt: version,
            });
            continue;
        }
        annotations.push({
            compat: compat[0][1],
            line,
            path,
            removeAt: version,
        });
    }
    return { annotations, issues };
}

export async function checkCompatibilityExpiry(options = {}) {
    const root = resolve(options.root ?? defaultRepoRoot);
    const currentVersion =
        options.currentVersion ?? (await readProjectVersion(root));
    parseVersion(currentVersion);
    const files = options.files ?? listTrackedSourceFiles(root);
    const annotations = [];
    const issues = [];
    for (const relativePath of files) {
        if (!shouldScanSourceFile(relativePath)) continue;
        const source = await readFile(resolve(root, relativePath), "utf8");
        const parsed = parseCompatibilityAnnotations(source, relativePath);
        annotations.push(...parsed.annotations);
        issues.push(...parsed.issues);
    }
    for (const annotation of annotations) {
        if (compareVersions(currentVersion, annotation.removeAt) >= 0) {
            issues.push({
                ...annotation,
                currentVersion,
                kind: "expired",
            });
        }
    }
    annotations.sort(compareAnnotationLocation);
    issues.sort(compareIssueLocation);
    if (issues.length !== 0) {
        throw new CompatibilityExpiryError(
            "Compatibility expiry check failed.",
            issues,
        );
    }
    return { annotations, currentVersion };
}

export async function listCompatibilityExpiry(options = {}) {
    const root = resolve(options.root ?? defaultRepoRoot);
    const currentVersion =
        options.currentVersion ?? (await readProjectVersion(root));
    parseVersion(currentVersion);
    const files = options.files ?? listTrackedSourceFiles(root);
    const annotations = [];
    const issues = [];
    for (const relativePath of files) {
        if (!shouldScanSourceFile(relativePath)) continue;
        const source = await readFile(resolve(root, relativePath), "utf8");
        const parsed = parseCompatibilityAnnotations(source, relativePath);
        annotations.push(
            ...parsed.annotations.map((annotation) => ({
                ...annotation,
                expired:
                    compareVersions(currentVersion, annotation.removeAt) >= 0,
            })),
        );
        issues.push(...parsed.issues);
    }
    annotations.sort(compareAnnotationLocation);
    issues.sort(compareIssueLocation);
    return { annotations, currentVersion, issues };
}

function sourceComments(source) {
    const comments = [];
    const lines = source.split(/\r?\n/u);
    let block;
    let lineRun;
    const flushLineRun = () => {
        if (lineRun === undefined) return;
        comments.push(lineRun);
        lineRun = undefined;
    };
    for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index];
        const trimmed = text.trimStart();
        if (block !== undefined) {
            block.text += `\n${text}`;
            if (trimmed.includes("*/")) {
                comments.push(block);
                block = undefined;
            }
            continue;
        }
        if (trimmed.startsWith("/*")) {
            flushLineRun();
            block = { line: index + 1, text };
            if (trimmed.includes("*/")) {
                comments.push(block);
                block = undefined;
            }
            continue;
        }
        if (
            trimmed.startsWith("//") ||
            trimmed === "#" ||
            trimmed.startsWith("# ")
        ) {
            if (lineRun === undefined) {
                lineRun = { line: index + 1, text };
            } else {
                lineRun.text += `\n${text}`;
            }
            continue;
        }
        flushLineRun();
    }
    flushLineRun();
    return comments;
}

function listTrackedSourceFiles(root) {
    const output = execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    return output.split("\0").filter((path) => path.length !== 0);
}

function shouldScanSourceFile(path) {
    if (!sourceExtensions.has(extname(path))) return false;
    const segments = path.replaceAll("\\", "/").split("/");
    return !segments.some((segment) =>
        ["dist", "node_modules", "target", ".vite"].includes(segment),
    );
}

async function readProjectVersion(root) {
    const packageJson = JSON.parse(
        await readFile(resolve(root, "package.json"), "utf8"),
    );
    if (typeof packageJson.version !== "string") {
        throw new Error("package.json version is missing");
    }
    return packageJson.version;
}

function compareAnnotationLocation(left, right) {
    return left.path.localeCompare(right.path) || left.line - right.line;
}

function compareIssueLocation(left, right) {
    return compareAnnotationLocation(left, right) ||
        left.kind.localeCompare(right.kind);
}

function formatIssue(issue) {
    const location = `${issue.path}:${issue.line}`;
    if (issue.kind === "expired") {
        return `${location} ${issue.compat} expired at ${issue.removeAt} (current ${issue.currentVersion})`;
    }
    if (issue.kind === "invalid-version") {
        return `${location} ${issue.compat} has invalid @removeAt ${issue.removeAt}`;
    }
    return `${location} compatibility comment must contain exactly one @compat and one @removeAt`;
}

function readRootOption(args) {
    const rootIndex = args.indexOf("--root");
    if (rootIndex === -1) return { args, root: defaultRepoRoot };
    const rootValue = args[rootIndex + 1];
    if (rootValue === undefined) throw new Error("--root requires a path");
    return {
        args: args.filter(
            (_value, index) => index !== rootIndex && index !== rootIndex + 1,
        ),
        root: resolve(rootValue),
    };
}

async function main(argv) {
    const { args, root } = readRootOption(argv);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--list")) {
        throw new Error("usage: check-compat-expiry.mjs [--list] [--root path]");
    }
    if (args[0] === "--list") {
        const result = await listCompatibilityExpiry({ root });
        for (const issue of result.issues) {
            process.stdout.write(`invalid\t-\t-\t${formatIssue(issue)}\n`);
        }
        for (const annotation of result.annotations) {
            process.stdout.write(
                `${annotation.expired ? "expired" : "active"}\t${annotation.removeAt}\t${annotation.compat}\t${annotation.path}:${annotation.line}\n`,
            );
        }
        return;
    }
    const result = await checkCompatibilityExpiry({ root });
    process.stdout.write(
        `compat expiry check passed: ${result.annotations.length} active annotations at ${result.currentVersion}\n`,
    );
}

if (
    process.argv[1] !== undefined &&
    resolve(process.argv[1]) === resolve(scriptPath)
) {
    main(process.argv.slice(2)).catch((error) => {
        if (error instanceof CompatibilityExpiryError) {
            for (const issue of error.issues) {
                process.stderr.write(`${formatIssue(issue)}\n`);
            }
        } else {
            process.stderr.write(
                `${error instanceof Error ? error.message : String(error)}\n`,
            );
        }
        process.exitCode = 1;
    });
}
