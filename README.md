# whatsapp-mcp-server

A local, always-on [MCP](https://modelcontextprotocol.io) server that connects WhatsApp to Claude Code (or any MCP-compatible client) using [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web multi-device protocol).

All session data (device link, message history, downloaded media) is stored **outside** this repo in `~/.whatsapp-mcp/`, so the repo itself never contains secrets and is safe to clone/fork/publish.

## Platform support

| Platform | Status | Notes |
|---|---|---|
| Linux | ✅ Supported & tested | Prebuilt native binaries, no compiler needed |
| macOS | ✅ Supported | Prebuilt native binaries (Intel & Apple Silicon), no compiler needed |
| Windows | ✅ Supported | Prebuilt native binaries; `cross-spawn` is used for ffmpeg so it resolves correctly on Windows PATH |

The only native dependency is `better-sqlite3`, which ships prebuilt binaries for all three platforms — no C/C++ compiler is required in the common case.

## Tools

`send_message`, `send_file`, `send_audio_message`, `download_media`, `search_contacts`, `list_chats`, `list_messages`, `get_message_context`, `get_last_interaction`, `get_direct_chat_by_contact`, `get_contact_chats`, `list_groups`, `get_group_info`, `get_unanswered_messages`, `check_connection_status`.

`get_unanswered_messages` surfaces 1-on-1 chats whose last message is unanswered for longer than a configurable threshold (groups are intentionally excluded). The server also fires a native desktop notification for this on its own (checked every 5 minutes), independent of whether a Claude Code session is open.

## 1. Install

Requires Node.js 20+.

```bash
git clone https://github.com/Jochem-van-Appeldoorn/whatsapp-mcp-server.git
cd whatsapp-mcp-server
npm install
npm run build
```

### Optional: ffmpeg (for voice notes)

`send_audio_message` converts audio to ogg/opus automatically so it arrives as a playable WhatsApp voice note. Without ffmpeg the file is still sent, but as a regular audio attachment instead of a voice note.

- **Linux (Debian/Ubuntu)**: `sudo apt install ffmpeg`
- **Linux (Fedora)**: `sudo dnf install ffmpeg`
- **macOS**: `brew install ffmpeg`
- **Windows**: `choco install ffmpeg` (or `winget install ffmpeg`, or install manually and add it to `PATH`)

## 2. First-time pairing (QR code)

Must run interactively in the foreground once, identical on every platform:

```bash
npm run dev
```

Scan the QR code shown in the terminal with WhatsApp: **Settings → Linked devices → Link a device**. Once paired, the session is stored in `~/.whatsapp-mcp/auth/` and you won't need to scan again (unless you unlink the device from your phone).

Stop the foreground process (Ctrl+C) once you see `WhatsApp verbonden als ...` / `WhatsApp connected as ...`.

## 3. Run always-on with PM2

[PM2](https://pm2.keymetrics.io/) is used as a cross-platform process manager (auto-restart on crash, start on boot), so there's no need to maintain separate systemd/launchd/Windows Service configs per OS.

```bash
npm install -g pm2
cd whatsapp-mcp-server
pm2 start dist/index.js --name whatsapp-mcp
pm2 save
pm2 startup   # prints a one-time command to enable PM2 on boot
```

`pm2 startup` detects the platform itself (systemd on Linux, launchd on macOS, a scheduled task on Windows) and prints the right follow-up command to run.

Useful commands:
```bash
pm2 logs whatsapp-mcp
pm2 restart whatsapp-mcp
pm2 stop whatsapp-mcp
```

## 4. Register with an MCP client (e.g. Claude Code)

The server listens locally on `http://127.0.0.1:8765/mcp` (port configurable via `WHATSAPP_MCP_PORT`).

```bash
claude mcp add --transport http whatsapp http://127.0.0.1:8765/mcp --scope user
claude mcp list
```

`--scope user` makes the tool available in every project, not just the current directory. Any other MCP client that supports Streamable HTTP transport can point at the same URL.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `WHATSAPP_MCP_PORT` | `8765` | Port of the local MCP HTTP server |
| `WHATSAPP_MCP_REMINDER_MINUTES` | `30` | Threshold for the unanswered-message reminder |

## Data & privacy

Everything lives under `~/.whatsapp-mcp/`:
- `auth/` — WhatsApp session keys (multi-device link, no password involved)
- `data/whatsapp.db` — SQLite database of chats/messages/contacts seen while the server was running
- `downloads/` — downloaded media

Delete this folder to unlink the device and wipe all local history.

## License

MIT — see [LICENSE](./LICENSE).
