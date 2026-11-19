# Security

## Data collected

- DeepSeek chat history, account display name/avatar, and a DPAPI-encrypted token
- No phone number, email address, analytics, or telemetry
- Accounts are matched by `userId` / token only

## Local storage

- Runtime data stays in the DSH profile's `.dsh-chat-history-sync` directory
- Tokens are stored as Windows DPAPI `tokenEnc`; plaintext `token`, `phone`, and `email` are removed on load/save
- During a sync child process, `run-config.json` temporarily contains the decrypted account tokens; it is deleted after the child exits and again at startup if the host crashed. It is local-only and never uploaded.
- During login, `login-result.json` may temporarily contain the browser token; the host deletes it immediately after reading, and startup cleanup removes any leftover file. It is never uploaded or logged.
- `run-config.json` and `login-result.json` are deleted at startup; stale temporary Edge profiles are removed after 30 minutes
- Diagnostic export contains counts and status only, not logs, account names, tokens, or phone numbers

## Removing an account

- Removing an account stops future sync and removes the account entry/token from the plugin config
- Archived conversations and attachments are kept; delete them manually if required
- This is intentional: the plugin is append-only and does not silently destroy history

## Network

- Sync and login only contact `chat.deepseek.com` and DeepSeek file hosts
- No model calls
- No telemetry endpoint

## Reporting

Open an issue at the public repository. Do not include tokens, phone numbers, account names, or chat contents in a public report.
