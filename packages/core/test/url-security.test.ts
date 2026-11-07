import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UrlSecurityError,
  assertUrlAllowed,
  isBlockedAddress,
  safeFetch,
} from "../src/index.ts";

test("blocks private, loopback, link-local and metadata addresses", async () => {
  assert.equal(isBlockedAddress("127.0.0.1"), true);
  assert.equal(isBlockedAddress("10.1.2.3"), true);
  assert.equal(isBlockedAddress("172.16.0.1"), true);
  assert.equal(isBlockedAddress("192.168.1.1"), true);
  assert.equal(isBlockedAddress("169.254.169.254"), true);
  assert.equal(isBlockedAddress("::1"), true);
  assert.equal(isBlockedAddress("93.184.216.34"), false);
  for (const url of [
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "file:///etc/passwd",
    "http://user:pass@example.com/",
  ]) {
    await assert.rejects(assertUrlAllowed(url), UrlSecurityError, url);
  }
});

test("blocks hostnames that resolve to private addresses", async () => {
  await assert.rejects(
    assertUrlAllowed("http://internal.example/", {
      lookupImpl: async () => [{ address: "10.0.0.5", family: 4 }] as never,
    }),
    UrlSecurityError,
  );
  await assertUrlAllowed("http://internal.example/", {
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }] as never,
  });
});

test("allowlists and private-network opt-in", async () => {
  await assert.rejects(
    assertUrlAllowed("http://example.com/", { allowedHosts: ["other.com"] }),
    UrlSecurityError,
  );
  await assertUrlAllowed("http://localhost/", { allowPrivateNetworks: true });
});

test("caps redirects and re-validates every hop", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/secret" },
    });
  };
  await assert.rejects(
    safeFetch("http://93.184.216.34/start", {}, { fetchImpl }),
    UrlSecurityError,
  );
  assert.equal(calls, 1);

  const loop: typeof fetch = async () =>
    new Response(null, { status: 302, headers: { location: "/again" } });
  await assert.rejects(
    safeFetch("http://93.184.216.34/", {}, { fetchImpl: loop, maxRedirects: 2 }),
    /Too many redirects/,
  );
});

test("blocks IPv6 forms that embed or alias IPv4 and special ranges", async () => {
  const blocked = [
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe", // 169.254.169.254
    "::ffff:10.0.0.1",
    "0:0:0:0:0:ffff:7f00:1",
    "::127.0.0.1",
    "::7f00:1",
    "::0",
    "::",
    "64:ff9b::7f00:1",
    "64:ff9b::169.254.169.254",
    "64:ff9b:1::1",
    "fec0::1",
    "fe80::1",
    "febf::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "ff05::2",
    "2002:7f00:1::1", // 6to4 of 127.0.0.1
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "2001:db8::1",
    "[::1]",
    "fe80::1%eth0",
    "198.18.0.1",
    "198.19.255.255",
    "224.0.0.1",
    "239.255.255.250",
    "255.255.255.255",
    "240.0.0.1",
    "0.0.0.0",
    "100.100.100.200",
    "192.0.0.192",
    "168.63.129.16",
    "not-an-ip",
    "",
  ];
  for (const address of blocked) assert.equal(isBlockedAddress(address), true, address);
  const allowed = [
    "93.184.216.34",
    "8.8.8.8",
    "198.17.255.255",
    "198.20.0.1",
    "172.32.0.1",
    "2606:2800:220:1:248:1893:25c8:1946",
    "::ffff:5db8:d822", // 93.184.216.34
    "64:ff9b::5db8:d822",
    "2001:4860:4860::8888",
  ];
  for (const address of allowed) assert.equal(isBlockedAddress(address), false, address);
});

test("rejects URL literal forms WHATWG rewrites into blocked addresses", async () => {
  for (const url of [
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[64:ff9b::7f00:1]/",
    "http://[fec0::1]/",
    "http://[ff02::1]/",
    "http://198.18.0.1/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://127.1/",
    "http://[::1]:8080/",
  ]) {
    await assert.rejects(assertUrlAllowed(url), UrlSecurityError, url);
  }
});

test("blocks DNS results using IPv4-mapped IPv6 addresses", async () => {
  await assert.rejects(
    assertUrlAllowed("http://evil.example/", {
      lookupImpl: async () =>
        [
          { address: "93.184.216.34", family: 4 },
          { address: "::ffff:7f00:1", family: 6 },
        ] as never,
    }),
    UrlSecurityError,
  );
});

test("strips credential headers on cross-origin redirects only", async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const responses = [
    { status: 302, location: "http://93.184.216.35/other" }, // cross-origin
    { status: 302, location: "http://93.184.216.35/same-origin" },
  ];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    const next = responses.shift();
    if (next === undefined) return new Response("ok");
    return new Response(null, { status: next.status, headers: { location: next.location } });
  };
  const response = await safeFetch(
    "http://93.184.216.34/start",
    {
      headers: {
        Authorization: "Bearer secret",
        Cookie: "sid=1",
        "Proxy-Authorization": "Basic x",
        Accept: "text/plain",
      },
    },
    { fetchImpl },
  );
  assert.equal(await response.text(), "ok");
  assert.equal(seen.length, 3);
  assert.equal(seen[0]?.headers.get("authorization"), "Bearer secret");
  assert.equal(seen[0]?.headers.get("cookie"), "sid=1");
  for (const hop of seen.slice(1)) {
    assert.equal(hop.headers.get("authorization"), null);
    assert.equal(hop.headers.get("cookie"), null);
    assert.equal(hop.headers.get("proxy-authorization"), null);
    assert.equal(hop.headers.get("accept"), "text/plain");
  }
});

test("keeps credentials on same-origin redirects", async () => {
  const seen: Headers[] = [];
  let first = true;
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen.push(new Headers(init?.headers));
    if (first) {
      first = false;
      return new Response(null, { status: 302, headers: { location: "/next" } });
    }
    return new Response("ok");
  };
  await safeFetch("http://93.184.216.34/a", { headers: [["Authorization", "Bearer t"]] }, { fetchImpl });
  assert.equal(seen[1]?.get("authorization"), "Bearer t");
});

test("strips credentials given as a Headers instance and drops body on 303", async () => {
  const seen: Array<{ headers: Headers; method?: string; body?: unknown }> = [];
  let first = true;
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen.push({ headers: new Headers(init?.headers), method: init?.method, body: init?.body });
    if (first) {
      first = false;
      return new Response(null, { status: 303, headers: { location: "http://93.184.216.35/" } });
    }
    return new Response("ok");
  };
  await safeFetch(
    "http://93.184.216.34/a",
    { method: "POST", body: "payload", headers: new Headers({ authorization: "Bearer t" }) },
    { fetchImpl },
  );
  assert.equal(seen[1]?.headers.get("authorization"), null);
  assert.equal(seen[1]?.method, "GET");
  assert.equal(seen[1]?.body, undefined);
});

// --- DNS-rebinding pinning (default transport, no fetchImpl) ---

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

async function listen(
  handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void,
  host = "127.0.0.1",
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

test("pinned transport connects to the given address, never re-resolving the hostname", async () => {
  const { server, port } = await listen((req, res) => res.end(`host=${req.headers.host}`));
  try {
    const { pinnedFetch } = await import("../src/pinned-fetch.ts");
    // "rebind.example" does not resolve anywhere; success proves DNS was bypassed.
    const response = await pinnedFetch(new URL(`http://rebind.example:${port}/`), {}, [
      { address: "127.0.0.1", family: 4 },
    ]);
    assert.equal(await response.text(), `host=rebind.example:${port}`);
  } finally {
    server.close();
  }
});

test("pinnedLookup only ever answers with validated addresses (all and single forms)", async () => {
  const { pinnedLookup } = await import("../src/pinned-fetch.ts");
  const lookup = pinnedLookup([
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]);
  const all = await new Promise<unknown>((resolve, reject) =>
    lookup("evil.example", { all: true } as never, ((e: unknown, a: unknown) =>
      e ? reject(e) : resolve(a)) as never),
  );
  assert.deepEqual(all, [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]);
  const v6 = await new Promise<unknown[]>((resolve, reject) =>
    lookup("evil.example", { family: 6 } as never, ((e: unknown, a: string, f: number) =>
      e ? reject(e) : resolve([a, f])) as never),
  );
  assert.deepEqual(v6, ["2606:2800:220:1:248:1893:25c8:1946", 6]);
});

test("safeFetch connects to the validated address even if DNS would answer differently", async () => {
  const { server, port } = await listen((_req, res) => res.end("reached"));
  try {
    // Validation passes with a public-looking address (192.0.2.x is blocked, so use 93.184.x).
    // The pinned socket targets that public address, NOT the loopback server: connection must
    // fail/time out rather than land on 127.0.0.1.
    const lookupImpl = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await assert.rejects(
      safeFetch(`http://rebind.example:${port}/`, {}, { lookupImpl, signal: controller.signal }),
    );
  } finally {
    server.close();
  }
});

test("pinned transport reaches an IPv6 literal", async () => {
  const { server, port } = await listen((_req, res) => res.end("v6 ok"), "::1");
  try {
    // Loopback is blocked by default; opt in to reach the local server over [::1].
    const ok = await safeFetch(`http://[::1]:${port}/`, {}, { allowPrivateNetworks: true });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "v6 ok");
  } finally {
    server.close();
  }
});

test("redirect Location returned by the pinned transport is rejected by validation", async () => {
  const { pinnedFetch } = await import("../src/pinned-fetch.ts");
  const { server, port } = await listen((_req, res) => {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
  });
  try {
    const first = await pinnedFetch(new URL(`http://x.example:${port}/`), {}, [
      { address: "127.0.0.1", family: 4 },
    ]);
    assert.equal(first.status, 302);
    await assert.rejects(
      assertUrlAllowed(new URL(first.headers.get("location") ?? "")),
      UrlSecurityError,
    );
  } finally {
    server.close();
  }
});

test("pinned transport honours abort signal and POST bodies", async () => {
  const { pinnedFetch } = await import("../src/pinned-fetch.ts");
  const { server, port } = await listen((req, res) => {
    if (req.url === "/hang") return;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => res.end(`${req.method}:${Buffer.concat(chunks).toString()}`));
  });
  try {
    const pinned = [{ address: "127.0.0.1", family: 4 }];
    const echo = await pinnedFetch(new URL(`http://x.example:${port}/e`), { method: "POST", body: "hi" }, pinned);
    assert.equal(await echo.text(), "POST:hi");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      pinnedFetch(new URL(`http://x.example:${port}/hang`), {}, pinned, controller.signal),
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
