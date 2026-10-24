# takeone

Record your screen, camera and voice, edit the video by editing its text, and share it without a
server. takeone is a web page: no account, no upload, no subscription.

**→ [maxgfr.github.io/takeone](https://maxgfr.github.io/takeone/)**

Work in progress: the recorder, the text-based editor, the exports and peer-to-peer sharing land
milestone by milestone ([issues](https://github.com/maxgfr/takeone/issues)).

## Develop

```bash
bun install
bun run dev        # http://localhost:5173/takeone/, rebuilt on change
bun run test       # unit tests
bun run test:e2e   # Playwright (PORT=… to serve on another port)
bun run lint && bun run typecheck
bun run build      # dist/, deployed to GitHub Pages by .github/workflows/pages.yml
```

Stack: Bun, TypeScript, Preact with signals, Zod. MIT license.
