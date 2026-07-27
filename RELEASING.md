# Releasing

Publishing runs in CI via npm **trusted publishing (OIDC)** — no npm token, no
2FA/security-key in the loop. The `.github/workflows/release.yml` workflow
triggers on a version tag, runs the full test suite on Linux + macOS, then
pauses on the `release` environment for a **manual approval** before publishing
with build provenance.

## Per-release flow

1. Bump the version in `package.json` and `src/index.ts` (the `McpServer`
   version), commit, and land on `main` (green CI).
2. Tag and push:
   ```sh
   git tag -a vX.Y.Z -m "terminal-driver-mcp vX.Y.Z: <summary>"
   git push origin vX.Y.Z
   ```
3. The Release workflow starts. Tests run, then the `publish` job waits for
   approval. Open the run in **GitHub → Actions**, click **Review deployments**,
   approve the `release` environment. (Approvable from the GitHub mobile app too
   — no hardware key needed.)
4. CI publishes to npm via OIDC. Done.

The workflow fails fast if the tag doesn't match `package.json` version, so a
mismatched tag can't publish.

## One-time setup

Both are done once and never again.

### 1. npm trusted publisher (on npmjs.com)

npmjs.com → the `terminal-driver-mcp` package → **Settings** → **Trusted
Publisher** → add a **GitHub Actions** publisher:

- Organization / user: `funkyfunc`
- Repository: `terminal-driver-mcp`
- Workflow filename: `release.yml`
- Environment: `release`

(There is no API for this; it must be set in the npmjs.com UI while signed in.)

### 2. GitHub `release` environment with a required reviewer

Repo → **Settings** → **Environments** → **New environment** → `release` → add
yourself under **Required reviewers**. This is what turns the publish into a
one-click approval. (Can also be created via `gh api`; see the setup commit.)

## Notes

- Needs npm ≥ 11.5.1 in the runner for OIDC; the workflow upgrades npm
  explicitly since `actions/setup-node` ships an older version.
- Provenance requires a public repo (this one is) and `id-token: write`.
- Legacy 2FA-bypass automation tokens are being restricted by npm
  (Aug 2026 / Jan 2027); OIDC is the future-proof path and needs no stored
  secret.
- Local `npm publish` from a laptop still works as a fallback, but requires the
  interactive security-key/Touch ID step — prefer the CI path.
