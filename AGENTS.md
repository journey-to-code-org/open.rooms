# open.rooms

Realtime multiplayer rooms for turn-based games, over Zubra's sync layer.

- `packages/rooms`: `@journey-to-code/rooms` (`/server` and `/client`).
- `docs/`: the documentation, published at https://journey-to-code-org.github.io/open.rooms/.
- `.agents/skills/`: how to use and maintain it: `rooms-server`, `rooms-client`, `rooms-maintain`.

Commands: `npm run build`, `npm run typecheck`, `npm test` (Node 22.12 or later). All must pass before a change is done.

Rules: `act`, `setup` and `deadline` are deterministic and never read the clock (a restart replays them); a view holds only what its seat may see; pages never write. `rooms-maintain` has the rest, including releasing.
