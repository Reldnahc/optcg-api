import { FastifyInstance } from "fastify";
import { verifyAdminToken } from "../admin/session.js";

export async function adminAuth(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      reply.code(401).send({ error: { status: 401, message: "Missing token" } });
      return;
    }

    try {
      const payload = verifyAdminToken(authHeader.slice("Bearer ".length));
      req.admin = { email: payload.sub };
    } catch (error: any) {
      reply.code(401).send({ error: { status: 401, message: error.message } });
      return;
    }
  });
}
