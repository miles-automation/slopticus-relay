# Extraction record

Initial source: Slopticus revision
`6a61d64b84bf0bd8e2221d214f26c8827aca7ef4` (application version 0.15.0,
protocol 1). Imported through an explicit file list without private repository
history. The source carried the Unlicense, preserved in `LICENSES/Unlicense.txt`.
The owner selected Apache-2.0 for the public relay on 2026-09-26. Prior rights
are not withdrawn. No author identities were invented or removed.

The extraction includes relay HTTP/WebSocket services, account/workspace and
inventory persistence, the management website, API contracts and relay tests.
It excludes Mac/iPhone sources, local agent providers, desktop session UI,
app signing, production configuration, credentials and private history.

Tests that combine client CLI behavior with server behavior are split at the
test boundary: server cases are retained here; client-only cases remain in the
application repository. The import should not change server authorization,
schema or wire behavior. Node dependencies and web entrypoints are scoped to
the relay.

This source repository is prepared before the hosted cutover. The application
repository remains the deployment source until its migration PR is reviewed
and verified. The first public image built here must use a new tag because the
existing 0.15.0 image came from the private application's broader build.

Cutover acceptance: build from a public checkout; verify protocol 1 client
compatibility and migrations; publish an anonymously pullable image linked to
its exact public commit; move hosted deployment to that image; separate Mac
release discovery from relay version discovery; remove duplicate relay build
ownership in the private application; verify production and cleanup.
