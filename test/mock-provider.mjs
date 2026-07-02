#!/usr/bin/env node
/**
 * mock-provider.mjs — a tiny fake API provider for exercising the engine.
 *
 * Mimics the Apigee-shaped reality the corpus showed is the most common:
 * a bearer-token management API, a developer resource, an app resource that
 * 409s on duplicates, and a read-back endpoint that returns the credentials.
 *
 *   node test/mock-provider.mjs   # listens on 127.0.0.1:8977
 */
import { createServer } from "node:http";

const developers = new Set();
const apps = new Map();

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const auth = req.headers["authorization"] || "";
  if (auth !== "Bearer mock-token-123") return json(res, 401, { error: "bad token" });

  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);

    // POST /v1/developers
    if (req.method === "POST" && url.pathname === "/v1/developers") {
      if (developers.has(body.email)) return json(res, 409, { error: "developer exists" });
      developers.add(body.email);
      return json(res, 201, { email: body.email });
    }
    // POST /v1/developers/{email}/apps
    if (req.method === "POST" && parts[1] === "developers" && parts[3] === "apps") {
      const key = `${parts[2]}/${body.name}`;
      if (apps.has(key)) return json(res, 409, { error: "app exists" });
      const app = {
        name: body.name,
        credentials: [{ consumerKey: `ck-${apps.size + 1}`, consumerSecret: `cs-${apps.size + 1}` }],
      };
      apps.set(key, app);
      return json(res, 201, app);
    }
    // GET /v1/developers/{email}/apps/{name}
    if (req.method === "GET" && parts[1] === "developers" && parts[3] === "apps" && parts[4]) {
      const app = apps.get(`${parts[2]}/${decodeURIComponent(parts[4])}`);
      return app ? json(res, 200, app) : json(res, 404, { error: "not found" });
    }
    json(res, 404, { error: "no route" });
  });
});

server.listen(8977, "127.0.0.1", () => console.error("mock provider on 127.0.0.1:8977"));
