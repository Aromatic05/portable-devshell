import { resolve } from "node:path";
const workspace = resolve(import.meta.dirname, "../../..");
export default {
    root: workspace,
    resolve: { alias: {
        react: resolve(workspace, "packages/web/node_modules/react"),
        "@portable-devshell/shared": resolve(workspace, "packages/shared/src/index.ts"),
    } },
    test: {
        environment: "jsdom",
        setupFiles: [resolve(workspace, "packages/web/test/setup.ts")],
        include: ["test/known-bugs/ui/WebBugs.test.tsx"],
    },
};
