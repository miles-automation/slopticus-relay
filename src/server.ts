import { attachPairingRelay } from "./channel/pairing-relay.js";
import { InventoryStore } from "./inventory.js";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Store } from "./store.js";
import { createApp } from "./app.js";
import { ApnsSender, apnsConfigFromEnv } from "./apns.js";

const port = Number(process.env.PORT ?? 8787);
const path = resolve(process.env.SLOPTICUS_DB ?? "data/slopticus.sqlite");
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const store = new Store(path);
const origin = process.env.SLOPTICUS_ORIGIN ?? `http://localhost:${port}`;
const apns = apnsConfigFromEnv(process.env);
const push = (() => {
  if (!apns) return undefined;
  try {
    return new ApnsSender(apns);
  } catch (error) {
    console.error(
      `Push notifications are off: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
})();
const app = createApp(store, {
  origin,
  publicSignup: process.env.SLOPTICUS_PUBLIC_SIGNUP === "1",
  publicDir: resolve("public"),
  releasesDir: resolve(
    process.env.SLOPTICUS_RELEASES ?? resolve(dirname(path), "releases"),
  ),
  push,
});
const server = app.listen(port, process.env.HOST ?? "127.0.0.1", () =>
  console.log(`Slopticus listening at ${origin}`),
);
const inventory = new InventoryStore(store.db);
const securePairing =
  process.env.SLOPTICUS_SECURE_PAIRING === "1"
    ? attachPairingRelay(server, (credential) =>
        inventory.authenticate(credential),
      )
    : undefined;
process.once("SIGTERM", () => {
  securePairing?.close();
  push?.close();
  server.close(() => process.exit(0));
});
