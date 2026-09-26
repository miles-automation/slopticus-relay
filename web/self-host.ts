export const SELF_HOST_SOURCE =
  "https://github.com/miles-automation/slopticus-relay.git";
export const SELF_HOST_REF = "v0.15.0";

export function selfHostHTML(): string {
  return `<div class="landing-shell">
    <nav class="landing-nav" aria-label="Main navigation"><a class="brand" href="#/"><span class="mark"></span>Slopticus</a><div class="landing-nav-links"><a href="#/">Overview</a><a href="https://slopticus.com/download/mac/arm64">Download for Mac</a></div></nav>
    <main class="landing-main self-host-guide">
      <p class="section-kicker">Self-host Slopticus</p>
      <h1>Your relay, your infrastructure.</h1>
      <p class="hero-intro">The Mac app runs your agents and keeps their conversations local. Your relay manages accounts, workspaces, computer approval, and encrypted phone traffic. Neither the Mac nor iPhone needs a Slopticus-hosted account when connected to your relay.</p>
      <div class="run-grid"><article class="run-card"><h2>Before you start</h2><ul><li>A server with Git, Docker Compose, and a domain you control</li><li>DNS for that domain pointed at the server</li><li>Ports 80 and 443 open for automatic HTTPS</li><li>A persistent local disk for the relay database</li></ul></article><article class="run-card"><h2>Security boundary</h2><p>The relay can see account names, workspace membership, computer names, and connection metadata. It forwards encrypted phone traffic but cannot read prompts or transcripts. Anyone who can reach a server with public signup enabled can create an account; restrict the server at your edge if that is not what you want.</p><p>The distributed Mac app checks the official Slopticus update feed separately. That check is not needed for your relay connection.</p></article></div>
      <section class="landing-section"><h2>1. Get the open-source relay</h2><p>The relay is available under Apache 2.0. Build it on your server without registry credentials:</p><pre><code>git clone ${SELF_HOST_SOURCE}
cd slopticus-relay
git checkout ${SELF_HOST_REF}</code></pre><p>Replace <code>relay.example.com</code> everywhere below with your own public HTTPS hostname. Save this as <code>compose.yaml</code> in the cloned directory:</p><pre><code>services:
  relay:
    build: .
    restart: unless-stopped
    environment:
      SLOPTICUS_ORIGIN: https://relay.example.com
      SLOPTICUS_PUBLIC_SIGNUP: "1"
      SLOPTICUS_SECURE_PAIRING: "1"
    volumes:
      - ./data:/app/data
    expose:
      - "8787"
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    depends_on:
      - relay
volumes:
  caddy_data:</code></pre><p>Save this as <code>Caddyfile</code> in the same directory:</p><pre><code>relay.example.com {
  reverse_proxy relay:8787
}</code></pre></section>
      <section class="landing-section"><h2>2. Start and verify</h2><p>Create the data directory for the container's non-root user (UID 1000), then start the stack:</p><pre><code>mkdir -p data
sudo chown 1000:1000 data
docker compose up -d --build
curl https://relay.example.com/healthz
curl https://relay.example.com/api/config</code></pre><p>The health endpoint should answer successfully, and the configuration should say <code>"public_signup":true</code>. Wait for DNS and HTTPS certificate issuance if the first request fails.</p></section>
      <section class="landing-section"><h2>3. Create an account and connect your Mac</h2><ol><li>Open <code>https://relay.example.com/#/manage</code>. Create an account with a password you choose; save the one-time recovery code in a password manager.</li><li><a href="https://slopticus.com/download/mac/arm64">Download the Apple silicon Mac app</a> or <a href="https://slopticus.com/download/mac/x64">download the Intel build</a>. Install it in Applications.</li><li>On first launch, the connection window opens. Enter <code>https://relay.example.com</code>, choose <strong>Connect this Mac</strong>, and approve the matching code in your browser on that same server.</li><li>When the Mac shows Connected, choose <strong>Pair iPhone…</strong>. Confirm that the iPhone displays your relay's address before accepting the invitation. The iPhone app is not yet available for general download.</li></ol><p>You never enter an access key for a new server. A legacy owner recovery key is only for migrating an older single-owner installation.</p></section>
      <section class="landing-section"><h2>Operate it safely</h2><ul><li>Run one relay instance. SQLite on a shared network filesystem or multiple replicas is not supported.</li><li>Back up the <code>data</code> directory and test a restore. It contains accounts, recovery state, workspaces, computer credentials, and pairing records.</li><li>Pin a reviewed relay Git tag or commit, and retain the prior image and database backup for rollback. Never roll back a multi-tenant database to a pre-tenancy image.</li><li>Create shared workspaces and invite members from <strong>Workspaces</strong>. Workspace access does not by itself pair a phone or reveal encrypted conversations.</li></ul></section>
      <p><a class="text-link" href="#/">← Back to Slopticus</a></p>
    </main>
  </div>`;
}
