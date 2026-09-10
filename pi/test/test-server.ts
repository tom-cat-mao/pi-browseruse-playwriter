/**
 * Minimal real HTTP server for wire-contract tests. No mocked fetch: tests spin
 * up an actual node:http listener on an ephemeral port and point the client /
 * bootstrap at it, exercising real serialization, status codes, and streaming.
 *
 * Handlers receive the parsed request and return either a raw
 * { status, body } (body is JSON.stringified unless already a string) so tests
 * can assert 400/401/200-ok:false paths and malformed bodies.
 */
import http from "node:http";

export type RecordedRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
};

export type HandlerResult = { status?: number; json?: unknown; raw?: string; contentType?: string };
export type Handler = (req: RecordedRequest) => HandlerResult | Promise<HandlerResult>;

export type TestServer = {
  baseUrl: string;
  port: number;
  requests: RecordedRequest[];
  setHandler: (handler: Handler) => void;
  close: () => Promise<void>;
};

export async function startTestServer(initial?: Handler): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  let handler: Handler =
    initial ??
    (() => {
      return { status: 404, json: { error: "no handler" } };
    });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
    });
    req.on("end", () => {
      void (async () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const body = ((): unknown => {
          if (!rawBody) return undefined;
          try {
            return JSON.parse(rawBody) as unknown;
          } catch {
            return rawBody;
          }
        })();
        const recorded: RecordedRequest = {
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers: req.headers,
          body,
        };
        requests.push(recorded);
        const result = await handler(recorded);
        const status = result.status ?? 200;
        const payload = result.raw !== undefined ? result.raw : JSON.stringify(result.json ?? null);
        res.writeHead(status, { "Content-Type": result.contentType ?? "application/json" });
        res.end(payload);
      })();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }
  const port = address.port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    setHandler: (h: Handler) => {
      handler = h;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

/** A valid v1 capabilities object for the managed contract. */
export const validCapabilities = {
  protocolVersion: 1,
  managedGroups: true,
  persistentOwnership: true,
  explicitTabs: true,
  isolatedExecution: true,
};

/** A valid connected profile. */
export const validProfile = {
  profileId: "profile-1",
  browser: "chrome",
  label: "Default",
  connected: true,
  browserEpoch: "epoch-1",
  capabilities: validCapabilities,
};
