import { runTui } from "../../packages/tui/dist/index.js";

await runTui({ xdgRuntimeDir: process.env.XDG_RUNTIME_DIR });
