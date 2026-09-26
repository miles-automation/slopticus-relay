import type { ComputerView } from "../src/inventory.js";
import type { WorkspaceView } from "../src/tenancy.js";
import { escape } from "./html.js";
export function computersHTML(
  computers: ComputerView[],
  canManage = true,
): string {
  const rows = computers
    .map((stored) => {
      const computer = {
        ...stored,
        online: stored.online && Date.now() - (stored.last_seen ?? 0) < 45000,
      };
      computer.sessions = stored.sessions.map((item) => ({
        ...item,
        stale:
          item.stale ||
          !computer.online ||
          Date.now() - item.reported_at >= 45000,
      }));
      const session = (item: ComputerView["sessions"][number]): string =>
        `<li class="inventory-session"><div><strong>${escape(item.project || "Untitled project")}</strong><span class="tag${item.stale ? " off" : ""}">${item.stale && item.activity !== "ended" ? "Unknown · stale" : escape(item.activity)}</span></div><p>${item.provider === "claude" ? "Claude" : "Codex"} · ${escape(item.surface === "unknown" ? "Surface unknown" : item.surface)} · ${escape(item.native.slice(0, 12))}</p><small>Launch ${escape(item.instance.slice(0, 8))} · Last observation ${escape(new Date(item.observed).toLocaleString())} · Observation only</small></li>`;
      const open = computer.sessions.filter((s) => s.activity !== "ended"),
        ended = computer.sessions.filter((s) => s.activity === "ended");
      return `<article class="computer-card"><div class="computer-heading"><h2>${escape(computer.name)}</h2><span class="tag">${computer.revoked ? "Disconnected" : computer.online ? "Computer online" : "Computer offline"}</span>${computer.revoked || !canManage ? "" : `<button class="quiet disconnect-computer" data-id="${escape(computer.id)}">Disconnect</button>`}</div><p class="muted">${computer.last_seen ? `Last report ${escape(new Date(computer.last_seen).toLocaleString())}` : "Waiting for the companion to connect"}</p><p>Coverage: ${computer.coverage === "degraded" ? "Partial: some observations could not be read or exceeded the 200-instance limit." : computer.coverage === "unconnected" ? "Not yet established." : "Instrumented Claude sessions and Slopticus-managed Claude/Codex sessions."} Independently opened Codex sessions and Claude Chat/Cowork are not covered.</p><ul class="inventory-list">${open.map(session).join("") || '<li class="muted">No sessions detected yet. In Slopticus for Mac, choose Enable Claude detection if offered. Claude Code sessions appear on their next activity after detection is enabled. Idle sessions may not appear yet; project or organization settings can restrict hooks.</li>'}</ul>${ended.length ? `<details><summary>${ended.length} ended launches</summary><ul class="inventory-list">${ended.map(session).join("")}</ul></details>` : ""}</article>`;
    })
    .join("");
  return `<main class="computers-pane"><div class="computer-heading"><h1>Computers</h1>${canManage ? '<button id="pair-computer">Connect a computer</button>' : ""}</div><p>See sessions observed on each paired computer. Activity is the last reported state; unknown means Slopticus cannot establish whether the session is still open.</p><p id="status" role="status"></p>${rows || '<div class="empty"><h2>No computers connected yet</h2><p>Download Slopticus for Mac, move it to Applications, and open it. The connection window opens automatically on a new Mac; choose <strong>Connect this Mac</strong> and approve the matching code here.</p><p><a href="https://slopticus.com/download/mac/arm64">Download for Apple silicon</a> · <a href="https://slopticus.com/download/mac/x64">Download for Intel</a></p><p>If you run your own relay, enter this site’s HTTPS address in the Mac connection window.</p></div>'}</main>`;
}
export function wireComputers(
  api: (path: string, body?: unknown) => Promise<unknown>,
  refresh: () => Promise<void>,
  workspaceId?: string,
): void {
  document
    .querySelectorAll<HTMLButtonElement>(".disconnect-computer")
    .forEach((button) => {
      button.onclick = async (): Promise<void> => {
        if (
          !confirm(
            "Disconnect this computer? It stops reporting sessions, and your phone cannot reach it through the relay until you connect it again.",
          )
        )
          return;
        try {
          await api(`computers/${button.dataset.id}/revoke`, {
            workspace_id: workspaceId,
          });
          await refresh();
        } catch (error) {
          document.querySelector("#status")!.textContent = (
            error as Error
          ).message;
        }
      };
    });
  const pairButton =
    document.querySelector<HTMLButtonElement>("#pair-computer");
  if (pairButton)
    pairButton.onclick = (): void => {
      const dialog = document.querySelector<HTMLDialogElement>("#setup")!;
      dialog.innerHTML =
        '<button class="quiet close">Close ×</button><h2>Connect your Mac</h2><p>On the Mac you want to connect, install and open Slopticus. The connection window opens automatically on a new Mac. Enter this relay’s HTTPS address, choose <strong>Connect this Mac</strong>, and approve the matching code when your browser opens here.</p><p><a href="https://slopticus.com/download/mac/arm64">Download for Apple silicon</a> · <a href="https://slopticus.com/download/mac/x64">Download for Intel</a></p><p class="muted">No commands or access keys to copy. For an older single-owner server, the existing owner recovery key is only needed to migrate its computers.</p><p class="muted">Slopticus reports supported coding sessions and activity. Prompts and transcripts stay on your computer.</p>';
      dialog.querySelector<HTMLButtonElement>(".close")!.onclick = (): void => {
        dialog.close();
        void refresh();
      };
      dialog.showModal();
    };
}

export function pairingHTML(
  code: string,
  workspaces: WorkspaceView[] = [],
): string {
  const choices = workspaces
    .map(
      (workspace) =>
        `<option value="${workspace.id}">${escape(workspace.organization_name)} · ${escape(workspace.name)}</option>`,
    )
    .join("");
  return `<main class="computers-pane"><a href="#/computers">← Computers</a><h1>Connect your Mac</h1><p id="pair-description">Checking connection request…</p><p>Approve only if you just chose <strong>Connect this Mac</strong> in Slopticus and this code matches the one shown there:</p><h2>${escape(code.match(/.{1,4}/g)!.join(" "))}</h2>${workspaces.length ? `<label for="pair-workspace">Add this Mac to</label><select id="pair-workspace">${choices}</select>` : "<p>You need an administrator role in a workspace before approving a Mac.</p>"}<p>Slopticus will report supported coding session names and activity. Prompts and transcripts stay on your Mac.</p><button id="approve-computer" disabled>Approve connection</button> <button id="decline-computer" class="quiet" disabled>Decline</button><p id="status" role="status"></p></main>`;
}
export async function wirePairing(
  code: string,
  api: (path: string, body?: unknown) => Promise<unknown>,
): Promise<void> {
  const approve =
    document.querySelector<HTMLButtonElement>("#approve-computer")!;
  const decline =
    document.querySelector<HTMLButtonElement>("#decline-computer")!;
  const status = document.querySelector<HTMLElement>("#status")!;
  try {
    const request = (await api(`computer-pairing/${code}`)) as {
      name: string;
      approved: boolean;
    };
    document.querySelector("#pair-description")!.textContent =
      `${request.name} wants to connect to Slopticus.`;
    if (request.approved) {
      status.textContent =
        "Approved. Return to Slopticus for Mac to finish connecting.";
      return;
    }
    approve.disabled = !document.querySelector("#pair-workspace");
    decline.disabled = !document.querySelector("#pair-workspace");
    const decide = async (allowed: boolean): Promise<void> => {
      approve.disabled = true;
      decline.disabled = true;
      try {
        await api(`computer-pairing/${code}/decision`, {
          approve: allowed,
          workspace_id:
            document.querySelector<HTMLSelectElement>("#pair-workspace")?.value,
        });
        status.textContent = allowed
          ? "Approved. Return to Slopticus for Mac; it finishes setup automatically."
          : "Connection declined. You can close this page.";
      } catch (error) {
        status.textContent = (error as Error).message;
        approve.disabled = false;
        decline.disabled = false;
      }
    };
    approve.onclick = (): void => {
      void decide(true);
    };
    decline.onclick = (): void => {
      void decide(false);
    };
  } catch (error) {
    status.textContent = (error as Error).message;
  }
}
