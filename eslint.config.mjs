import js from "@eslint/js";
import globals from "globals";
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

const architecture = {
    rules: {
        "no-index-reexport": noIndexReexport,
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
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            architecture,
        },
        rules: {
            "architecture/no-index-reexport": "error",
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
            "**/*.test.{ts,tsx,mts,cts,js,mjs,cjs}",
            "tests/**/*.{js,mjs,cjs}",
        ],
        rules: {
            "@typescript-eslint/no-unused-vars": "off",
        },
    },
];
