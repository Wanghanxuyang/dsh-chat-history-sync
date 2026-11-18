# Security

## Data collected

- DeepSeek chat history, account display name/avatar, and a DPAPI-encrypted token
- No phone number, email address, analytics, or telemetry
- Accounts are matched by `userId` / token only

## Local storage

- Runtime data stays in the DSH profile's `.dsh-chat-history-sync` directory
- Tokens are stored as Windows DPAPI `tokenEnc`; plaintext `token`, `phone`, and `email` are removed on load/save
- `run-config.json` and `login-result.json` are deleted at startup; stale temporary Edge profiles are removed after 30 minutes
- Diagnostic export contains counts and status only, not logs, account names, tokens, or phone numbers

## Network

- Sync and login only contact `chat.deepseek.com` and DeepSeek file hosts
- No model calls
- No telemetry endpoint

## Reporting

Open an issue at the public repository. Do not include tokens, phone numbers, account names, or chat contents in a public report.
