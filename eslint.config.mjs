import js from "@eslint/js";
import globals from "globals";
import { dirname, resolve } from "node:path";
import tseslint from "typescript-eslint";

const noIndexReexport = {
    meta: {
        type: "problem",
        docs: {
            description: "forbid re-exporting declarations from index modules",
        },
        messages: {
            forbidden:
                "Do not re-export from index modules; export from the owning module directly.",
        },
        schema: [],
    },
    create(context) {
        const check = (node) => {
            const source = node.source?.value;
            if (typeof source !== "string") return;
            if (!/(?:^|\/)index(?:\.[cm]?[jt]sx?)?$/u.test(source)) return;
            context.report({ messageId: "forbidden", node });
        };
        return {
            ExportAllDeclaration: check,
            ExportNamedDeclaration: check,
        };
    },
};

const apiTypeOnly = {
    meta: {
        type: "problem",
        docs: { description: "keep Api.ts modules type-only" },
        messages: {
            importValue: "Api.ts may only use type-only imports.",
            exportValue: "Api.ts may only export types.",
            runtimeValue: "Api.ts may not contain runtime declarations or statements.",
        },
        schema: [],
    },
    create(context) {
        const isTypeDeclaration = (node) =>
            node?.type === "TSInterfaceDeclaration" ||
            node?.type === "TSTypeAliasDeclaration";
        const isTypeExport = (node) =>
            node.exportKind === "type" ||
            (node.specifiers?.length > 0 &&
                node.specifiers.every((specifier) => specifier.exportKind === "type"));
        return {
            ImportDeclaration(node) {
                if (
                    node.importKind === "type" ||
                    (node.specifiers.length > 0 &&
                        node.specifiers.every(
                            (specifier) => specifier.importKind === "type",
                        ))
                ) return;
                context.report({ messageId: "importValue", node });
            },
            ExportNamedDeclaration(node) {
                if (isTypeDeclaration(node.declaration) || isTypeExport(node)) return;
                context.report({ messageId: "exportValue", node });
            },
            ExportAllDeclaration(node) {
                if (node.exportKind === "type") return;
                context.report({ messageId: "exportValue", node });
            },
            ExportDefaultDeclaration(node) {
                context.report({ messageId: "exportValue", node });
            },
            "Program:exit"(node) {
                for (const statement of node.body) {
                    if (
                        statement.type === "ImportDeclaration" ||
                        statement.type === "ExportNamedDeclaration" ||
                        statement.type === "ExportAllDeclaration" ||
                        statement.type === "ExportDefaultDeclaration" ||
                        statement.type === "TSInterfaceDeclaration" ||
                        statement.type === "TSTypeAliasDeclaration" ||
                        statement.type === "EmptyStatement"
                    ) continue;
                    context.report({ messageId: "runtimeValue", node: statement });
                }
            },
        };
    },
};

const publicExplicitExports = {
    meta: {
        type: "problem",
        docs: { description: "require explicit Public.ts exports" },
        messages: {
            wildcard: "Public.ts must list its public surface explicitly; wildcard exports are forbidden.",
        },
        schema: [],
    },
    create(context) {
        return {
            ExportAllDeclaration(node) {
                context.report({ messageId: "wildcard", node });
            },
        };
    },
};

const publicRuntimeOnly = {
    meta: {
        type: "problem",
        docs: { description: "keep Public.ts runtime-only" },
        messages: {
            typeExport: "Public.ts may only export runtime values; move types to Api.ts.",
            typeDeclaration: "Public.ts may not declare types; move them to Api.ts.",
        },
        schema: [],
    },
    create(context) {
        return {
            TSInterfaceDeclaration(node) {
                context.report({ messageId: "typeDeclaration", node });
            },
            TSTypeAliasDeclaration(node) {
                context.report({ messageId: "typeDeclaration", node });
            },
            ExportNamedDeclaration(node) {
                if (
                    node.exportKind === "type" ||
                    node.declaration?.type === "TSInterfaceDeclaration" ||
                    node.declaration?.type === "TSTypeAliasDeclaration" ||
                    node.specifiers?.some((specifier) => specifier.exportKind === "type")
                ) context.report({ messageId: "typeExport", node });
            },
            ExportAllDeclaration(node) {
                if (node.exportKind === "type")
                    context.report({ messageId: "typeExport", node });
            },
        };
    },
};

const publicNoIndexImport = {
    meta: {
        type: "problem",
        docs: { description: "forbid Public.ts from importing lifecycle index modules" },
        messages: {
            forbidden: "Public.ts may not import index modules; lifecycle stays at index.ts.",
        },
        schema: [],
    },
    create(context) {
        return {
            ImportDeclaration(node) {
                const source = node.source.value;
                if (
                    typeof source === "string" &&
                    /(?:^|\/)index(?:\.[cm]?[jt]sx?)?$/u.test(source)
                ) context.report({ messageId: "forbidden", node });
            },
        };
    },
};

const publicOwnerOnly = {
    meta: {
        type: "problem",
        docs: { description: "keep Public.ts exports inside the owning domain" },
        messages: {
            forbidden: "Public.ts may only export runtime values owned by its own directory tree.",
        },
        schema: [],
    },
    create(context) {
        const owner = dirname(context.filename).replaceAll("\\", "/");
        const check = (node) => {
            const source = node.source?.value;
            if (typeof source !== "string") return;
            const target = resolve(dirname(context.filename), source).replaceAll("\\", "/");
            if (target === owner || target.startsWith(`${owner}/`)) return;
            context.report({ messageId: "forbidden", node });
        };
        return {
            ExportAllDeclaration: check,
            ExportNamedDeclaration: check,
        };
    },
};

const noTypeImportFromPublic = {
    meta: {
        type: "problem",
        docs: { description: "forbid core type imports through Public.ts" },
        messages: {
            forbidden: "Import core contracts from Api.ts or their owner, not Public.ts.",
        },
        schema: [],
    },
    create(context) {
        const isPublic = (value) =>
            typeof value === "string" &&
            /(?:^|\/)Public(?:\.[cm]?[jt]sx?)?$/u.test(value);
        return {
            ImportDeclaration(node) {
                if (!isPublic(node.source.value)) return;
                if (
                    node.importKind === "type" ||
                    node.specifiers.some((specifier) => specifier.importKind === "type")
                ) context.report({ messageId: "forbidden", node });
            },
            ExportNamedDeclaration(node) {
                if (!isPublic(node.source?.value)) return;
                if (
                    node.exportKind === "type" ||
                    node.specifiers.some((specifier) => specifier.exportKind === "type")
                ) context.report({ messageId: "forbidden", node });
            },
            ExportAllDeclaration(node) {
                if (isPublic(node.source.value) && node.exportKind === "type")
                    context.report({ messageId: "forbidden", node });
            },
            TSImportType(node) {
                const source = node.argument?.literal?.value ?? node.argument?.value;
                if (isPublic(source))
                    context.report({ messageId: "forbidden", node });
            },
        };
    },
};

const noCoreSubpathImport = {
    meta: {
        type: "problem",
        docs: { description: "forbid core subpath imports across packages" },
        messages: {
            forbidden:
                "Cross-package core imports must use @portable-devshell/core only; core subpaths are private.",
        },
        schema: [],
    },
    create(context) {
        const filename = context.filename.replaceAll("\\", "/");
        if (filename.includes("/packages/core/")) return {};
        const checkSource = (node, value) => {
            if (typeof value !== "string") return;
            const packageSubpath = value.startsWith("@portable-devshell/core/");
            const relativeCoreSource =
                value.startsWith(".") &&
                resolve(dirname(context.filename), value)
                    .replaceAll("\\", "/")
                    .includes("/packages/core/src/");
            if (!packageSubpath && !relativeCoreSource) return;
            context.report({ messageId: "forbidden", node });
        };
        return {
            ImportDeclaration(node) {
                checkSource(node, node.source.value);
            },
            ExportNamedDeclaration(node) {
                checkSource(node, node.source?.value);
            },
            ExportAllDeclaration(node) {
                checkSource(node, node.source.value);
            },
            ImportExpression(node) {
                checkSource(node, node.source?.value);
            },
            TSImportType(node) {
                checkSource(node, node.argument?.literal?.value ?? node.argument?.value);
            },
        };
    },
};

const architecture = {
    rules: {
        "api-type-only": apiTypeOnly,
        "no-core-subpath-import": noCoreSubpathImport,
        "no-index-reexport": noIndexReexport,
        "no-type-import-from-public": noTypeImportFromPublic,
        "public-explicit-exports": publicExplicitExports,
        "public-no-index-import": publicNoIndexImport,
        "public-owner-only": publicOwnerOnly,
        "public-runtime-only": publicRuntimeOnly,
    },
};

export default [
    {
        ignores: [
            "**/dist/**",
            "**/coverage/**",
            "node_modules/**",
            "target/**",
            ".codegraph/**",
            ".testspace/**",
            ".testspace-*/**",
            "var/**",
            "var/backup/**",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            architecture,
        },
    },
    {
        files: [
            "packages/**/src/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
            "extensions/**/src/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
        ],
        rules: {
            "architecture/no-core-subpath-import": "error",
            "architecture/no-index-reexport": "error",
            "architecture/no-type-import-from-public": "error",
        },
    },
    {
        files: ["**/*.{js,mjs,cjs}"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "no-useless-escape": "off",
            "no-useless-assignment": "off",
            "preserve-caught-error": "off",
        },
    },
    {
        files: ["**/*.{ts,tsx,mts,cts}"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "no-undef": "off",
            "no-useless-escape": "off",
            "no-useless-assignment": "off",
            "preserve-caught-error": "off",
            "@typescript-eslint/no-empty-object-type": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                },
            ],
        },
    },
    {
        files: [
            "packages/**/src/**/Api.ts",
            "extensions/**/src/**/Api.ts",
        ],
        rules: {
            "architecture/api-type-only": "error",
        },
    },
    {
        files: [
            "packages/**/src/**/Public.ts",
            "extensions/**/src/**/Public.ts",
        ],
        rules: {
            "architecture/public-explicit-exports": "error",
            "architecture/public-no-index-import": "error",
            "architecture/public-owner-only": "error",
            "architecture/public-runtime-only": "error",
        },
    },
    {
        files: [
            "**/*.test.{ts,tsx,mts,cts,js,mjs,cjs}",
            "tests/**/*.{js,mjs,cjs}",
        ],
        rules: {
            "@typescript-eslint/no-unused-vars": "off",
        },
    },
    {
        // Synthetic domain session fixtures deliberately expose partial,
        // dynamically shaped states. Application sources and other tests
        // still enforce no-explicit-any.
        files: [
            "packages/tui/test/support/DomainHarness.ts",
            "packages/web/test/support/DomainHarness.tsx",
        ],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
        },
    },
];
