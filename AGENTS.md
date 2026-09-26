# Slopticus Relay

Standalone relay, account and workspace service. Agent execution, prompts,
transcripts, endpoint identity keys and workflow plug-ins belong on clients.
The relay forwards opaque traffic; preserve that boundary.

Use TypeScript strict mode and complete annotations for new code. Do not add
explanatory internal comments. Document external API contracts in docs.

Run `make check`, `make test` and `make build` before review. Authorization,
pairing, migration and persistence changes require behavioral tests. Never
replace independent review or physical client testing with a passing build.

Keep the initial extraction behavior compatible with Slopticus 0.15.0 and
protocol 1. Version future protocol changes independently from app releases.
Check docs/extraction.md before making a release or changing deployment.
