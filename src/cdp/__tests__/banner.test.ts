// The startup banner is where users look for "how do I attach Chrome?" (issue #1).

import { test, expect, spyOn } from "bun:test";
import { logCdpServerBanner } from "../http";

function banner(host: string, port = 9222): string {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    logCdpServerBanner({ brand: "safari", host, port });
    return spy.mock.calls.map((c) => String(c[0])).join("\n");
  } finally {
    spy.mockRestore();
  }
}

test("banner spells out the chrome://inspect steps", () => {
  const out = banner("localhost");
  expect(out).toContain("chrome://inspect/#devices");
  expect(out).toContain("Configure");
  expect(out).toContain("localhost:9222");
  // the index page lists a devtools:// URL per page for the address bar
  expect(out).toContain("http://localhost:9222/");
});

test("a wildcard bind tells Chrome to use localhost, not 0.0.0.0", () => {
  for (const h of ["0.0.0.0", "::", "[::]"]) {
    const out = banner(h);
    expect(out).toContain("add localhost:9222");
    expect(out).not.toContain("add 0.0.0.0");
  }
});

test("an IPv6 host is bracketed", () => {
  expect(banner("::1")).toContain("[::1]:9222");
});
