import assert from "node:assert/strict";
import test from "node:test";

import { modelCommandAvailable } from "../../../../src/extension/api/point/cli/command/Access.ts";

test("built-in Memory is available without an instance Comment model-extension selection", () => {
    assert.equal(modelCommandAvailable({ extensionId: "comment", id: "memory" }, []), true);
    assert.equal(modelCommandAvailable({ extensionId: "comment", id: "memory" }, ["instance"]), true);
    assert.equal(modelCommandAvailable({ extensionId: "comment", id: "other" }, []), false);
    assert.equal(modelCommandAvailable({ extensionId: "third-party", id: "memory" }, []), false);
    assert.equal(modelCommandAvailable({ extensionId: "third-party", id: "memory" }, ["third-party"]), true);
});
