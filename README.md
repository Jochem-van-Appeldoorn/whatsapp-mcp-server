# whatsapp-mcp-server

Een lokale, altijd-aan MCP server die WhatsApp koppelt aan Claude Code via [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web multi-device). Werkt op Linux, macOS en Windows.

Alle sessiegegevens (koppeling, berichtgeschiedenis, gedownloade media) worden buiten deze repo opgeslagen in `~/.whatsapp-mcp/`, zodat de repo-code zelf nergens geheimen bevat.

## Tools

`send_message`, `send_file`, `send_audio_message`, `download_media`, `search_contacts`, `list_chats`, `list_messages`, `get_message_context`, `get_last_interaction`, `get_direct_chat_by_contact`, `get_contact_chats`, `list_groups`, `get_group_info`, `get_unanswered_messages`, `check_connection_status`.

`get_unanswered_messages` meldt 1-op-1 chats die te lang onbeantwoord staan. De server stuurt hier zelf ook desktop-notificaties voor (elke 5 minuten gecheckt), ongeacht of Claude Code open staat.

## 1. Installeren

Vereist Node.js 20+.

```bash
git clone <deze-repo> whatsapp-mcp-server
cd whatsapp-mcp-server
npm install
npm run build
```

`better-sqlite3` gebruikt prebuilt binaries voor Linux/macOS/Windows — normaal gesproken is geen C-compiler nodig.

### Optioneel: ffmpeg (voor voice notes)

`send_audio_message` converteert audio automatisch naar ogg/opus zodat het als afspeelbaar voice-bericht aankomt. Zonder ffmpeg wordt het bestand als gewoon audiobestand verstuurd (werkt ook, maar geen voice-note-uiterlijk).

- **Linux (Debian/Ubuntu)**: `sudo apt install ffmpeg`
- **macOS**: `brew install ffmpeg`
- **Windows**: `choco install ffmpeg` (of handmatig installeren en aan PATH toevoegen)

## 2. Eerste keer koppelen (QR-code)

Moet interactief in de voorgrond, op elk platform hetzelfde:

```bash
npm run dev
```

Scan de getoonde QR-code in WhatsApp via **Instellingen > Gekoppelde apparaten > Apparaat koppelen**. Na een succesvolle koppeling staat de sessie in `~/.whatsapp-mcp/auth/` en hoeft dit niet opnieuw (tenzij je uitlogt op je telefoon).

Stop de voorgrondsessie (Ctrl+C) zodra je "WhatsApp verbonden als ..." ziet.

## 3. Altijd-aan draaien met PM2

We gebruiken [PM2](https://pm2.keymetrics.io/) als cross-platform process manager (herstart bij crash, start bij opstarten), zodat er geen aparte systemd/launchd/Windows-Service configs per OS onderhouden hoeven te worden.

```bash
npm install -g pm2
cd whatsapp-mcp-server
pm2 start dist/index.js --name whatsapp-mcp
pm2 save
pm2 startup   # print een commando dat je 1x moet uitvoeren om PM2 bij opstarten te laten starten
```

`pm2 startup` detecteert zelf het platform (systemd op Linux, launchd op macOS, een Windows-taak op Windows) en toont het juiste vervolgcommando.

Nuttige commando's:
```bash
pm2 logs whatsapp-mcp
pm2 restart whatsapp-mcp
pm2 stop whatsapp-mcp
```

## 4. Registreren in Claude Code

De server luistert lokaal op `http://127.0.0.1:8765/mcp` (poort instelbaar via `WHATSAPP_MCP_PORT`).

```bash
claude mcp add --transport http whatsapp http://127.0.0.1:8765/mcp --scope user
claude mcp list
```

`--scope user` maakt de tool in alle projecten beschikbaar, niet alleen in deze map.

## Configuratie (environment variables)

| Variabele | Standaard | Betekenis |
|---|---|---|
| `WHATSAPP_MCP_PORT` | `8765` | Poort van de lokale MCP HTTP-server |
| `WHATSAPP_MCP_REMINDER_MINUTES` | `30` | Drempel voor de onbeantwoord-melding |

## Data & privacy

Alles leeft in `~/.whatsapp-mcp/`:
- `auth/` — WhatsApp-sessiesleutels (multi-device linking, geen wachtwoord)
- `data/whatsapp.db` — SQLite met chats/berichten/contacten die binnenkwamen terwijl de server draaide
- `downloads/` — gedownloade media

Verwijder deze map om de koppeling en alle lokale geschiedenis te wissen.
