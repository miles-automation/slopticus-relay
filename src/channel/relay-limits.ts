/** Relay slot policy, shared by the relay that enforces it and the Mac tunnel that lives inside one. */
export type RelayLimits = {
  /** No relayed frame for this long ends the slot. */
  idleMs: number;
  /** Absolute slot lifetime, whatever the traffic. */
  maxSlotMs: number;
  /** Token bucket capacity, and the largest burst a slot may relay at once. */
  burstBytes: number;
  /** Time for an empty bucket to refill to `burstBytes`. */
  refillMs: number;
  /** Keepalive probe interval; a peer that misses one probe is dropped. */
  probeMs: number;
};

export const RELAY_LIMITS: RelayLimits = {
  idleMs: 120_000,
  maxSlotMs: 1_800_000,
  burstBytes: 1024 * 1024,
  refillMs: 60_000,
  probeMs: 25_000,
};

/** The Mac recycles first so the relay never cuts a frame in half. */
export const TUNNEL_LIMITS: RelayLimits = {
  ...RELAY_LIMITS,
  idleMs: RELAY_LIMITS.idleMs - 15_000,
  maxSlotMs: RELAY_LIMITS.maxSlotMs - 60_000,
};

export function refill(
  budget: number,
  since: number,
  limits: Pick<RelayLimits, "burstBytes" | "refillMs">,
): number {
  const gained = (since * limits.burstBytes) / limits.refillMs;
  return Math.min(limits.burstBytes, budget + gained);
}
