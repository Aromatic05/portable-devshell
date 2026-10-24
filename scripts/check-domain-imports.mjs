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
        name: "toolcall-does-not-depend-on-worker-or-approval",
        roots: [domain("packages/core/src/toolcall")],
        forbidden: anyTarget(
            pathTarget("packages/core/src/instance"),
            pathTarget("packages/core/src/approval"),
            packageTarget("@portable-devshell/core/instance"),
            packageTarget("@portable-devshell/core/approval"),
        ),
    },
    {
        name: "generic-transport-does-not-depend-on-control-contracts",
        roots: [domain("packages/shared/src/transport")],
        forbidden: pathTarget("packages/shared/src/control"),
    },
];

const coreDomains = ["approval", "audit", "instance", "task", "terminal", "toolcall"];
for (const owner of coreDomains) {
    rules.push({
        name: `${owner}-uses-domain-public-entries`,
        roots: [domain(`packages/core/src/${owner}`)],
        forbidden: (candidate, entry) =>
            coreDomains.some((target) => {
                if (
                    target === owner ||
                    !under(candidate, domain(`packages/core/src/${target}`))
                ) return false;
                const entryFiles = entry.typeOnly
                    ? ["Api"]
                    : owner === "instance"
                      ? ["index", "Public"]
                      : ["Public"];
                return !entryFiles.some(
                    (entryFile) =>
                        candidate === domain(
                            `packages/core/src/${target}/${entryFile}`,
                        ),
                );
            }),
    });
}

const controlPublicDomains = [
    "artifact",
    "debug",
    "extension",
    "instance",
    "overview",
    "toolcall",
];
for (const owner of controlPublicDomains) {
    rules.push({
        name: `${owner}-uses-control-domain-public-entries`,
        roots: [domain(`packages/control/src/${owner}`)],
        forbidden: (candidate, entry) =>
            controlPublicDomains.some((target) => {
                if (
                    target === owner ||
                    !under(candidate, domain(`packages/control/src/${target}`))
                ) return false;
                const entryFile = entry.typeOnly ? "Api" : "Public";
                return candidate !== domain(
                    `packages/control/src/${target}/${entryFile}`,
                );
            }),
    });
}

// Server composes Control route adapters from Domain public contracts.
// Overview's index.ts is the explicit Runtime composition entrypoint.
rules.push({
    name: "server-uses-control-domain-public-entries",
    roots: [domain("packages/control/src/server")],
    forbidden: (candidate, entry) =>
        [
            "artifact",
            "config",
            "context",
            "debug",
            "extension",
            "instance",
            "overview",
            "toolcall",
        ].some((target) => {
            if (!under(candidate, domain(`packages/control/src/${target}`)))
                return false;
            if (
                target === "overview" &&
                !entry.typeOnly &&
                candidate === domain("packages/control/src/overview/index")
            ) return false;
            return candidate !== domain(
                `packages/control/src/${target}/${entry.typeOnly ? "Api" : "Public"}`,
            );
        }),
});

// UI state may consume domain ViewModels, not their presentation projections.
rules.push(
    {
        name: "extension-uses-config-public-entries",
        roots: [domain("packages/control/src/extension")],
        forbidden: (candidate, entry) =>
            under(candidate, domain("packages/control/src/config")) &&
            candidate !== domain(
                `packages/control/src/config/${entry.typeOnly ? "Api" : "Public"}`,
            ),
    },
    {
        name: "tui-state-does-not-depend-on-view",
        roots: [domain("packages/tui/src/state")],
        forbidden: pathTarget("packages/tui/src/view"),
    },
    {
        name: "tui-interaction-does-not-depend-on-view",
        roots: [domain("packages/tui/src/interaction")],
        forbidden: pathTarget("packages/tui/src/view"),
    },
    {
        name: "web-state-does-not-depend-on-view",
        roots: [domain("packages/web/src/state")],
        forbidden: pathTarget("packages/web/src/view"),
    },
    {
        name: "web-domain-does-not-depend-on-view",
        roots: [domain("packages/web/src/app/domain")],
        forbidden: pathTarget("packages/web/src/view"),
    },
);

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
    const record = (node, typeOnly = false) => {
        if (!ts.isStringLiteralLike(node)) return;
        result.push({
            line:
                source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            specifier: node.text,
            typeOnly,
        });
    };
    const visit = (node) => {
        if (ts.isImportDeclaration(node)) {
            const clause = node.importClause;
            const typeOnly =
                clause?.isTypeOnly === true ||
                (clause?.name === undefined &&
                    clause?.namedBindings !== undefined &&
                    ts.isNamedImports(clause.namedBindings) &&
                    clause.namedBindings.elements.length > 0 &&
                    clause.namedBindings.elements.every(
                        (element) => element.isTypeOnly,
                    ));
            record(node.moduleSpecifier, typeOnly);
        } else if (ts.isExportDeclaration(node)) {
            if (node.moduleSpecifier !== undefined)
                record(node.moduleSpecifier, node.isTypeOnly);
        } else if (
            ts.isImportTypeNode(node) &&
            ts.isLiteralTypeNode(node.argument)
        ) {
            record(node.argument.literal, true);
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
for (const entryRoot of [
    ...coreDomains.map((name) => domain("packages/core/src/" + name)),
    ...controlPublicDomains.map((name) => domain("packages/control/src/" + name)),
    domain("packages/control/src/config"),
    domain("packages/control/src/context"),
    domain("packages/control/src/server"),
]) {
    try {
        await access(join(entryRoot, "index.ts"));
    } catch {
        failures.push({
            file: relative(root, entryRoot),
            line: 1,
            rule: "domain-has-composition-entrypoint",
            message: relative(root, entryRoot) + " requires index.ts",
        });
    }
}
const corePackagePath = domain("packages/core/package.json");
const corePackage = JSON.parse(await readFile(corePackagePath, "utf8"));
const coreExports = Object.keys(corePackage.exports ?? {});
if (coreExports.length !== 1 || coreExports[0] !== ".") {
    failures.push({
        file: relative(root, corePackagePath),
        line: 1,
        rule: "core-exposes-package-root-only",
        message: `exports must contain only ".", found ${JSON.stringify(coreExports)}`,
    });
}

for (const rule of rules) {
    for (const sourceRoot of rule.roots) {
        for (const file of await sourceFiles(sourceRoot)) {
            const text = await readFile(file, "utf8");
            for (const entry of imports(file, text)) {
                if (
                    !rule.forbidden(
                        resolveTarget(file, entry.specifier),
                        entry,
                    )
                ) continue;
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
            failure.message ??
                `${failure.file}:${failure.line} ${failure.rule}: forbidden import ${JSON.stringify(failure.specifier)}`,
        );
    }
    process.exitCode = 1;
} else {
    console.log(`domain import rules passed (${rules.length} rules)`);
}
