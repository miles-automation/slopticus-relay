import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Http2Server } from "node:http2";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import type { Server } from "node:http";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";
import { InventoryStore } from "../src/inventory.js";
import {
  ApnsSender,
  apnsConfigFromEnv,
  apnsKey,
  type ApnsEnvironment,
} from "../src/apns.js";
import { createTestWorkspace } from "./workspace.js";

type Delivery = {
  host: ApnsEnvironment;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};
type Reply = { status: number; reason?: string };

const pem = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const tokenA = "a".repeat(64);
const tokenB = "b".repeat(64);
const tokenC = "c".repeat(64);
const session = "11111111-1111-4111-8111-111111111111";

async function fakeApns(
  reply: (delivery: Delivery) => Reply = () => ({ status: 200 }),
) {
  const deliveries: Delivery[] = [];
  const servers: Http2Server[] = [];
  const hosts = {} as Record<ApnsEnvironment, string>;
  for (const host of ["sandbox", "production"] as const) {
    const server = createServer((request, response) => {
      let text = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (text += chunk));
      request.on("end", () => {
        const delivery: Delivery = {
          host,
          path: String(request.headers[":path"]),
          headers: request.headers,
          body: JSON.parse(text),
        };
        deliveries.push(delivery);
        const answer = reply(delivery);
        response.writeHead(answer.status, {
          "content-type": "application/json",
        });
        response.end(
          answer.reason ? JSON.stringify({ reason: answer.reason }) : "",
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    servers.push(server);
    hosts[host] =
      `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  return {
    deliveries,
    hosts,
    close: () =>
      Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      ),
  };
}

const config = {
  key: pem,
  keyId: "KEYID12345",
  teamId: "TEAMID1234",
  topic: "com.slopticus.phone",
};

async function relay(push: ApnsSender | undefined) {
  const store = new Store(":memory:");
  const inventory = new InventoryStore(store.db);
  const workspace = createTestWorkspace(store.db);
  const work = inventory.pair("Work", undefined, workspace);
  const home = inventory.pair("Home", undefined, workspace);
  const server: Server = createApp(store, {
    origin: "http://localhost",
    push,
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, key: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  return {
    base,
    work,
    home,
    inventory,
    post,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

const notice = (kind = "needs_you", sessionId = session) => ({
  session_id: sessionId,
  kind,
  agent: "Claude",
  project: "sturdy",
});

test("the APNs provider token is an ES256 JWT that is reused for 50 minutes and then renewed", () => {
  let now = 1_800_000_000_000;
  const sender = new ApnsSender(config, { now: () => now });
  const first = sender.bearer();
  const [header, claims, signature] = first.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), {
    alg: "ES256",
    kid: "KEYID12345",
  });
  assert.deepEqual(JSON.parse(Buffer.from(claims!, "base64url").toString()), {
    iss: "TEAMID1234",
    iat: 1_800_000_000,
  });
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: createPublicKey(pem), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url"),
    ),
  );
  now += 49 * 60_000;
  assert.equal(sender.bearer(), first);
  now += 2 * 60_000;
  assert.notEqual(sender.bearer(), first);
});

test("the APNs key loads from PEM, escaped newlines or base64, and settings come from the environment", () => {
  assert.equal(apnsKey(pem).asymmetricKeyType, "ec");
  assert.equal(apnsKey(pem.replace(/\n/g, "\\n")).asymmetricKeyType, "ec");
  assert.equal(
    apnsKey(Buffer.from(pem).toString("base64")).asymmetricKeyType,
    "ec",
  );
  assert.equal(apnsConfigFromEnv({ SLOPTICUS_APNS_KEY_P8: pem }), undefined);
  assert.deepEqual(
    apnsConfigFromEnv({
      SLOPTICUS_APNS_KEY_P8: pem,
      SLOPTICUS_APNS_KEY_ID: " KEYID12345 ",
      SLOPTICUS_APNS_TEAM_ID: "TEAMID1234",
      SLOPTICUS_APNS_TOPIC: "com.slopticus.phone",
    }),
    config,
  );
});

test("a relay without APNs settings says so and refuses notices without failing registration", async () => {
  const r = await relay(undefined);
  try {
    assert.deepEqual(await (await fetch(`${r.base}/api/config`)).json(), {
      public_signup: false,
      push: false,
    });
    const registered = await r.post(
      "/api/computer/push/devices",
      r.work.token,
      {
        devices: [{ token: tokenA, environment: "sandbox" }],
      },
    );
    assert.deepEqual(await registered.json(), { ok: true, push: false });
    assert.equal(
      (await r.post("/api/computer/push/notify", r.work.token, notice()))
        .status,
      503,
    );
  } finally {
    await r.close();
  }
});

test("registered tokens are routed to the APNs host of their environment with only agent and project in the alert", async () => {
  const apns = await fakeApns();
  const sender = new ApnsSender(config, { hosts: apns.hosts });
  const r = await relay(sender);
  try {
    assert.equal(
      (await (await fetch(`${r.base}/api/config`)).json()).push,
      true,
    );
    assert.equal(
      (
        await r.post("/api/computer/push/devices", "k".repeat(43), {
          devices: [{ token: tokenA, environment: "sandbox" }],
        })
      ).status,
      401,
    );
    const registered = await r.post(
      "/api/computer/push/devices",
      r.work.token,
      {
        devices: [
          { token: tokenA, environment: "sandbox" },
          { token: tokenB, environment: "production" },
        ],
      },
    );
    assert.equal(registered.status, 200);
    const outcome = await (
      await r.post("/api/computer/push/notify", r.work.token, notice())
    ).json();
    assert.deepEqual(outcome, { sent: 2, pruned: [], dropped: null });
    const byToken = new Map(
      apns.deliveries.map((delivery) => [delivery.path, delivery]),
    );
    assert.equal(byToken.get(`/3/device/${tokenA}`)?.host, "sandbox");
    assert.equal(byToken.get(`/3/device/${tokenB}`)?.host, "production");
    const delivery = byToken.get(`/3/device/${tokenA}`)!;
    assert.equal(delivery.headers["apns-topic"], "com.slopticus.phone");
    assert.equal(delivery.headers["apns-push-type"], "alert");
    assert.equal(delivery.headers["apns-collapse-id"], session);
    assert.match(
      String(delivery.headers.authorization),
      /^bearer [\w-]+\.[\w-]+\.[\w-]+$/,
    );
    assert.deepEqual(delivery.body, {
      aps: {
        alert: { body: "Claude in sturdy needs you" },
        sound: "default",
        "thread-id": session,
      },
      slopticus: { computer: r.work.id, session, kind: "needs_you" },
    });
  } finally {
    await r.close();
    sender.close();
    await apns.close();
  }
});

test("a notice carrying message text is rejected before anything reaches APNs", async () => {
  const apns = await fakeApns();
  const sender = new ApnsSender(config, { hosts: apns.hosts });
  const r = await relay(sender);
  try {
    await r.post("/api/computer/push/devices", r.work.token, {
      devices: [{ token: tokenA, environment: "sandbox" }],
    });
    for (const body of [
      { ...notice(), text: "Deploy the secret branch?" },
      { ...notice(), message: "hello" },
      { ...notice(), agent: "x".repeat(41) },
      { ...notice(), kind: "assistant.message" },
    ])
      assert.equal(
        (await r.post("/api/computer/push/notify", r.work.token, body)).status,
        400,
      );
    assert.equal(apns.deliveries.length, 0);
  } finally {
    await r.close();
    sender.close();
    await apns.close();
  }
});

test("a computer only notifies its own phones, and a revoked computer notifies nobody", async () => {
  const apns = await fakeApns();
  const sender = new ApnsSender(config, { hosts: apns.hosts });
  const r = await relay(sender);
  try {
    await r.post("/api/computer/push/devices", r.work.token, {
      devices: [{ token: tokenA, environment: "sandbox" }],
    });
    const other = await (
      await r.post("/api/computer/push/notify", r.home.token, notice())
    ).json();
    assert.deepEqual(other, { sent: 0, pruned: [], dropped: "no_devices" });
    assert.equal(apns.deliveries.length, 0);
    r.inventory.revoke(r.work.id);
    assert.equal(
      (await r.post("/api/computer/push/notify", r.work.token, notice()))
        .status,
      401,
    );
    assert.equal(apns.deliveries.length, 0);
  } finally {
    await r.close();
    sender.close();
    await apns.close();
  }
});

test("tokens APNs reports as gone or bad are pruned and other failures keep the token", async () => {
  const apns = await fakeApns((delivery) => {
    if (delivery.path.endsWith(tokenA))
      return { status: 410, reason: "Unregistered" };
    if (delivery.path.endsWith(tokenB))
      return { status: 400, reason: "BadDeviceToken" };
    return { status: 500, reason: "InternalServerError" };
  });
  const sender = new ApnsSender(config, { hosts: apns.hosts });
  const r = await relay(sender);
  try {
    await r.post("/api/computer/push/devices", r.work.token, {
      devices: [
        { token: tokenA, environment: "sandbox" },
        { token: tokenB, environment: "production" },
        { token: tokenC, environment: "production" },
      ],
    });
    const outcome = (await (
      await r.post("/api/computer/push/notify", r.work.token, notice())
    ).json()) as { sent: number; pruned: string[] };
    assert.equal(outcome.sent, 0);
    assert.deepEqual([...outcome.pruned].sort(), [tokenA, tokenB]);
    apns.deliveries.length = 0;
    await r.post("/api/computer/push/notify", r.work.token, notice("finished"));
    assert.deepEqual(
      apns.deliveries.map((delivery) => delivery.path),
      [`/3/device/${tokenC}`],
    );
  } finally {
    await r.close();
    sender.close();
    await apns.close();
  }
});

test("repeat notices for one session coalesce and a burst from one computer is capped", async () => {
  const apns = await fakeApns();
  const sender = new ApnsSender(config, { hosts: apns.hosts });
  const r = await relay(sender);
  try {
    await r.post("/api/computer/push/devices", r.work.token, {
      devices: [{ token: tokenA, environment: "sandbox" }],
    });
    const send = async (body: unknown) =>
      (
        (await (
          await r.post("/api/computer/push/notify", r.work.token, body)
        ).json()) as { dropped: string | null }
      ).dropped;
    assert.equal(await send(notice()), null);
    assert.equal(await send(notice()), "coalesced");
    const outcomes: Array<string | null> = [];
    for (let index = 0; index < 8; index++)
      outcomes.push(
        await send(
          notice(
            "finished",
            `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
          ),
        ),
      );
    assert.deepEqual(outcomes.slice(0, 5), [null, null, null, null, null]);
    assert.ok(outcomes.slice(5).every((outcome) => outcome === "limited"));
    assert.equal(apns.deliveries.length, 6);
  } finally {
    await r.close();
    sender.close();
    await apns.close();
  }
});

test("an expired provider token is replaced and the push retried once", async () => {
  let rejected = false;
  const apns = await fakeApns(() => {
    if (!rejected) {
      rejected = true;
      return { status: 403, reason: "ExpiredProviderToken" };
    }
    return { status: 200 };
  });
  const sender = new ApnsSender(config, { hosts: apns.hosts });
  try {
    const result = await sender.send(tokenA, "production", {
      body: "Claude in sturdy finished",
      collapseId: session,
      threadId: session,
      data: {},
    });
    assert.deepEqual(result, { status: 200, reason: null });
    assert.equal(apns.deliveries.length, 2);
    assert.notEqual(
      apns.deliveries[0]!.headers.authorization,
      apns.deliveries[1]!.headers.authorization,
    );
  } finally {
    sender.close();
    await apns.close();
  }
});
