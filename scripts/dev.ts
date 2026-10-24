/** Dev loop: rebuilds dist/ (unminified) on every change and serves it. */
import { watch } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "./build";
import { serveApp } from "./serve";

const ROOT = resolve(import.meta.dir, "..");
const port = Number(process.env.PORT ?? 5173);

async function rebuild(): Promise<void> {
  try {
    await build({ minify: false });
    console.log(`rebuilt at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
  }
}

await rebuild();
const server = serveApp({ port, dir: join(ROOT, "dist") });
console.log(`takeone dev server on http://localhost:${server.port}/takeone/`);

let timer: ReturnType<typeof setTimeout> | undefined;
for (const target of ["src", "index.html", "public"]) {
  watch(join(ROOT, target), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 80);
  });
}
