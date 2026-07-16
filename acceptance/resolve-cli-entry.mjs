import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readPackageBinPath } from "../scripts/application-layout.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPackageRoot = resolve(repoRoot, "packages/cli");
const cli = await readPackageBinPath(cliPackageRoot, "devshell");

process.stdout.write(cli.absolutePath);
