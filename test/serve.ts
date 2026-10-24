/**
 * Static server for dist/ (under /takeone/, like GitHub Pages) with a mock
 * Nostr relay (/relay) and WebTorrent tracker (/tracker) on the same origin,
 * so the end-to-end tests and the signaling unit tests never touch the public
 * network. It also builds the end-to-end fixtures (e2e/fixtures/*.tsx) on
 * request at /takeone/__e2e/<name>.js: same origin, so the CSP allows them,
 * and nothing test-only ever ships in dist/.
 *
 * Adapted from veil (github.com/maxgfr/veil, MIT), test/serve.ts.
 */
import { join, normalize, resolve } from "node:path";
import { createMockRelay, type MockRelay } from "./mock-relay";
import { createMockTracker, type MockTracker } from "./mock-tracker";

const FIXTURES = resolve(import.meta.dir, "../e2e/fixtures");
const fixtures = new Map<string, Promise<string | null>>();

function fixture(name: string): Promise<string | null> {
  let out = fixtures.get(name);
  if (!out) {
    out = Bun.build({
      entrypoints: [join(FIXTURES, `${name}.tsx`)],
      target: "browser",
      format: "esm",
    }).then(async (r) => {
      if (!r.success) {
        for (const log of r.logs) console.error(log);
        return null;
      }
      return (await r.outputs[0]?.text()) ?? null;
    });
    fixtures.set(name, out);
  }
  return out;
}

interface WsData {
  kind: "relay" | "tracker";
}

export interface AppServer {
  port: number;
  relay: MockRelay;
  tracker: MockTracker;
  stop(): void;
}

export function serveApp(opts: { port: number; dir: string }): AppServer {
  const relay = createMockRelay();
  const tracker = createMockTracker();
  const server = Bun.serve<WsData>({
    port: opts.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/relay" || url.pathname === "/tracker") {
        const kind = url.pathname === "/relay" ? "relay" : "tracker";
        if (srv.upgrade(req, { data: { kind } })) return undefined;
        return new Response("upgrade required", { status: 426 });
      }
      let path = decodeURIComponent(url.pathname).replace(/^\/takeone/, "");
      const fx = path.match(/^\/__e2e\/([a-z-]+)\.js$/);
      if (fx?.[1]) {
        const js = await fixture(fx[1]);
        if (js === null) return new Response("fixture build failed", { status: 500 });
        return new Response(js, { headers: { "content-type": "text/javascript" } });
      }
      if (path === "" || path.endsWith("/")) path += "index.html";
      const file = Bun.file(join(opts.dir, normalize(path).replace(/^(\.\.[/\\])+/, "")));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file);
    },
    websocket: {
      open(ws) {
        (ws.data.kind === "relay" ? relay : tracker).open(ws);
      },
      message(ws, msg) {
        const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg);
        (ws.data.kind === "relay" ? relay : tracker).message(ws, text);
      },
      close(ws) {
        (ws.data.kind === "relay" ? relay : tracker).close(ws);
      },
      maxPayloadLength: 1 << 20,
    },
  });
  return {
    port: server.port ?? opts.port,
    relay,
    tracker,
    stop: () => server.stop(true),
  };
}
