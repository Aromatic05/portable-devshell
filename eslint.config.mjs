import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
    {
        ignores: [
            "**/dist/**",
            "**/coverage/**",
            "node_modules/**",
            "target/**",
            ".codegraph/**",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
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
