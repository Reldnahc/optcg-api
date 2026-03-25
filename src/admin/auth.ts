import { FastifyInstance } from "fastify";
import { getAdminEmail } from "./config.js";
import { signAdminToken, verifyAdminCredentials } from "./session.js";

export async function adminAuthRoutes(app: FastifyInstance) {
  app.post("/login", async (req, reply) => {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };

    if (typeof body.email !== "string" || typeof body.password !== "string") {
      reply.code(400);
      return { error: { status: 400, message: "email and password are required" } };
    }

    let valid = false;
    try {
      valid = verifyAdminCredentials(body.email, body.password);
    } catch (error: any) {
      req.log.error(error);
      reply.code(500);
      return { error: { status: 500, message: error.message } };
    }

    if (!valid) {
      reply.code(401);
      return { error: { status: 401, message: "Invalid credentials" } };
    }

    try {
      const email = getAdminEmail();
      const { token, expiresAt } = signAdminToken(email);
      return {
        data: {
          email,
          token,
          token_type: "Bearer",
          expires_at: expiresAt,
        },
      };
    } catch (error: any) {
      req.log.error(error);
      reply.code(500);
      return { error: { status: 500, message: error.message } };
    }
  });
}
