import { FastifyInstance } from "fastify";

type RouteSchema = {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  security?: Array<Record<string, string[]>>;
  params?: Record<string, unknown>;
  querystring?: Record<string, unknown>;
  body?: Record<string, unknown>;
  response?: Record<string, Record<string, unknown>>;
};

type CollectedRoute = {
  method: string;
  url: string;
  schema: RouteSchema;
};

declare module "fastify" {
  interface FastifyInstance {
    openApiRoutes: CollectedRoute[];
    getOpenApiDocument: () => Record<string, unknown>;
    renderOpenApiDocsHtml: () => string;
  }
}

function normalizeUrl(url: string) {
  return url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function isPublicDocumentedRoute(url: string) {
  return !url.startsWith("/admin/");
}

function inferParameterType(schema: Record<string, unknown> | undefined, name: string) {
  const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  return properties[name] ?? { type: "string" };
}

function buildParameters(route: CollectedRoute) {
  const paramsSchema = route.schema.params;
  const querySchema = route.schema.querystring;

  const pathRequired = new Set<string>(
    Array.isArray((paramsSchema as { required?: string[] } | undefined)?.required)
      ? ((paramsSchema as { required?: string[] }).required ?? [])
      : [],
  );
  const queryRequired = new Set<string>(
    Array.isArray((querySchema as { required?: string[] } | undefined)?.required)
      ? ((querySchema as { required?: string[] }).required ?? [])
      : [],
  );

  const pathParams = Object.keys(((paramsSchema as { properties?: object } | undefined)?.properties ?? {})).map((name) => ({
    name,
    in: "path",
    required: true,
    schema: inferParameterType(paramsSchema, name),
  }));

  const queryParams = Object.keys(((querySchema as { properties?: object } | undefined)?.properties ?? {})).map((name) => ({
    name,
    in: "query",
    required: queryRequired.has(name),
    schema: inferParameterType(querySchema, name),
  }));

  return [...pathParams, ...queryParams];
}

function buildRequestBody(schema: RouteSchema) {
  if (!schema.body) return undefined;
  return {
    required: true,
    content: {
      "application/json": {
        schema: schema.body,
      },
    },
  };
}

function buildResponses(schema: RouteSchema) {
  const responses = schema.response ?? {};
  return Object.fromEntries(
    Object.entries(responses).map(([status, responseSchema]) => [
      status,
      {
        description: `HTTP ${status}`,
        content: {
          "application/json": {
            schema: responseSchema,
          },
        },
      },
    ]),
  );
}

export function installOpenApi(app: FastifyInstance) {
  app.decorate("openApiRoutes", []);

  app.addHook("onRoute", (routeOptions) => {
    if (!routeOptions.schema) return;

    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    for (const method of methods) {
      if (method === "HEAD") continue;
      app.openApiRoutes.push({
        method: method.toLowerCase(),
        url: normalizeUrl(routeOptions.url),
        schema: routeOptions.schema as RouteSchema,
      });
    }
  });

  app.decorate("getOpenApiDocument", function getOpenApiDocument() {
    const paths: Record<string, Record<string, unknown>> = {
      "/openapi.json": {
        get: {
          tags: ["Docs"],
          summary: "Machine-readable API contract",
          operationId: "get_openapi_json",
          responses: {
            "200": {
              description: "OpenAPI document",
              content: {
                "application/json": {
                  schema: { type: "object", additionalProperties: true },
                },
              },
            },
          },
        },
      },
      "/docs": {
        get: {
          tags: ["Docs"],
          summary: "Human-readable API docs",
          operationId: "get_docs_html",
          responses: {
            "200": {
              description: "HTML documentation page",
              content: {
                "text/html": {
                  schema: { type: "string" },
                },
              },
            },
          },
        },
      },
    };

    for (const route of this.openApiRoutes) {
      if (!isPublicDocumentedRoute(route.url)) continue;
      paths[route.url] ??= {};
      paths[route.url][route.method] = {
        tags: route.schema.tags ?? [],
        summary: route.schema.summary,
        ...(route.schema.description ? { description: route.schema.description } : {}),
        operationId: route.schema.operationId ?? `${route.method}_${route.url.replace(/[^A-Za-z0-9]+/g, "_")}`,
        ...(route.schema.security ? { security: route.schema.security } : {}),
        ...(buildParameters(route).length ? { parameters: buildParameters(route) } : {}),
        ...(route.schema.body ? { requestBody: buildRequestBody(route.schema) } : {}),
        responses: buildResponses(route.schema),
      };
    }

    const tagNames = new Set<string>(["Docs"]);
    for (const route of this.openApiRoutes) {
      if (!isPublicDocumentedRoute(route.url)) continue;
      for (const tag of route.schema.tags ?? []) tagNames.add(tag);
    }

    return {
      openapi: "3.1.0",
      info: {
        title: "optcg-api",
        version: "0.1.0",
        description: "API contract generated from registered Fastify route schemas.",
      },
      servers: [{ url: "/" }],
      tags: [...tagNames].map((name) => ({ name })),
      paths,
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
    };
  });

  app.decorate("renderOpenApiDocsHtml", function renderOpenApiDocsHtml() {
    const document = this.getOpenApiDocument();
    const paths = (document.paths ?? {}) as Record<string, Record<string, { summary?: string; tags?: string[]; parameters?: Array<{ in: string; name: string; required?: boolean }>; requestBody?: unknown; security?: unknown[] }>>;

    const grouped = new Map<string, Array<{ method: string; path: string; operation: Record<string, unknown> }>>();
    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const tag = ((operation.tags as string[] | undefined)?.[0]) ?? "Misc";
        const current = grouped.get(tag) ?? [];
        current.push({ method, path, operation });
        grouped.set(tag, current);
      }
    }

    const sections = [...grouped.entries()].map(([tag, entries]) => {
      const items = entries.map(({ method, path, operation }) => {
        const params = (operation.parameters as Array<{ in: string; name: string; required?: boolean }> | undefined) ?? [];
        const hasBody = Boolean(operation.requestBody);
        const auth = Array.isArray(operation.security) && operation.security.length > 0 ? `<span class="auth">Bearer</span>` : "";
        return `
          <article class="route">
            <div class="head">
              <span class="method ${method}">${method.toUpperCase()}</span>
              <code>${path}</code>
              ${auth}
            </div>
            <p class="summary">${String(operation.summary ?? "")}</p>
            ${params.length ? `<p class="meta">params: ${params.map((param) => `${param.in}:${param.name}${param.required ? "*" : ""}`).join(", ")}</p>` : ""}
            ${hasBody ? `<p class="meta">body: application/json *</p>` : ""}
          </article>
        `;
      }).join("");

      return `<section><h2>${tag}</h2>${items}</section>`;
    }).join("");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>optcg-api docs</title>
  <style>
    body { margin: 0; background: linear-gradient(180deg, #f7f3ec, #eee5d6); color: #201a14; font: 16px/1.5 Georgia, serif; }
    main { max-width: 980px; margin: 0 auto; padding: 40px 20px 72px; }
    h1 { margin: 0 0 8px; font-size: clamp(2rem, 5vw, 4rem); }
    h2 { margin: 36px 0 14px; border-bottom: 1px solid #d4c4b0; padding-bottom: 6px; }
    .lead, .meta { color: #6d6052; }
    .links { display: flex; gap: 12px; flex-wrap: wrap; margin: 18px 0 28px; }
    .links a { color: #7c3f00; text-decoration: none; border: 1px solid #d4c4b0; background: #fffaf2; padding: 8px 12px; }
    .route { background: #fffaf2; border: 1px solid #d4c4b0; padding: 14px 16px; margin-bottom: 12px; }
    .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
    .method, .auth { display: inline-block; border-radius: 999px; padding: 2px 8px; font: 700 12px/1.6 Consolas, monospace; color: #fff; }
    .get { background: #1d6f42; } .post { background: #8f3b00; } .put { background: #8a6a00; } .delete { background: #8a1f1f; }
    .auth { background: #efe2d2; color: #7c3f00; }
    .summary { font-weight: 700; margin: 0; }
    code { font: 600 14px/1.4 Consolas, monospace; }
  </style>
</head>
<body>
  <main>
    <h1>optcg-api</h1>
    <p class="lead">This API now serves its docs from registered Fastify route schemas. The same generated document powers <code>/openapi.json</code> and this docs page.</p>
    <div class="links"><a href="/openapi.json">OpenAPI JSON</a><a href="/health">Health</a></div>
    ${sections}
  </main>
</body>
</html>`;
  });
}
