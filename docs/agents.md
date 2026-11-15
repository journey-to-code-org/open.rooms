---
order: 8
---

# For agents

A coding agent can use and maintain open.rooms with the skills in [`.agents/`](https://github.com/journey-to-code-org/open.rooms/tree/main/.agents). They are plain Markdown in the `SKILL.md` format, so any agent that reads `AGENTS.md` or skills can use them, and a person can read them too.

[`AGENTS.md`](https://github.com/journey-to-code-org/open.rooms/blob/main/AGENTS.md) at the root is the short version for anyone working in the repository.

| Skill | Use it to |
| --- | --- |
| `rooms-server` | Define a room and serve it: the definition, `createRooms`, the log, mounting, bots, deadlines and moderation. |
| `rooms-client` | Build a page: `createRoom`, `openRoom`, seats, views, chat, the clock, and what the page loads. |
| `rooms-maintain` | Work on this repository: tests, the docs, and cutting a release. |

## Rules every skill repeats

- **`act`, `setup` and `deadline` are deterministic and never read the clock.** A restart replays them.
- **A view contains only what its seat may see.** Never put `holders`, the seed, or another seat's hand in a view, a summary or `info`.
- **Pages never write.** Everything is a request the server decides.
- **Use a real `log` in production.** The default one is in memory.

## Editing these docs

The docs are Markdown in `docs/`, read on GitHub or on the site, and built with [open.blog](https://github.com/journey-to-code-org/open.blog). Write a link to another page as its file (`[the server](server.md)`) so it works in both places.

To preview locally you need Rust and a checkout of open.blog (the build uses its themes):

```sh
git clone https://github.com/journey-to-code-org/open.blog .open.blog   # once; ignored by git
cargo build --release --manifest-path .open.blog/Cargo.toml -p openblog-cli
node scripts/build-docs-site.mjs                                      # copies docs/ into the site
.open.blog/target/release/openblog serve --root docs-site
```

Then open <http://localhost:8080/docs/>. `docs-pages.yml` builds the same way, pinned to one open.blog commit (the `OPENBLOG_REF` in that file), and publishes on every push to `main` that changes `docs/`.
