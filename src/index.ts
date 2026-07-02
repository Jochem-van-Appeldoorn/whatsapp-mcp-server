import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { connectWhatsApp } from "./whatsapp.js";
import { registerTools } from "./tools.js";
import { startReminders } from "./reminders.js";

const PORT = Number(process.env.WHATSAPP_MCP_PORT ?? 8765);
const REMINDER_THRESHOLD_MINUTES = Number(process.env.WHATSAPP_MCP_REMINDER_MINUTES ?? 30);

function createServer(): McpServer {
  const server = new McpServer(
    { name: "whatsapp-mcp-server", version: "1.1.0" },
    {
      instructions:
        "Alle tijden zijn Europe/Amsterdam. Gebruik voor tijdsverwijzingen in berichten ('over 3 uur', 'morgen') altijd de actuele tijd uit de Nu:-regel in toolresultaten of get_current_time — nooit een aanname. Berichtlijsten zijn compact: [tijd] afzender: tekst.",
    }
  );
  registerTools(server);
  return server;
}

async function main() {
  await connectWhatsApp();
  startReminders(REMINDER_THRESHOLD_MINUTES);

  const app = createMcpExpressApp();

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
