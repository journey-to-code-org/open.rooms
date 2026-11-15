---
order: 1
---

# Getting started

A whole room: a game, a server, and a page. The game is "Race to 10": two players take turns adding 1 or 2, and whoever reaches 10 wins.

## Install

```sh
npm install @journey-to-code/rooms
```

Node 22.12 or later. It brings `@zubra/sync`, which keeps the room's documents and sends them to browsers.

## The server

```ts
import { createServer } from "node:http";
import { createRooms, RefusedMove } from "@journey-to-code/rooms/server";

type State = { total: number; turn: number };
type Move = { add: 1 | 2 };

const rooms = createRooms<State, Move, State, { target?: number }>({
  seats: 2,
  setup: () => ({ total: 0, turn: 0 }),
  act(state, seat, move) {
    if (seat !== state.turn) throw new RefusedMove("It isn't your turn.");
    if (move.add !== 1 && move.add !== 2) throw new RefusedMove("Add 1 or 2.");
    return { total: state.total + move.add, turn: 1 - seat };
  },
  view: (state) => state, // nothing here is secret
  summary: (state) => ({ total: state.total }),
  bot: (state, seat) => (state.turn === seat ? { add: 2 } : null),
  finished: (state) => state.total >= 10,
});

createServer(async (req, res) => {
  if (await rooms.handle(req, res)) return; // /rooms/* and /_zb/sync/*
  res.writeHead(404).end();
}).listen(3000);
```

`act` is the whole rule book. It gets the state, the seat, and the move, and returns the next state, or throws to refuse (the message goes to that player). It must be deterministic, because after a restart a room is rebuilt by replaying its moves through `setup` and `act`.

On a server that speaks `Request` and `Response` (Hono, Bun, Deno), use `rooms.fetch(request)` instead: it returns a `Response`, or `null` for any path that is not the rooms'.

## The page

```ts
import { createRoom, openRoom } from "@journey-to-code/rooms/client";

const id = await createRoom({});                // the server makes the room, and answers its id
const room = openRoom(id);

room.onRoom((doc) => showSeats(doc.seats, doc.started));
const { seat } = await room.sit(0, "Ada");      // this browser now holds seat 0
await room.addBot(1);                           // or let a second person sit
await room.start();

room.onView(seat, ({ view }) => show(view));    // only this seat's view arrives
await room.act({ add: 2 });                     // the server decides; the view updates
```

## Check it works

1. `POST /rooms` with `{"options":{}}` answers `201` and `{"id":"…"}`.
2. `GET /rooms/<id>` answers the room: two empty seats, `started: false`, and the server's `now`.
3. In a page, `sit`, `addBot`, `start`: the bot moves after a short pause, and `onView` fires each time.

If the page never updates, check that `/_zb/sync/*` reaches the same server: moves go to `/rooms`, but views arrive over the sync stream.
