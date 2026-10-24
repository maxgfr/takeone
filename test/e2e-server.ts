/**
 * Server for the Playwright suite: dist/ under /takeone/, plus a local Nostr
 * relay and WebTorrent tracker, so no test touches the public network.
 *
 * Adapted from veil (github.com/maxgfr/veil, MIT), test/e2e-server.ts.
 */
import { resolve } from "node:path";
import { serveApp } from "./serve";

const port = Number(process.env.PORT ?? 4174);
const server = serveApp({ port, dir: resolve(import.meta.dir, "../dist") });
console.log(`e2e server on http://localhost:${server.port}/takeone/`);
