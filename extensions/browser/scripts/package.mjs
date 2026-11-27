import { copyFile } from "node:fs/promises";
await copyFile(new URL("../devshell-extension.json", import.meta.url), new URL("../dist/devshell-extension.json", import.meta.url));
