// The host-side response-body re-fetch must not be a confused deputy
// (review #10): http(s) only, no loopback / link-local / private targets
// (checked after DNS, with the checked IP pinned), no cross-origin
// redirects, credentials only to the page's own origin, bounded size/time.

import { test, expect, describe, afterAll } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { classifyAddress, refetch, defaultRefetchDeps, type RefetchDeps, type RefetchOptions } from "../refetch";

type Call = { url: string; address: string; headers: Record<string, string> };

function fakeDeps(
  dns: Record<string, string[]>,
  routes: Record<string, { status?: number; headers?: Record<string, string>; body?: string }> = {},
) {
  const calls: Call[] = [];
  const lookups: string[] = [];
  const deps: RefetchDeps = {
    async lookup(host) {
      lookups.push(host);
      const a = dns[host];
      if (!a) throw new Error(`ENOTFOUND ${host}`);
      return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    async request({ url, address, headers }) {
      calls.push({ url: url.href, address, headers });
      const r = routes[url.href] ?? { status: 200, body: "ok" };
      return {
        status: r.status ?? 200,
        headers: { "content-type": "text/plain", ...r.headers },
        body: new TextEncoder().encode(r.body ?? ""),
      };
    },
    localAddresses: () => ["127.0.0.1", "::1", "192.168.1.20"],
  };
  return { deps, calls, lookups };
}

const base = (o: Partial<RefetchOptions> = {}): RefetchOptions => ({
  policy: "public",
  headers: {},
  bridgePorts: [9222],
  timeoutMs: 2000,
  maxBytes: 1024 * 1024,
  maxRedirects: 3,
  ...o,
});

describe("classifyAddress", () => {
  const cases: Array<[string, string]> = [
    ["8.8.8.8", "public"],
    ["172.32.0.1", "public"],
    ["2606:4700::6810:84e5", "public"],
    ["127.0.0.1", "loopback"],
    ["127.255.0.9", "loopback"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["0.0.0.0", "reserved"],
    ["::", "reserved"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.0.10", "private"],
    ["100.64.0.1", "private"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["::ffff:10.0.0.1", "private"],
    ["64:ff9b::a00:1", "private"],
    ["2002:c0a8:0101::1", "private"],
    ["169.254.169.254", "link-local"],
    ["fe80::1", "link-local"],
    ["febf::1", "link-local"],
    ["224.0.0.1", "reserved"],
    ["ff02::1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["not-an-ip", "reserved"],
    // review follow-ups
    ["100::1", "reserved"],
    ["::ffff:0:7f00:1", "reserved"],
    ["::1:0:0:1", "reserved"],
    ["3fff::1", "reserved"],
    ["::ffff:0:0", "reserved"],
  ];
  for (const [ip, want] of cases) {
    test(`${ip} → ${want}`, () => expect(classifyAddress(ip)).toBe(want as any));
  }
});

describe("refetch policy", () => {
  test("only http(s) URLs", async () => {
    const { deps, calls } = fakeDeps({});
    for (const u of ["file:///etc/passwd", "data:text/plain,hi", "ftp://example.com/x", "javascript:alert(1)", "blob:https://a/b", "not a url"]) {
      await expect(refetch(u, base(), deps)).rejects.toThrow(/scheme|URL/i);
    }
    expect(calls).toHaveLength(0);
  });

  test("a hostname resolving to the metadata service is refused before any request", async () => {
    const { deps, calls } = fakeDeps({ "metadata.evil.test": ["169.254.169.254"] });
    await expect(refetch("http://metadata.evil.test/latest/meta-data/", base(), deps)).rejects.toThrow(/link-local/);
    expect(calls).toHaveLength(0);
  });

  test("private / loopback IP literals (including odd spellings) are refused", async () => {
    const { deps, calls } = fakeDeps({});
    for (const u of ["http://10.0.0.1/", "http://[::1]:8080/", "http://2130706433/", "http://0x7f.1/", "https://192.168.1.1/admin", "http://[fd00::5]/", "http://0.0.0.0:9222/json"]) {
      await expect(refetch(u, base(), deps)).rejects.toThrow(/refused/);
    }
    expect(calls).toHaveLength(0);
  });

  test("any private address in the DNS answer refuses the whole host (rebinding)", async () => {
    const { deps, calls } = fakeDeps({ "mixed.test": ["93.184.216.34", "127.0.0.1"] });
    await expect(refetch("https://mixed.test/a.js", base(), deps)).rejects.toThrow(/loopback/);
    expect(calls).toHaveLength(0);
  });

  test("the checked address is the one connected to (pinned)", async () => {
    const { deps, calls, lookups } = fakeDeps({ "cdn.test": ["93.184.216.34"] });
    const r = await refetch("https://cdn.test/app.js", base(), deps);
    expect(new TextDecoder().decode(r.body)).toBe("ok");
    expect(lookups).toEqual(["cdn.test"]);
    expect(calls).toEqual([{ url: "https://cdn.test/app.js", address: "93.184.216.34", headers: expect.any(Object) }]);
  });

  test('"any" allows loopback but never the bridge\'s own ports on local addresses', async () => {
    const { deps, calls } = fakeDeps({ localhost: ["127.0.0.1"], "lan.test": ["192.168.1.20"], "far.test": ["93.184.216.34"] });
    const any = base({ policy: "any" });
    await expect(refetch("http://localhost:8081/bundle.js", any, deps)).resolves.toBeDefined();
    await expect(refetch("http://localhost:9222/json/list", any, deps)).rejects.toThrow(/bridge/);
    await expect(refetch("http://lan.test:9222/json/list", any, deps)).rejects.toThrow(/bridge/);
    await expect(refetch("http://[::1]:9222/", any, deps)).rejects.toThrow(/bridge/);
    await expect(refetch("http://far.test:9222/x", any, deps)).resolves.toBeDefined();
    expect(calls.map((c) => c.url)).toEqual(["http://localhost:8081/bundle.js", "http://far.test:9222/x"]);
  });

  test('"any": IPv4-mapped spellings of this machine are still the bridge (review)', async () => {
    const { deps, calls } = fakeDeps({ "mapped.test": ["::ffff:192.168.1.20"] });
    const any = base({ policy: "any" });
    for (const u of ["http://[::ffff:0.0.0.0]:9222/json", "http://[::ffff:127.0.0.1]:9222/", "http://[::ffff:192.168.1.20]:9222/", "http://mapped.test:9222/", "http://0.1.2.3:9222/"]) {
      await expect(refetch(u, any, deps)).rejects.toThrow(/bridge/);
    }
    expect(calls).toHaveLength(0);
  });

  test('"off" never fetches', async () => {
    const { deps, calls } = fakeDeps({ "cdn.test": ["93.184.216.34"] });
    await expect(refetch("https://cdn.test/a", base({ policy: "off" }), deps)).rejects.toThrow(/disabled/);
    expect(calls).toHaveLength(0);
  });
});

describe("refetch redirects", () => {
  test("same-origin redirects are followed and re-checked", async () => {
    const { deps, calls, lookups } = fakeDeps(
      { "cdn.test": ["93.184.216.34"] },
      { "https://cdn.test/a": { status: 302, headers: { location: "/b" } }, "https://cdn.test/b": { body: "B" } },
    );
    const r = await refetch("https://cdn.test/a", base(), deps);
    expect(new TextDecoder().decode(r.body)).toBe("B");
    expect(calls.map((c) => c.url)).toEqual(["https://cdn.test/a", "https://cdn.test/b"]);
    expect(lookups).toEqual(["cdn.test", "cdn.test"]);
  });

  test("cross-origin redirects are refused", async () => {
    const { deps, calls } = fakeDeps(
      { "cdn.test": ["93.184.216.34"], "other.test": ["93.184.216.35"] },
      { "https://cdn.test/a": { status: 301, headers: { location: "https://other.test/x" } } },
    );
    await expect(refetch("https://cdn.test/a", base(), deps)).rejects.toThrow(/cross-origin redirect/);
    // http→https on the same host is also a different origin
    expect(calls).toHaveLength(1);
  });

  test("a redirect whose host now resolves privately is refused (re-check per hop)", async () => {
    let n = 0;
    const { deps, calls } = fakeDeps({}, { "https://flip.test/a": { status: 307, headers: { location: "/b" } } });
    deps.lookup = async () => [{ address: n++ === 0 ? "93.184.216.34" : "10.0.0.7", family: 4 }];
    await expect(refetch("https://flip.test/a", base(), deps)).rejects.toThrow(/private/);
    expect(calls).toHaveLength(1);
  });

  test("more than maxRedirects hops is an error", async () => {
    const routes: Record<string, any> = {};
    for (let i = 0; i < 10; i++) routes[`https://cdn.test/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    const { deps, calls } = fakeDeps({ "cdn.test": ["93.184.216.34"] }, routes);
    await expect(refetch("https://cdn.test/0", base(), deps)).rejects.toThrow(/redirects/);
    expect(calls).toHaveLength(4);
  });
});

describe("refetch credentials", () => {
  const headers = { Cookie: "sid=secret", Authorization: "Bearer t", "Proxy-Authorization": "x", Accept: "*/*", "If-None-Match": "abc", Host: "evil", Connection: "keep-alive" };

  test("Cookie / Authorization only go to the page's own origin", async () => {
    const { deps, calls } = fakeDeps({ "app.test": ["93.184.216.34"], "cdn.test": ["93.184.216.35"] });
    await refetch("https://app.test/api/me", base({ headers, documentURL: "https://app.test/index.html" }), deps);
    await refetch("https://cdn.test/lib.js", base({ headers, documentURL: "https://app.test/index.html" }), deps);
    await refetch("https://app.test/api/me", base({ headers }), deps); // page origin unknown
    const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
    const [same, cross, unknown] = calls.map((c) => lower(c.headers));
    expect(same!.cookie).toBe("sid=secret");
    expect(same!.authorization).toBe("Bearer t");
    for (const h of [cross!, unknown!]) {
      expect(h.cookie).toBeUndefined();
      expect(h.authorization).toBeUndefined();
      expect(h.accept).toBe("*/*");
    }
    for (const h of [same!, cross!, unknown!]) {
      expect(h["proxy-authorization"]).toBeUndefined();
      expect(h["if-none-match"]).toBeUndefined();
      expect(h.host).toBeUndefined();
      expect(h.connection).toBeUndefined();
    }
  });
});

describe("refetch transport limits (real http client against a local server)", () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const chunk = Buffer.alloc(64 * 1024, 1);
      let sent = 0;
      const pump = () => {
        while (sent < 8 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once("drain", pump);
        }
        res.end();
      };
      pump();
    } else if (req.url === "/declared") {
      res.writeHead(200, { "content-length": String(50 * 1024 * 1024) });
      res.write("x");
    } else if (req.url === "/hang") {
      // never answers
    } else if (req.url === "/echo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ host: req.headers.host, cookie: req.headers.cookie ?? null }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const ready = new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)));
  afterAll(() => server.close());
  const local = (o: Partial<RefetchOptions> = {}) => base({ policy: "any", bridgePorts: [], ...o });

  test("body larger than maxBytes is cut off with an error", async () => {
    const port = await ready;
    const t0 = performance.now();
    await expect(refetch(`http://127.0.0.1:${port}/big`, local({ maxBytes: 256 * 1024 }), defaultRefetchDeps)).rejects.toThrow(/too large/);
    await expect(refetch(`http://127.0.0.1:${port}/declared`, local({ maxBytes: 256 * 1024 }), defaultRefetchDeps)).rejects.toThrow(/too large/);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  test("a hanging server times out", async () => {
    const port = await ready;
    const t0 = performance.now();
    await expect(refetch(`http://127.0.0.1:${port}/hang`, local({ timeoutMs: 300 }), defaultRefetchDeps)).rejects.toThrow(/timed out/);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  test("the pinned connection still sends the original Host header", async () => {
    const port = await ready;
    const r = await refetch(`http://localhost:${port}/echo`, local(), defaultRefetchDeps);
    expect(JSON.parse(new TextDecoder().decode(r.body)).host).toBe(`localhost:${port}`);
    expect(r.mimeType).toBe("application/json");
  });

  test("default policy refuses the local server outright", async () => {
    const port = await ready;
    await expect(refetch(`http://127.0.0.1:${port}/echo`, base(), defaultRefetchDeps)).rejects.toThrow(/loopback/);
  });
});
