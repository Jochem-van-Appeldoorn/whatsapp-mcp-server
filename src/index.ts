import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { connectWhatsApp } from "./whatsapp.js";
import { registerTools } from "./tools.js";
import { startReminders } from "./reminders.js";
import { MCP_TOKEN_PATH } from "./paths.js";

const PORT = Number(process.env.WHATSAPP_MCP_PORT ?? 8765);
const REMINDER_THRESHOLD_MINUTES = Number(process.env.WHATSAPP_MCP_REMINDER_MINUTES ?? 30);

// De server wordt via Tailscale Funnel publiek bereikbaar gemaakt (voor de
// Marktplaats cloud-routine), dus een bearer-token is verplicht: zonder
// deze check zou iedereen die de URL raadt WhatsApp-berichten kunnen lezen
// of versturen namens Jochem. Token wordt eenmalig gegenereerd en
// hergebruikt bij herstarts.
function getOrCreateAuthToken(): string {
  if (existsSync(MCP_TOKEN_PATH)) {
    return readFileSync(MCP_TOKEN_PATH, "utf8").trim();
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(MCP_TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

const AUTH_TOKEN = getOrCreateAuthToken();

function createServer(): McpServer {
  const server = new McpServer(
    { name: "whatsapp-mcp-server", version: "1.2.0" },
    {
      instructions:
        "Alle tijden zijn Europe/Amsterdam. Gebruik voor tijdsverwijzingen in berichten ('over 3 uur', 'morgen') altijd de actuele tijd uit de Nu:-regel in toolresultaten of get_current_time — nooit een aanname. " +
        "Conventies in output: berichtlijsten zijn chronologisch (oudste eerst) met dagkoppen '— wo 2026-07-02 —' en regels '[21:53] Afzender: tekst'; " +
        "kale nummers zijn telefoonnummers (@s.whatsapp.net weggelaten), @g.us is een groep, @lid is een intern id (geen telefoonnummer); " +
        "'…[+N tekens; full_text=true]' betekent dat een bericht is afgekapt — herhaal de call met full_text=true voor de volledige tekst.",
    }
  );
  registerTools(server);
  return server;
}

async function main() {
  await connectWhatsApp();
  startReminders(REMINDER_THRESHOLD_MINUTES);

  const app = createMcpExpressApp();

  app.use("/mcp", (req, res, next) => {
    const header = req.header("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (provided !== AUTH_TOKEN) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    next();
  });

  app.post("/mcp", async (req, res) => {
    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (err) {
      console.error("Fout bij verwerken MCP-verzoek:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Interne serverfout" }, id: null });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
  });

  app.delete("/mcp", (_req, res) => {
    res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
  });

  app.listen(PORT, () => {
    console.log(`WhatsApp MCP server luistert op http://127.0.0.1:${PORT}/mcp`);
  });
}

main().catch((err) => {
  console.error("Kon whatsapp-mcp-server niet starten:", err);
  process.exit(1);
});
