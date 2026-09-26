import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { InventoryStore } from "../src/inventory.js";
import { ComputerPairing, PAIRING_TTL } from "../src/computer-pairing.js";
import { createApp } from "../src/app.js";
import { pairingHTML } from "../web/computers.js";

test("computer approval requires the private claim secret, survives retry, expires and respects revocation", () => {
  const store = new Store(":memory:");
  try {
    const inventory = new InventoryStore(store.db);
    const pairing = new ComputerPairing(store.db, inventory);
    const pending = pairing.begin("Work Mac", 1000);
    assert.deepEqual(pairing.claim(pending.device_code, 1001), {
      status: "pending",
    });
    assert.equal(pairing.claim(pending.code, 1001), undefined);
    assert.deepEqual(pairing.preview(pending.code, 1001), {
      name: "Work Mac",
      approved: false,
    });
    assert.equal(inventory.list().length, 0);
    assert.equal(pairing.decide(pending.code, true, 1001), true);
    const result = pairing.claim(pending.device_code, 1002);
    assert.equal(result?.status, "approved");
    if (result?.status !== "approved") throw new Error("Missing credential");
    assert.deepEqual(
      new ComputerPairing(store.db, inventory).claim(pending.device_code, 1003),
      result,
    );
    assert.equal(inventory.list().length, 1);
    const row = store.db.prepare("SELECT * FROM computer_pairings").get()!;
    assert.ok(!JSON.stringify(row).includes(pending.device_code));
    assert.ok(!JSON.stringify(row).includes(result.token));
    inventory.revoke(inventory.authenticate(result.token)!);
    assert.equal(pairing.claim(pending.device_code, 1004), undefined);
    assert.equal(pairing.preview(pending.code, 1000 + PAIRING_TTL), undefined);
    assert.equal(
      pairing.claim(pending.device_code, 1000 + PAIRING_TTL),
      undefined,
    );
    const declined = pairing.begin("No", 2000);
    assert.equal(pairing.decide(declined.code, false, 2001), true);
    assert.equal(pairing.claim(declined.device_code, 2002), undefined);
    assert.equal(inventory.list().length, 1);
  } finally {
    store.close();
  }
});

test("pairing HTTP approval is owner-only, cross-origin protected and credentials remain inventory-scoped", async () => {
  const store = new Store(":memory:");
  const server = createApp(store, {
    ownerToken: "x".repeat(40),
    origin: "http://localhost",
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server");
  const base = `http://127.0.0.1:${address.port}`;
  const call = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(base + "/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const pending = (await (
      await call("computer-pairing", { name: "Mac" })
    ).json()) as { code: string; device_code: string };
    assert.equal((await call(`computer-pairing/${pending.code}`)).status, 401);
    assert.equal(
      (
        await call(`computer-pairing/${pending.code}/decision`, {
          approve: true,
        })
      ).status,
      401,
    );
    const login = await call("login", { token: "x".repeat(40) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await call(
          `computer-pairing/${pending.code}/decision`,
          { approve: true },
          { cookie, origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.deepEqual(
      await (
        await call("computer-pairing/claim", {
          device_code: pending.device_code,
        })
      ).json(),
      { status: "pending" },
    );
    const preview = await (
      await call(`computer-pairing/${pending.code}`, undefined, { cookie })
    ).json();
    assert.deepEqual(preview, { name: "Mac", approved: false });
    await call(
      `computer-pairing/${pending.code}/decision`,
      { approve: true },
      { cookie },
    );
    const claimed = (await (
      await call("computer-pairing/claim", { device_code: pending.device_code })
    ).json()) as { token: string };
    assert.equal(
      (await call("computer-pairing/claim", { device_code: "0".repeat(64) }))
        .status,
      410,
    );
    const auth = { authorization: `Bearer ${claimed.token}` };
    assert.equal((await call("computers", undefined, auth)).status, 401);
    assert.equal(
      (
        await call(
          "computer/report",
          { sequence: 1, observations: [], coverage: "instrumented" },
          auth,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        (await (await call("computer/identity", undefined, auth)).json()) as {
          online: boolean;
        }
      ).online,
      true,
    );
    assert.equal((await call("computer/disconnect", {}, auth)).status, 200);
    assert.equal(
      (await call("computer/identity", undefined, auth)).status,
      401,
    );
    for (let i = 0; i < 9; i++)
      assert.equal(
        (await call("computer-pairing", { name: "Mac" })).status,
        201,
      );
    assert.equal((await call("computer-pairing", { name: "Mac" })).status, 429);
    assert.match(pairingHTML(pending.code), /Approve only if/);
    assert.ok(!pairingHTML(pending.code).includes(pending.device_code));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
