import { test, expect } from "bun:test";
import { mapConsoleType } from "../console-log";

// Safari emits "warning" (its native level for console.warn) — earlier the
// switch only matched "warn", so warnings fell through to "log" and the
// Debug Console rendered them in the wrong channel.
test("mapConsoleType — warn and warning both map to CDP 'warning'", () => {
  expect(mapConsoleType("warn")).toBe("warning");
  expect(mapConsoleType("warning")).toBe("warning");
});

test("mapConsoleType — passes through CDP-native types", () => {
  for (const t of [
    "log",
    "info",
    "error",
    "debug",
    "dir",
    "dirxml",
    "table",
    "trace",
    "clear",
    "assert",
    "profile",
    "profileEnd",
    "count",
    "timeEnd",
    "startGroup",
    "startGroupCollapsed",
    "endGroup",
  ]) {
    expect(mapConsoleType(t)).toBe(t);
  }
});

test("mapConsoleType — unknown types fall back to 'log'", () => {
  expect(mapConsoleType("timing")).toBe("log");
  expect(mapConsoleType("")).toBe("log");
  expect(mapConsoleType("nonsense")).toBe("log");
});
