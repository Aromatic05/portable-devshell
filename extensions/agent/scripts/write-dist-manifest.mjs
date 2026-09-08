import { mkdir, readFile, writeFile } from "node:fs/promises";

const source = JSON.parse(await readFile(new URL("../src/builtin/devshell-extension.json", import.meta.url), "utf8"));
const target = new URL("../dist/builtin/devshell-extension.json", import.meta.url);
await mkdir(new URL("../dist/builtin/", import.meta.url), { recursive: true });
await writeFile(target, `${JSON.stringify({ ...source, entry: "index.js" }, null, 4)}\n`, "utf8");
