---
name: rooms-server
description: Define and serve a multiplayer room for a turn-based game with open.rooms. Use when writing createRooms, a room definition (setup, act, view, bot, deadline), mounting /rooms, choosing a log, or adding bots, clocks, watching or moderation.
---

`@journey-to-code/rooms/server` runs the rules of a game for every table: seats, moves, private views, bots, deadlines, chat. The game itself is five functions.

## Ask first

- What is the game's state, its moves, and what may each seat see? Write these down before code.
- Should tables survive a restart? Then pick a real log (below).
- Does anyone watch, or are there timers (a turn limit, a chess clock)? Those add `watch` and `deadline`.
- Node `http`, or a `Request`/`Response` server (Hono, Bun, Deno)?

## Steps

1. `npm install @journey-to-code/rooms` (Node 22.12 or later).
2. Define and create:

   ```ts
   import { createRooms, RefusedMove } from "@journey-to-code/rooms/server";

   const rooms = createRooms({
     seats: 2,
     setup: (options, seed) => newGame(options, seed),
     act: (state, seat, move, time) => { if (!legal(state, seat, move)) throw new RefusedMove("Not allowed."); return apply(state, seat, move); },
     view: (state, seat) => viewFor(state, seat),
     summary: (state) => ({ scores: state.scores }),
     bot: (state, seat) => botMove(state, seat),     // null when it isn't that seat's move
     finished: (state) => state.over,
   }, { log: sqliteLog("rooms.db", { keep: "latest" }) });
   ```

3. Mount it. Node: `if (await rooms.handle(req, res)) return;`. Fetch-style: `(await rooms.fetch(request)) ?? next()`. It answers `/rooms/*` and `/_zb/sync/*`.
4. At startup, `await rooms.restored` so rooms with a running clock come back.
5. Check: `POST /rooms` with `{"options":{}}` answers `201 {"id"}`; `GET /rooms/<id>` shows the seats; a page can sit, start and move.

## Rules

- **`setup`, `act` and `deadline` are deterministic and never read the clock or call `Math.random`.** After a restart a room is rebuilt by replaying the move log; a different result means a different game. Seeds come in as the `seed` argument; times come in as `act`'s `time` argument.
- **`view(state, seat)` returns only what that seat may see.** Never put `holders`, the seed or another seat's hand in a view, `summary`, `info` or `settings`. Check the result with a second seat in mind.
- **Throw `RefusedMove` to refuse**; the message is shown to the player as it is.
- **Use a real log in production.** The default is in memory, so every table is lost on restart.
- **Slow bots use `think`, not `bot`.** `bot` runs on the server's one thread. Give `think` its own timeout; a rejected or `null` think leaves the seat waiting.

## Optional pieces

- `watch(state, views)` with `sharedView(views, { blank, from })` for spectators; `exhibit(id)` for all-bot tables anyone may read.
- `deadline(state, table)` for turn timers and clocks: `{ after | at, seat, move() }`.
- Hooks `onMove`, `onSeats`, `onStart`, `beforeSay`, `onSay`; moderation with `closeTable`, `removePlayer`, `redact`.
- `allow(options)` to refuse a page opening a room with options you do not want.

## Reference

`docs/server.md`, `docs/bots-and-deadlines.md`, `docs/privacy.md`, `docs/http-api.md`.
