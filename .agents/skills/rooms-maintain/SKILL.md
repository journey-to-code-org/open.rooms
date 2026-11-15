---
name: rooms-maintain
description: Work on the open.rooms repository itself. Use when changing packages/rooms, running tests, editing docs/, or cutting a release.
---

One package, `@journey-to-code/rooms` in `packages/rooms`, with `src/server.ts` and `src/client.ts`. Node 22.12 or later.

## Commands

- `npm run build`, `npm run typecheck`, `npm test` (vitest in `packages/rooms`).

Finish a change only when all three pass.

## Rules that are easy to break

- **Replay must reproduce the game.** `setup`, `act` and `deadline` are deterministic; a change to how moves or times are logged breaks old rooms. Add a test that restores a room from its log.
- **No view leaks.** Anything added to a room document is public, and anything added to a view goes to that seat. Collections: `rooms` (everyone), `views/<id>/<seat>` (that seat), `games` and `moves` (the server only), `chat` (everyone). `authorize` must keep refusing page writes.
- **A move and a timeout never both land on one state.** Keep the check that the timer is still the armed one.
- **Person-facing errors** are plain sentences shown as they are.
- **Docs match the code.** When an option, route, status or default changes, change `docs/` in the same PR. Link pages as `file.md` so links work on GitHub and the site.
- Do not link docs or skills to open.parlor (it is going private).
- The browser client loads `@zubra/runtime` (built on the Signals API) through `@zubra/sync`. Keep `docs/client.md`'s "What the browser loads" true when the dependency changes.

## Releasing

Bump `version` in `packages/rooms/package.json` in a PR and merge. `.github/workflows/release.yml` publishes versions not on npm yet, with provenance, then tags `rooms-v<version>` and creates the GitHub release. A failed run is safe to re-run from the Actions tab. Details: `docs/releasing.md`.

## Docs

`docs/` is Markdown with `order` in the front matter, built to GitHub Pages by `.github/workflows/docs-pages.yml`, pinned to one open.blog commit (`OPENBLOG_REF`). A pull request builds the site; only `main` publishes. Pages needs Settings, Pages, Source: GitHub Actions, once. The site's social image is `docs-site/static/og.png`, drawn from `og.svg`.
