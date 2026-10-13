import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Node 26 defines localStorage on the Node global. Vitest may preserve its
// disabled native getter instead of JSDOM's storage. Browser tests must use
// the actual JSDOM storage, never Node's process-wide persistent storage.
const jsdomWindow = (globalThis as typeof globalThis & {
    jsdom?: { window: Window };
}).jsdom?.window;
if (jsdomWindow !== undefined) {
    for (const name of ["localStorage", "sessionStorage"] as const) {
        Object.defineProperty(globalThis, name, {
            configurable: true,
            get: () => jsdomWindow[name],
        });
    }
}

afterEach(() => cleanup());
