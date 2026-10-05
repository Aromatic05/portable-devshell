import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const domain = (path) => resolve(root, path);
const under = (target, prefix) =>
    target === prefix || target.startsWith(`${prefix}${sep}`);

const resolveTarget = (sourceFile, specifier) =>
    specifier.startsWith(".")
        ? resolve(
              dirname(sourceFile),
              specifier.replace(/\.(?:[cm]?js|tsx?)$/u, ""),
          )
        : specifier;

const pathTarget = (path) => {
    const prefix = domain(path);
    return (candidate) =>
        typeof candidate === "string" &&
        candidate.startsWith(root) &&
        under(candidate, prefix);
};

const packageTarget = (name) => (candidate) =>
    typeof candidate === "string" &&
    !candidate.startsWith(root) &&
    (candidate === name || candidate.startsWith(`${name}/`));

const packageTargetExcept = (name, ...allowed) => {
    const matches = packageTarget(name);
    const exceptions = new Set(allowed);
    return (candidate) => matches(candidate) && !exceptions.has(candidate);
};

const anyTarget = (...tests) => (candidate) =>
    tests.some((test) => test(candidate));

const controlDomains = [
    "artifact",
    "auth",
    "extension",
    "instance",
    "overview",
].map((name) => pathTarget(`packages/control/src/${name}`));

const sharedRuntimeDomains = [
    "packages/shared/src/control/instance",
    "packages/shared/src/execution",
    "packages/shared/src/workspace",
].map(pathTarget);

const rules = [
    {
        name: "config-has-no-runtime-domain-dependencies",
        roots: [
            domain("packages/shared/src/control/config"),
            domain("packages/control/src/config"),
        ],
        forbidden: anyTarget(
            packageTarget("@portable-devshell/core"),
            packageTarget("@portable-devshell/mcp"),
            ...controlDomains,
            ...sharedRuntimeDomains,
            pathTarget("packages/core/src"),
            pathTarget("packages/mcp/src"),
        ),
    },
    {
        name: "instance-does-not-depend-on-business-domains",
        roots: [domain("packages/core/src/instance")],
        forbidden: anyTarget(
            pathTarget("packages/core/src/approval"),
            pathTarget("packages/core/src/task"),
            pathTarget("packages/core/src/terminal"),
            pathTarget("packages/core/src/audit"),
            pathTarget("packages/core/src/toolcall"),
            packageTarget("@portable-devshell/core/approval"),
            packageTarget("@portable-devshell/core/task"),
            packageTarget("@portable-devshell/core/terminal"),
            packageTarget("@portable-devshell/core/audit"),
            packageTarget("@portable-devshell/core/toolcall"),
        ),
    },
    {
        name: "context-does-not-depend-on-mcp",
        roots: [domain("packages/core/src/context")],
        forbidden: anyTarget(
            packageTargetExcept(
                "@portable-devshell/mcp",
                "@portable-devshell/mcp/tool",
            ),
            pathTarget("packages/mcp/src"),
        ),
    },
    {
        name: "toolcall-does-not-depend-on-worker-or-approval",
        roots: [domain("packages/core/src/toolcall")],
        forbidden: anyTarget(
            pathTarget("packages/core/src/instance"),
            pathTarget("packages/core/src/approval"),
            packageTarget("@portable-devshell/core/instance"),
            packageTarget("@portable-devshell/core/approval"),
        ),
    },
];

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

for (const sourceRoot of rules.flatMap((rule) => rule.roots)) {
    await access(sourceRoot);
}

async function sourceFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
        else if (sourceExtensions.has(extname(entry.name))) files.push(path);
    }
    return files;
}

function imports(sourceFile, text) {
    const source = ts.createSourceFile(
        sourceFile,
        text,
        ts.ScriptTarget.Latest,
        true,
        sourceFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const result = [];
    const record = (node) => {
        if (!ts.isStringLiteralLike(node)) return;
        result.push({
            line:
                source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            specifier: node.text,
        });
    };
    const visit = (node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            if (node.moduleSpecifier !== undefined) record(node.moduleSpecifier);
        } else if (
            ts.isImportTypeNode(node) &&
            ts.isLiteralTypeNode(node.argument)
        ) {
            record(node.argument.literal);
        } else if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length === 1
        ) {
            record(node.arguments[0]);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return result;
}

const failures = [];
for (const rule of rules) {
    for (const sourceRoot of rule.roots) {
        for (const file of await sourceFiles(sourceRoot)) {
            const text = await readFile(file, "utf8");
            for (const entry of imports(file, text)) {
                if (!rule.forbidden(resolveTarget(file, entry.specifier))) continue;
                failures.push({
                    file: relative(root, file),
                    line: entry.line,
                    rule: rule.name,
                    specifier: entry.specifier,
                });
            }
        }
    }
}

if (failures.length > 0) {
    for (const failure of failures) {
        console.error(
            `${failure.file}:${failure.line} ${failure.rule}: forbidden import ${JSON.stringify(failure.specifier)}`,
        );
    }
    process.exitCode = 1;
} else {
    console.log(`domain import rules passed (${rules.length} rules)`);
}
