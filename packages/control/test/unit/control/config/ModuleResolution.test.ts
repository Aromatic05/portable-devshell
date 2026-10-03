import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const configDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../src/config",
);
const projectRoot = resolve(configDirectory, "../../../..");

test("Config relative module references resolve", async () => {
    const configPath = resolve(projectRoot, "tsconfig.typecheck.json");
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    assert.equal(configFile.error, undefined, "typecheck tsconfig must be readable");
    const parsedConfig = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        dirname(configPath),
    );
    assert.deepEqual(parsedConfig.errors, [], "typecheck tsconfig must parse");

    const sourceFiles = await collectTypeScriptFiles(configDirectory);
    const unresolved: string[] = [];

    for (const sourceFilePath of sourceFiles) {
        const source = ts.createSourceFile(
            sourceFilePath,
            await readFile(sourceFilePath, "utf8"),
            ts.ScriptTarget.Latest,
            true,
        );
        const visit = (node: ts.Node): void => {
            const specifier = getModuleSpecifier(node);
            if (specifier?.startsWith(".")) {
                const resolution = ts.resolveModuleName(
                    specifier,
                    sourceFilePath,
                    parsedConfig.options,
                    ts.sys,
                );
                if (resolution.resolvedModule === undefined) {
                    unresolved.push(
                        `${relative(configDirectory, sourceFilePath)} -> ${specifier}`,
                    );
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }

    assert.deepEqual(unresolved, []);
});

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
        entries.map(async (entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) return collectTypeScriptFiles(path);
            return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
        }),
    );
    return nested.flat().sort();
}

function getModuleSpecifier(node: ts.Node): string | undefined {
    if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
    ) {
        return node.moduleSpecifier.text;
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        const literal = node.argument.literal;
        if (ts.isStringLiteral(literal)) return literal.text;
    }
    if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
    ) {
        return node.arguments[0].text;
    }
    return undefined;
}
