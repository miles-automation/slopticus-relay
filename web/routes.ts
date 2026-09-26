export type PublicView =
  | { kind: "landing" }
  | { kind: "self-host" }
  | { kind: "computers" }
  | { kind: "pair-computer"; code: string };

export function viewForHash(hash: string): PublicView {
  if (hash === "#/self-host") return { kind: "self-host" };
  const pairing = /^#\/connect-computer\/([A-F0-9]{12})$/.exec(hash);
  if (pairing) return { kind: "pair-computer", code: pairing[1] };
  if (hash === "#/manage" || hash === "#/computers") {
    return { kind: "computers" };
  }
  return { kind: "landing" };
}

export function loginContextForHash(
  hash: string,
): "console" | "computer-approval" {
  return viewForHash(hash).kind === "pair-computer"
    ? "computer-approval"
    : "console";
}

export async function resultForCurrentHash<T>(
  requestedHash: string,
  currentHash: () => string,
  request: () => Promise<T>,
): Promise<T | undefined> {
  const result = await request();
  return currentHash() === requestedHash ? result : undefined;
}
