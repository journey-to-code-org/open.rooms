# The documentation site

An open.blog project that publishes [`docs/`](../docs/README.md) at <https://journey-to-code-org.github.io/open.rooms/>.
The docs are written once, in `docs/`, and read on GitHub or on the site.

- `openblog.json` turns on the documentation section and points `docs.source` at `docs/` on GitHub. Its
  `paths.themes` and `paths.web` point into `.open.blog/`, a checkout of open.blog that is not committed.
- `content/landing.json` is the home page.
- `content/docs/` is filled from `docs/` when the site is built, and never committed.

Build and preview: see [For agents](../docs/agents.md#editing-these-docs).
