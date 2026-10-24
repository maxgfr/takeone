/**
 * Static server for dist/, used by the dev loop and the end-to-end tests. It sends the headers
 * that isolate the page (GitHub Pages cannot: public/sw.js adds them there).
 */
import { join, normalize } from "node:path";

export const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export function serveApp(opts: { port: number; dir: string }) {
  return Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      let path = decodeURIComponent(url.pathname).replace(/^\/takeone/, "");
      if (path === "" || path.endsWith("/")) path += "index.html";
      const file = Bun.file(join(opts.dir, normalize(path).replace(/^(\.\.[/\\])+/, "")));
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return new Response(file, { headers: ISOLATION });
    },
  });
}

if (import.meta.main) {
  const server = serveApp({
    port: Number(process.env.PORT ?? 4174),
    dir: join(import.meta.dir, "../dist"),
  });
  console.log(`serving dist/ on http://localhost:${server.port}/takeone/`);
}
