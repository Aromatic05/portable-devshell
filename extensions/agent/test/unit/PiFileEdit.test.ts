import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEditChangeSet } from "../../src/provider/pi/render/FileEdit.js";

test("Pi renders canonical file_edit bodies and move results in Worker operation order", () => {
    const changes = [
        "*** Begin Patch ",
        "*** Add File: literal.txt",
        "+*** Delete File: source.txt",
        "++plus",
        "*** Update File: source.txt",
        "*** Move to: moved.txt",
        "@@ anchor",
        "-old",
        "+new",
        "*** Update File: moved.txt",
        "*** Move to: final.txt",
        "",
        "*** Rewrite File: rewrite.txt",
        "+*** End Patch",
        "*** Delete File: remove.txt",
        " *** End Patch",
    ].join("\n");

    assert.deepEqual(parseEditChangeSet(changes), [
        { kind: "write", path: "literal.txt", body: "*** Delete File: source.txt\n+plus" },
        { kind: "patch", path: "source.txt", body: "@@ anchor\n-old\n+new" },
        { kind: "move", path: "moved.txt", source: "source.txt", body: "" },
        { kind: "move", path: "final.txt", source: "moved.txt", body: "" },
        { kind: "rewrite", path: "rewrite.txt", body: "*** End Patch" },
        { kind: "delete", path: "remove.txt", body: "" },
    ]);
});
