import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { attachPairingRelay } from "../src/channel/pairing-relay.js";
import {
  RELAY_LIMITS,
  refill,
  TUNNEL_LIMITS,
  type RelayLimits,
} from "../src/channel/relay-limits.js";

async function fixture(limits: Partial<RelayLimits> = {}) {
  const id = randomUUID(),
    credential = "x".repeat(64);
  let revoked = false;
  const server = createServer();
  const relay = attachPairingRelay(
    server,
    (token) => (!revoked && token === credential ? id : undefined),
    { ...RELAY_LIMITS, ...limits },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const root = `ws://127.0.0.1:${address.port}/api/secure-relay`;
  const clients: WebSocket[] = [];
  const client = (
    side: string,
    options: { token?: string; computer?: string; origin?: string } = {},
  ): WebSocket => {
    const socket = new WebSocket(`${root}/${options.computer ?? id}/${side}`, {
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
      },
    });
    socket.on("error", () => {});
    clients.push(socket);
    return socket;
  };
  return {
    id,
    credential,
    client,
    revoke: () => {
      revoked = true;
    },
    close: async () => {
      relay.close();
      for (const socket of clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("opaque relay requires the computer credential and binds it to one route", async () => {
  const f = await fixture();
  try {
    for (const options of [
      {},
      { token: "z".repeat(64) },
      { token: f.credential, computer: randomUUID() },
      { token: f.credential, origin: "https://slopticus.com" },
    ]) {
      const socket = f.client("mac", options);
      const [error] = await once(socket, "error");
      assert.match(String(error), /403/);
    }
    const phone = f.client("phone");
    const [error] = await once(phone, "error");
    assert.match(String(error), /403/);
  } finally {
    await f.close();
  }
});

test("opaque relay forwards binary bytes and closes both ends on computer revocation", async () => {
  const f = await fixture();
  try {
    const mac = f.client("mac", { token: f.credential });
    await once(mac, "open");
    const phone = f.client("phone");
    await once(phone, "open");
    const bytes = Buffer.from([0, 255, 22, 3, 3]);
    const received = once(mac, "message");
    phone.send(bytes);
    const [body, binary] = await received;
    assert.equal(binary, true);
    assert.deepEqual(body, bytes);
    const response = once(phone, "message");
    mac.send(bytes);
    assert.deepEqual((await response)[0], bytes);
    const macClosed = once(mac, "close"),
      phoneClosed = once(phone, "close");
    f.revoke();
    phone.send(bytes);
    await Promise.all([macClosed, phoneClosed]);
  } finally {
    await f.close();
  }
});

for (const invalid of ["text", "oversize", "duplicate"] as const) {
  test(`opaque relay rejects ${invalid} input`, async () => {
    const f = await fixture();
    try {
      const mac = f.client("mac", { token: f.credential });
      await once(mac, "open");
      const phone = f.client("phone");
      await once(phone, "open");
      if (invalid === "duplicate") {
        const extra = f.client("phone");
        assert.match(String((await once(extra, "error"))[0]), /403/);
      } else {
        const closed = once(mac, "close");
        phone.send(invalid === "text" ? "not TLS" : Buffer.alloc(65537));
        await closed;
      }
    } finally {
      await f.close();
    }
  });
}

test("a busy slot outlives the old fixed lifetime and a quiet one is retired", async () => {
  const f = await fixture({ idleMs: 400, maxSlotMs: 60_000, probeMs: 30_000 });
  try {
    const mac = f.client("mac", { token: f.credential });
    await once(mac, "open");
    const phone = f.client("phone");
    await once(phone, "open");
    const bytes = Buffer.from([7, 7, 7]);
    // Four exchanges spanning more than one idle window: traffic must keep it.
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const received = once(mac, "message");
      phone.send(bytes);
      assert.deepEqual((await received)[0], bytes);
    }
    assert.equal(mac.readyState, WebSocket.OPEN, "traffic keeps the slot open");
    const closed = once(mac, "close");
    const [code] = await closed;
    assert.equal(code, 1000, "a quiet slot is retired gracefully");
  } finally {
    await f.close();
  }
});

test("the slot ends at its absolute lifetime however busy it is", async () => {
  const f = await fixture({ idleMs: 60_000, maxSlotMs: 300, probeMs: 60_000 });
  try {
    const mac = f.client("mac", { token: f.credential });
    await once(mac, "open");
    const phone = f.client("phone");
    await once(phone, "open");
    const closed = once(mac, "close");
    const beat = setInterval(() => phone.send(Buffer.from([1])), 50);
    try {
      const [code] = await closed;
      assert.equal(code, 1000);
    } finally {
      clearInterval(beat);
    }
  } finally {
    await f.close();
  }
});

test("a slot that exhausts its burst faster than it refills is dropped", async () => {
  const f = await fixture({
    burstBytes: 4096,
    refillMs: 600_000,
    idleMs: 60_000,
    probeMs: 60_000,
  });
  try {
    const mac = f.client("mac", { token: f.credential });
    await once(mac, "open");
    const phone = f.client("phone");
    await once(phone, "open");
    const closed = once(mac, "close");
    for (let i = 0; i < 4; i += 1) phone.send(Buffer.alloc(2048));
    await closed;
  } finally {
    await f.close();
  }
});

test("the budget refills over time and the Mac recycles before the relay does", () => {
  const empty = refill(0, 30_000, { burstBytes: 1200, refillMs: 60_000 });
  assert.equal(empty, 600, "half a refill window returns half the burst");
  assert.equal(
    refill(1000, 600_000, { burstBytes: 1200, refillMs: 60_000 }),
    1200,
    "the bucket never exceeds its burst",
  );
  assert.ok(
    TUNNEL_LIMITS.idleMs < RELAY_LIMITS.idleMs &&
      TUNNEL_LIMITS.maxSlotMs < RELAY_LIMITS.maxSlotMs,
    "the Mac gives up its tunnel before the relay cuts it",
  );
});
