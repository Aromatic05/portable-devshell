import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const protoUrl = new URL(
    "packages/shared/src/transport/envelope/Envelope.proto",
    root,
);
const outputUrl = new URL(
    "packages/shared/src/transport/envelope/Schema.ts",
    root,
);
const require = createRequire(new URL("packages/shared/package.json", root));
const protobuf = require("protobufjs");
const source = await readFile(protoUrl, "utf8");
const parsed = protobuf.parse(source);
parsed.root.resolveAll();
const schema = JSON.stringify(parsed.root.toJSON(), null, 4);
await writeFile(
    outputUrl,
    `// Generated from Envelope.proto by scripts/generate-transport-protobuf.mjs.
// Do not edit manually.
export const envelopeSchema = ${schema} as const;
`,
);
console.log(fileURLToPath(outputUrl));
