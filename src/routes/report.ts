import type { FastifyInstance } from "fastify";
import { getDiscordWebhookUrl } from "../admin/config.js";

const REPORT_TYPES: Record<string, string> = {
  card_data: "Card Data Issue",
  bug: "Bug Report",
  feature: "Feature Request",
  other: "Other",
};

const reportSchema = {
  body: {
    type: "object" as const,
    required: ["type", "message"],
    properties: {
      type: { type: "string" as const, enum: Object.keys(REPORT_TYPES) },
      message: { type: "string" as const, minLength: 10, maxLength: 2000 },
      card_number: { type: "string" as const, maxLength: 20 },
      contact: { type: "string" as const, maxLength: 200 },
    },
  },
};

interface ReportBody {
  type: keyof typeof REPORT_TYPES;
  message: string;
  card_number?: string;
  contact?: string;
}

export async function reportRoute(app: FastifyInstance) {
  app.post<{ Body: ReportBody }>("/report", { schema: reportSchema }, async (req, reply) => {
    const webhookUrl = getDiscordWebhookUrl();
    if (!webhookUrl) {
      reply.code(503);
      return { error: { status: 503, message: "Reporting is currently unavailable" } };
    }

    const { type, message, card_number, contact } = req.body;

    const fields = [
      { name: "Type", value: REPORT_TYPES[type] || type, inline: true },
    ];
    if (card_number) fields.push({ name: "Card", value: card_number, inline: true });
    if (contact) fields.push({ name: "Contact", value: contact, inline: true });
    fields.push({ name: "Message", value: message, inline: false });

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: `Report: ${REPORT_TYPES[type] || type}`,
          color: 0xf59e0b,
          fields,
          timestamp: new Date().toISOString(),
        }],
      }),
    });

    if (!res.ok) {
      req.log.error({ status: res.status, body: await res.text() }, "Discord webhook failed");
      reply.code(502);
      return { error: { status: 502, message: "Failed to send report" } };
    }

    return { success: true };
  });
}
