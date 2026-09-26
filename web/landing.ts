export const APPLE_SILICON_DOWNLOAD =
  "https://slopticus.com/download/mac/arm64";
export const INTEL_DOWNLOAD = "https://slopticus.com/download/mac/x64";

export function landingHTML(signupEnabled = true, officialSite = true): string {
  return `<div class="landing-shell">
    <nav class="landing-nav" aria-label="Main navigation">
      <a class="brand" href="#/"><span class="mark"></span>Slopticus</a>
      <div class="landing-nav-links">
        <a href="#what-is-slopticus">What it is</a>
        <a href="#ways-to-run">Hosted or self-hosted</a>
        <a href="#/self-host">Self-host guide</a>
        <a href="#download">Download</a>
        <a class="nav-manage" href="#/manage">Manage your Slopticus</a>
      </div>
    </nav>
    <main class="landing-main">
      <section class="landing-hero" aria-labelledby="landing-title">
        <div class="hero-copy">
          <p class="eyebrow">A Mac workspace with secure iPhone access</p>
          <h1 id="landing-title">Your coding agents.<br><span>Within reach.</span></h1>
          <p class="hero-intro">Run Claude Code and Codex on your Mac, keep every conversation on that computer, and securely pick up the same sessions from your iPhone.</p>
          <div class="hero-actions">
            <a class="cta" href="${APPLE_SILICON_DOWNLOAD}">Download for Apple silicon</a>
            <a class="cta secondary-link" href="${INTEL_DOWNLOAD}">Download for Intel</a>
          </div>
          <p class="download-note">Signed and notarized for macOS. Not sure which Mac you have? Open <strong>Apple menu → About This Mac</strong> and check the Chip or Processor.</p>
        </div>
        <div class="hero-signal" aria-hidden="true">
          <span class="signal-label">Mac</span>
          <div class="signal-line"><i></i><i></i><i></i></div>
          <span class="signal-core"><span class="mark"></span></span>
          <div class="signal-line reverse"><i></i><i></i><i></i></div>
          <span class="signal-label">iPhone</span>
        </div>
      </section>

      <section id="what-is-slopticus" class="landing-section product-story">
        <div>
          <p class="section-kicker">What is Slopticus?</p>
          <h2>One workspace for the agents already on your Mac.</h2>
        </div>
        <div class="story-grid">
          <article><span>01</span><h3>Work on your Mac</h3><p>Start and steer Claude Code and Codex sessions in a focused desktop workspace built for parallel work.</p></article>
          <article><span>02</span><h3>Take the thread with you</h3><p>Pair an iPhone to read sessions, send replies, and answer agent questions and approvals while your Mac stays in control.</p></article>
          <article><span>03</span><h3>Keep the relay blind</h3><p>Your agent credentials and conversation content stay on your Mac. The relay forwards encrypted phone traffic it cannot read.</p></article>
        </div>
      </section>

      <section id="ways-to-run" class="landing-section">
        <p class="section-kicker">Choose where the relay runs</p>
        <h2>${officialSite ? "Use our infrastructure, or control your own." : "Use this relay, or run another one."}</h2>
        <div class="run-grid">
          <article class="run-card hosted-card">
            <span class="run-tag">${officialSite ? "Hosted" : "Current server"}</span>
            <h3>${officialSite ? "Hosted by Slopticus" : "This relay"}</h3>
            <p>${officialSite ? (signupEnabled ? "Use the managed relay at slopticus.com. Create your account and private workspace in the browser, then invite people into shared team workspaces when you need them." : "The managed relay is being upgraded for individual accounts and shared team workspaces. Existing users can sign in while new account creation is temporarily closed.") : signupEnabled ? "Create an account and private workspace on this server, then invite people into shared team workspaces when you need them. No Slopticus-hosted account is required." : "Sign in to this server to manage its computers and workspaces. New account creation is closed by its administrator."} The relay still stores no conversation content.</p>
            <a class="text-link" href="#/manage">${signupEnabled ? "Create an account or sign in" : "Sign in"} →</a>
          </article>
          <article class="run-card self-host-card">
            <span class="run-tag">Self-hosted</span>
            <h3>Run it on your infrastructure</h3>
            <p>Operate the relay behind HTTPS with persistent SQLite storage. Create accounts and workspaces on your own server, then enter that relay's address in the Mac app. Mac and iPhone pairing use your server, not Slopticus infrastructure.</p>
            <p class="availability">The relay is open source under Apache 2.0. Build it from the public repository; your account and data live on your server.</p>
            <a class="text-link" href="#/self-host">Self-hosting guide →</a>
          </article>
        </div>
      </section>

      <section id="download" class="landing-section download-section">
        <div>
          <p class="section-kicker">Get Slopticus for Mac</p>
          <h2>Download, drag, connect.</h2>
        </div>
        <ol class="install-steps">
          <li><span>1</span><div><h3>Download the right build</h3><p>Choose Apple silicon for an M-series Mac, or Intel for an Intel processor.</p><p><a href="${APPLE_SILICON_DOWNLOAD}">Apple silicon download</a> · <a href="${INTEL_DOWNLOAD}">Intel download</a></p></div></li>
          <li><span>2</span><div><h3>Install the app</h3><p>Open the disk image and drag Slopticus into Applications. Managed work computers may require IT approval.</p></div></li>
          <li><span>3</span><div><h3>Connect your Mac</h3><p>On first launch, the connection window opens. ${officialSite ? 'Keep <strong>slopticus.com</strong> for hosted service or enter <a href="#/self-host">your relay\'s HTTPS address</a>.' : "Replace the default slopticus.com address with this server's HTTPS address."} Choose <strong>Connect this Mac</strong>; the browser handles ${signupEnabled ? "account creation or sign-in" : "sign-in"} and approval. No access key is needed for a new account.</p></div></li>
          <li><span>4</span><div><h3>Pair your iPhone</h3><p>After the Mac is connected, choose <strong>Pair iPhone…</strong>. The iPhone app is not yet available for general download.</p></div></li>
        </ol>
      </section>

      <section class="owner-entry">
        <div><p class="section-kicker">Your Slopticus</p><h2>Manage your workspaces.</h2><p>${signupEnabled ? "Create an account, " : "Sign in, "}approve a Mac, invite a teammate to a shared workspace, or manage connected computers.</p></div>
        <a class="cta secondary-link" href="#/manage">Open workspaces</a>
      </section>
    </main>
    <footer class="landing-footer"><a class="brand" href="#/"><span class="mark"></span>Slopticus</a><p>Your coding account and conversations stay on your computer.</p></footer>
  </div>`;
}
