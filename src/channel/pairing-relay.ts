import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { RELAY_LIMITS, refill, type RelayLimits } from "./relay-limits.js";

const route = /^\/api\/secure-relay\/([a-f0-9-]{36})\/(mac|phone)$/;
type Slot = {
  mac: WebSocket;
  phone?: WebSocket;
  credential: string;
  expires: number;
  quiet: number;
  budget: number;
  filled: number;
  lifetime?: NodeJS.Timeout;
  idle?: NodeJS.Timeout;
  probed: Set<WebSocket>;
};

export function attachPairingRelay(
  server: Server,
  authenticate: (credential: string) => string | undefined,
  limits: RelayLimits = RELAY_LIMITS,
): { close: () => void } {
  const slots = new Map<string, Slot>();
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
    clientTracking: false,
  });
  const remove = (id: string, slot: Slot, graceful = false): void => {
    if (slots.get(id) !== slot) return;
    slots.delete(id);
    clearTimeout(slot.lifetime);
    clearTimeout(slot.idle);
    for (const peer of [slot.mac, slot.phone]) {
      if (!peer) continue;
      if (graceful && peer.readyState === WebSocket.OPEN) {
        peer.close(1000);
        const deadline = setTimeout(() => peer.terminate(), 1000);
        deadline.unref();
        peer.once("close", () => clearTimeout(deadline));
      } else peer.terminate();
    }
  };
  const expired = (slot: Slot, now: number): boolean =>
    now >= slot.expires || now >= slot.quiet;
  const retire = (id: string, slot: Slot, after: number): NodeJS.Timeout => {
    const timer = setTimeout(() => remove(id, slot, true), after);
    timer.unref();
    return timer;
  };
  // A peer that stops answering probes is dropped, so a half-open socket cannot
  // hold a computer's only slot for the whole idle window.
  const sweep = setInterval(() => {
    for (const [id, slot] of [...slots]) {
      for (const peer of [slot.mac, slot.phone]) {
        if (!peer || peer.readyState !== WebSocket.OPEN) continue;
        if (slot.probed.has(peer)) {
          remove(id, slot);
          break;
        }
        slot.probed.add(peer);
        peer.ping();
      }
    }
  }, limits.probeMs);
  sweep.unref();
  const reject = (socket: Duplex): void => {
    socket.end(
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  };
  const upgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const parsed = route.exec(request.url ?? "");
    if (
      !parsed ||
      request.method !== "GET" ||
      request.headers.origin !== undefined
    ) {
      reject(socket);
      return;
    }
    const id = parsed[1]!,
      side = parsed[2]!;
    const credential = /^Bearer ([^\s]{32,256})$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    const current = slots.get(id);
    if (side === "mac") {
      if (
        !credential ||
        authenticate(credential) !== id ||
        current ||
        slots.size >= 64
      ) {
        reject(socket);
        return;
      }
    } else if (
      !current ||
      current.phone ||
      expired(current, performance.now()) ||
      authenticate(current.credential) !== id
    ) {
      reject(socket);
      return;
    }
    websocket.handleUpgrade(request, socket, head, (peer) => {
      let slot = current;
      if (side === "mac") {
        const now = performance.now();
        const opened: Slot = {
          mac: peer,
          credential: credential!,
          expires: now + limits.maxSlotMs,
          quiet: now + limits.idleMs,
          budget: limits.burstBytes,
          filled: now,
          probed: new Set(),
        };
        opened.lifetime = retire(id, opened, limits.maxSlotMs);
        opened.idle = retire(id, opened, limits.idleMs);
        slot = opened;
        slots.set(id, slot);
      } else {
        slot!.phone = peer;
      }
      const admitted = slot!;
      peer.on("error", () => remove(id, admitted));
      peer.on("pong", () => admitted.probed.delete(peer));
      peer.once("close", (code) => remove(id, admitted, code === 1000));
      peer.on("message", (data, binary) => {
        const target = peer === admitted.mac ? admitted.phone : admitted.mac;
        const size = Array.isArray(data)
          ? data.reduce((sum, part) => sum + part.length, 0)
          : data.byteLength;
        const now = performance.now();
        admitted.budget = refill(
          admitted.budget,
          now - admitted.filled,
          limits,
        );
        admitted.filled = now;
        // Running out of lifetime is the ordinary end of a slot, so it closes
        // cleanly and the peers reconnect. The rest are violations: cut them.
        if (expired(admitted, now)) {
          remove(id, admitted, true);
          return;
        }
        if (
          !binary ||
          size === 0 ||
          size > 65536 ||
          !target ||
          target.readyState !== WebSocket.OPEN ||
          authenticate(admitted.credential) !== id ||
          size > admitted.budget ||
          target.bufferedAmount > 65536
        ) {
          remove(id, admitted);
          return;
        }
        admitted.budget -= size;
        admitted.quiet = now + limits.idleMs;
        clearTimeout(admitted.idle);
        admitted.idle = retire(id, admitted, limits.idleMs);
        peer.pause();
        target.send(data, { binary: true }, (error) => {
          if (error) remove(id, admitted);
          else if (peer.readyState === WebSocket.OPEN) peer.resume();
        });
      });
    });
  };
  server.on("upgrade", upgrade);
  const close = (): void => {
    server.off("upgrade", upgrade);
    clearInterval(sweep);
    for (const [id, slot] of slots) remove(id, slot);
    websocket.close();
  };
  server.once("close", close);
  return { close };
}
