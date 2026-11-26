import * as NodeHttp from "node:http";

const host = process.env.CT_PLUGIN_HOST || "127.0.0.1";
const port = Number(process.env.CT_PLUGIN_PORT || "0");
const expectedToken = process.env.CT_PLUGIN_TOKEN || "";
const pluginId = process.env.CT_PLUGIN_ID || "demo-plugin";
const dataDir = process.env.CT_PLUGIN_DATA_DIR || "";
const rootDir = process.env.CT_PLUGIN_ROOT || "";

function isAuthorized(req) {
  if (!expectedToken) return true;
  const pluginToken = req.headers["x-ct-plugin-token"];
  const studioToken = req.headers["x-ct-studio-token"];
  return pluginToken === expectedToken || studioToken === expectedToken;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, data, extraHeaders = {}) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(payload);
}

const server = NodeHttp.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${host}:${port || 80}`);

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      pluginId,
      dataDir,
      rootDir,
      pid: process.pid,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/ping") {
    sendJson(res, 200, {
      pong: true,
      pluginId,
      method: req.method,
      query: Object.fromEntries(url.searchParams.entries()),
      tokens: {
        hasPluginToken: req.headers["x-ct-plugin-token"] === expectedToken,
        hasStudioToken: req.headers["x-ct-studio-token"] === expectedToken,
        hasAuthorization: req.headers.authorization !== undefined,
      },
      dataDir,
      rootDir,
    });
    return;
  }

  if (url.pathname === "/api/echo") {
    const rawBody = await readBody(req);
    let parsedBody = rawBody;
    try {
      parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : null;
    } catch {
      // keep string
    }
    sendJson(res, 200, {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body: parsedBody,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/binary") {
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(payload.byteLength),
    });
    res.end(payload);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sse") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ seq: 1, pluginId })}\n\n`);
    const timer = setTimeout(() => {
      res.write(`data: ${JSON.stringify({ seq: 2, done: true })}\n\n`);
      res.end();
    }, 25);
    req.on("close", () => clearTimeout(timer));
    return;
  }

  sendJson(res, 404, { error: "Not Found", path: url.pathname });
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(port, host, () => {
  process.stdout.write(`demo-plugin listening on http://${host}:${port}\n`);
});
