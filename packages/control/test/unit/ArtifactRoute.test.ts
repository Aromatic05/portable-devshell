import assert from "node:assert/strict";
import test from "node:test";

import { readArtifactViewImageInput } from "../../src/control/artifact/route/ArtifactRouteInput.ts";

test("artifact viewImage route accepts exactly one path or handle", () => {
    assert.deepEqual(
        readArtifactViewImageInput({ defaultInstance: "alpha", path: "./preview.png" }),
        { path: "./preview.png" }
    );
    assert.deepEqual(
        readArtifactViewImageInput({ handle: "artifact-1", instance: "remote" }),
        { handle: "artifact-1", instance: "remote" }
    );
    assert.throws(() => readArtifactViewImageInput({ handle: "artifact-1", path: "./preview.png" }));
    assert.throws(() => readArtifactViewImageInput({ defaultInstance: "alpha" }));
});
