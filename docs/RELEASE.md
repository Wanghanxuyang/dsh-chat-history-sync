# Release checklist

1. Run `npm test`, `npm run test:e2e`, `npm run test:sandbox`, and `npm run test:package` in `tools/plugin-memory-sync`.
2. Run `npm run check:sessions` on a real profile when possible.
3. Verify `npm pack --dry-run` includes:
   - `lib/browser/login-save.mjs`
   - `lib/engine/install.cjs`
   - `lib/import-state.cjs`
   - `SECURITY.md`
   - `docs/RELEASE.md`
4. Confirm `importPhase` / report-failure / first-use tests pass before staging.
5. Stage with `npm stage publish --access public`.
6. Approve the exact staged version in npm Staged Packages with the security key.
7. Verify:
   - `npm view dsh-chat-history-sync version` matches the approved version
   - GitHub source contains the same `package.json` version
8. Reject older staged versions or leave them unapproved; never approve a stale stage.

## Rollback

The importer backs up `workspace.json` and changed session files before writing. If an import fails, keep `install-result.json`, `install-public.log`, and the `sessions-backup-*` directory; do not delete them before inspecting.
