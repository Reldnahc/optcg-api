import { FastifyInstance } from "fastify";

export async function docsRoutes(app: FastifyInstance) {
  app.get("/openapi.json", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=3600");
    return app.getOpenApiDocument();
  });

  app.get("/docs", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=3600");
    return app.renderOpenApiDocsHtml();
  });
}
