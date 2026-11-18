# Release checklist

1. Run `npm test` and `npm run test:e2e` in `tools/plugin-memory-sync`.
2. Run `npm run check:sessions` on a real profile when possible.
3. Verify `npm pack --dry-run` includes:
   - `lib/browser/login-save.mjs`
   - `lib/engine/install.cjs`
   - `SECURITY.md`
4. Stage with `npm stage publish --access public`.
5. Approve the exact staged version in npm Staged Packages with the security key.
6. Verify:
   - `npm view dsh-chat-history-sync version` matches the approved version
   - GitHub source contains the same `package.json` version
7. Reject older staged versions or leave them unapproved; never approve a stale stage.

## Rollback

The installer backs up `workspace.json` and changed session files before writing. If an install fails, keep the generated `install-result.json` and the `sessions-backup-*` directory; do not delete them before inspecting.
