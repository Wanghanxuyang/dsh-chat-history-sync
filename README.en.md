# Chat History Sync

Free. Pull a DeepSeek account's chat history from the web and mobile app into DeepSeek Harness as native sessions, organized by month and ready to continue.

## What it does

DeepSeek keeps chats in the web app and mobile app, but DSH cannot see them or continue them. This plugin imports the same account's chats into DSH, stores them by month, and lets you open and continue each one.

## Features

- One account, both clients: web and mobile-app history come from the same DeepSeek account; multiple accounts supported
- Months only: DSH workspaces are monthly, not split by category
- Report and catalog: every sync writes a report; a category catalog adds a 50–100 character summary per chat
- Append-only: same-title chats with different content are kept; backups before install; DSH-created sessions are never touched
- Local tokens: encrypted with Windows DPAPI, never shown in the UI, never uploaded

## Install

Requirements: Windows 10/11, DSH 0.2.x.

```powershell
dsh plugin add dsh-chat-history-sync
```

Then open **Settings → Chat History Sync → Log in → Sync now**.

## Data

- Chat data stays in the local DSH workspace
- Sync only talks to `chat.deepseek.com`
- Tokens stay on this machine, encrypted with DPAPI
- No telemetry, no model calls; summaries are generated locally and free

## Scope

Windows only. Not an official DeepSeek plugin.
