import assert from "node:assert/strict";
import test from "node:test";

import { resolveControlExtensionAssetLimits } from "../../src/composition/runtime/ControlRuntimeFactory.ts";

test("Control grants the reserved Agent Extension a bounded large-Provider asset budget only", () => {
    assert.equal(resolveControlExtensionAssetLimits("artifact"), undefined);
    assert.equal(resolveControlExtensionAssetLimits("skill"), undefined);
    assert.deepEqual(resolveControlExtensionAssetLimits("agent"), {
        maxCompressedBytes: 128 * 1024 * 1024,
        maxFileBytes: 256 * 1024 * 1024,
        maxLogicalBytes: 512 * 1024 * 1024
    });
});
