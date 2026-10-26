import { afterEach, expect, test } from "vitest";
import { readToolCallDisplay, writeToolCallDisplay } from "./Preferences.js";

const key = "portable-devshell:mcpapp:toolcall-display:v1";

afterEach(() => {
    writeToolCallDisplay(true);
    window.localStorage.removeItem(key);
});

test("provided cards remain visible by default without storing a server Inline setting", () => {
    window.localStorage.removeItem(key);
    expect(readToolCallDisplay()).toBe(true);
    expect(window.localStorage.getItem(key)).toBeNull();
});

test("the presentation preference preserves an explicit local choice", () => {
    writeToolCallDisplay(false);
    expect(readToolCallDisplay()).toBe(false);
    expect(window.localStorage.getItem(key)).toBe("off");
    writeToolCallDisplay(true);
    expect(readToolCallDisplay()).toBe(true);
    expect(window.localStorage.getItem(key)).toBe("on");
});
