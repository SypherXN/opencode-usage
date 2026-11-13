import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCredentialValue, resolveZen, type Credential } from "../src/auth.ts";
import { zenProvider, parseZenBalance } from "../src/providers/zen.ts";
import { StatusEngine } from "../src/status.ts";
import { STATUS_OUTPUT } from "../src/rpc.ts";

const T0 = 1_760_000_000_000;
const raw = { type: "oauth", access: "fake-secret", expires: T0 + 60_000,
  metadata: { server: "https://opencode.ai/console", orgID: "wrk_Test123" } };
function resolve(value: unknown = raw, at = T0) {
  const c = parseCredentialValue(value);
  return resolveZen(new Map<string, Credential>(c ? [["opencode", c]] : []), at);
}

test("Zen accepts Console workspace OAuth metadata, not keys or unrelated credentials", () => {
  assert.deepEqual(resolve(), { access: "fake-secret", orgID: "wrk_Test123" });
  assert.equal(resolve(raw, T0 + 60_000), null);
  for (const expires of [-1, "bad", Infinity, NaN, true]) assert.equal(resolve({ ...raw, expires }), null);
  for (const access of ["", " "]) assert.equal(resolve({ ...raw, access }), null);
  assert.equal(resolve({ type: "key", key: "fake-key" }), null);
  assert.equal(resolve({ ...raw, metadata: { ...raw.metadata, server: "https://evil.invalid" } }), null);
  for (const orgID of ["", "wrk_", "org_foo\r\nsecret", "other_id"]) {
    assert.equal(resolve({ ...raw, metadata: { ...raw.metadata, orgID } }), null);
  }
  assert.ok(resolve({ ...raw, expires: 0 }));
  assert.ok(resolve({ ...raw, expires: undefined }));
  assert.ok(resolve({ ...raw, metadata: { ...raw.metadata, orgID: "org_Legacy" } }));
});

test("Zen parses micro-cents without fabricating a percentage or zero", () => {
  for (const availableMicroCents of [1234000000, "1234000000"]) {
    assert.equal(parseZenBalance({ availableMicroCents }), 12.34);
  }
  assert.equal(parseZenBalance({ availableMicroCents: "0" }), 0);
  for (const value of [null, {}, [], "", " ", "bad", "-1", -1, Infinity, NaN, true]) {
    assert.equal(parseZenBalance({ availableMicroCents: value }), null);
  }
  assert.equal(parseZenBalance(null), null);
});

test("Zen sends bounded read-only Console request, re-resolves tokens, and reports zero as limited", async () => {
  let token = "first-fake";
  let calls = 0;
  const p = zenProvider({ now: () => T0, resolveCredential: () => ({ access: token, orgID: "wrk_Test" }),
    fetchImpl: (async (url, init) => {
      calls++;
      assert.equal(url, "https://opencode.ai/console/api/billing/status");
      assert.equal(init?.method ?? "GET", "GET");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), `Bearer ${token}`);
      assert.equal(headers.get("x-org-id"), "wrk_Test");
      return new Response(JSON.stringify({ availableMicroCents: calls === 1 ? "1234000000" : "0" }));
    }) as typeof fetch });
  const first = await p.fetch();
  assert.equal(first.windows[0].balanceUSD, 12.34);
  assert.equal(first.windows[0].usedPercent, null);
  assert.equal(first.availability, "available");
  assert.ok(!JSON.stringify(first).includes(token));
  token = "second-fake";
  const second = await p.fetch();
  assert.equal(second.availability, "limited");
  assert.equal(second.windows[0].resetsAt, null);
  assert.equal(calls, 2);
});

test("Zen missing auth, HTTP, network, JSON and balance failures stay unknown and sanitized", async () => {
  let calls = 0;
  const p = zenProvider({ resolveCredential: () => null, fetchImpl: (async () => { calls++; throw Error("secret"); }) as typeof fetch });
  assert.equal((await p.fetch()).availability, "unknown");
  assert.equal(calls, 0);
  for (const fetchImpl of [
    async () => { throw Error("fake-secret"); },
    ...[401, 403, 429, 500].map(status => async () => new Response("fake-secret", { status })),
    async () => new Response("fake-secret"), async () => new Response("{}"),
  ]) {
    const s = await zenProvider({ resolveCredential: () => resolve(), fetchImpl: fetchImpl as typeof fetch }).fetch();
    assert.equal(s.availability, "unknown");
    assert.equal(s.checkedAt, null);
    assert.ok(!JSON.stringify(s).includes("fake-secret"));
  }
});

test("Zen cache and RPC preserve dollar balance, failures keep historical credit but not availability", async () => {
  let t = T0;
  let calls = 0;
  const p = zenProvider({ now: () => t, resolveCredential: () => resolve(raw, T0),
    fetchImpl: (async () => { calls++; return calls === 1
      ? new Response('{"availableMicroCents":"1234000000"}') : new Response("oops", { status: 500 }); }) as typeof fetch });
  const engine = new StatusEngine({ now: () => t, providers: { zen: p } });
  await Promise.all([engine.read("zen"), engine.read("zen")]);
  const doc = STATUS_OUTPUT.parse(await engine.snapshot());
  assert.equal(doc.sources.zen.windows[0].balanceUSD, 12.34);
  assert.equal(doc.sources.zen.windows[0].currency, "USD");
  assert.equal(calls, 1);
  t += 60_000;
  const failed = await engine.read("zen");
  assert.equal(failed.windows[0].balanceUSD, 12.34);
  assert.equal(failed.checkedAt, new Date(T0).toISOString());
  assert.equal(failed.availability, "unknown");
  t += 5 * 60_000;
  assert.equal((await engine.read("zen")).stale, true);
});
