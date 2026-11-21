---
name: rooms-client
description: Build the browser side of an open.rooms table. Use when calling createRoom or openRoom, showing seats, a seat's private view, chat or a deadline clock, or sending moves from a page.
---

`@journey-to-code/rooms/client` follows a room and sends moves. It has no interface and works with React, Vue, Zubra components or plain script.

## Steps

1. The server must be mounted first (`rooms-server`). `base` and `sync` must equal its `mount` and `syncMount` (defaults `/rooms` and `/_zb/sync`).
2. Make or open a room:

   ```ts
   import { createRoom, openRoom } from "@journey-to-code/rooms/client";
   const id = await createRoom(options);
   const room = openRoom<View, Move, Summary>(id);
   ```

3. Follow and act:

   ```ts
   room.onRoom((doc) => render(doc.seats, doc.started));
   const { seat } = await room.sit(0, "Ada");          // sets the player cookie, reopens the stream
   room.onView(seat, ({ view }) => render(view));      // only this seat's view arrives
   await room.start();
   await room.act(move);
   ```

   Each `on…` returns a function that stops following; call it when the screen goes away. `room.close()` stops everything.
4. Check: sit in one browser and a private window; each sees its own view and not the other's.

## Rules

- **Never write documents from the page.** Everything is a request the server decides, including sitting.
- **Show `RoomError.message` as it is.** It is written for the player ("It isn't your turn.").
- **Count a clock down by the server's time**: `room.timeLeft(doc.deadline)`, not `Date.now()`. A phone's clock can be minutes out.
- **Follow the seat from `sit()`'s answer or `info().seat`.** The cookie is HttpOnly; the page cannot read it.
- **Call `configure` from `@zubra/sync` before `openRoom`, or not at all.** The client wraps the sync store, and a later `configure` replaces it.

## What the page loads

The client imports `@zubra/sync` and `@zubra/sync/connect`, and both load `@zubra/runtime`. Since 6.0 that runtime's reactivity is Zubra's own engine. It does not read a browser `Signal`, and loading it does not define `globalThis.Signal`. The rooms client uses none of the engine, but the import is in the dependency graph. The server loads none.

## Reference

`docs/client.md`, `docs/bots-and-deadlines.md#showing-the-clock`.
