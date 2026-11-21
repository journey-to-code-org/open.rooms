---
order: 3
---

# The browser client

`@journey-to-code/rooms/client`. It has no interface: it follows a room and sends moves, so React, Vue, a Zubra component or a plain script can all use it.

## Making and opening a room

```ts
import { createRoom, openRoom } from "@journey-to-code/rooms/client";

const id = await createRoom(options, { settings });  // asks the server; resolves to the id
const room = openRoom(id);                           // follows it
```

Both take `base` (default `/rooms`) and `openRoom` also takes `sync` (default `/_zb/sync`). They must match the server's `mount` and `syncMount`. A server that refuses the options (`allow`) makes `createRoom` throw a `RoomError`.

## What a room gives you

| Member | Does |
| --- | --- |
| `info()` | The public room as the server has it now, with `seat` (the seat this browser holds, or `null`) and `now`. |
| `onRoom(fn)` | Follow the public room: seats, whether it started, the summary, the running deadline. Returns a function that stops following. |
| `onView(seat, fn)` | Follow one seat's view; only that seat's holder receives it. `onView("watch", fn)` follows what a watcher may see. |
| `onChat(fn)` | Follow the chat: every message so far, oldest first, each time one arrives. |
| `sit(seat, name)` | Take a seat. Gives this browser its player cookie and reopens the live stream so the seat's view arrives. |
| `stand()` | Give the seat back, before the game starts. |
| `addBot(seat, name?)`, `removeBot(seat)` | Fill or free a seat, before the game starts. |
| `settings(settings)` | Change the table's settings; anyone seated can, mid-game too. |
| `start()` | Deal. |
| `act(move)` | Send a move. The server decides it. |
| `say(text)` | Say something to the table. |
| `serverNow()`, `timeLeft(deadline)`, `clockOffset()`, `syncClock()` | Count down to a deadline by the **server's** clock. See [bots and deadlines](bots-and-deadlines.md#showing-the-clock). |
| `refresh()` | Pull now instead of waiting for the live stream. |
| `close()` | Stop following. |

A failed call throws a `RoomError`, with `status` and a `message` written for the person ("It isn't your turn.", "There's no table with that code.") that can be shown as it is.

## Nothing is written by the page

A page never writes a document. Every change, even sitting down, is a request that the server decides and then writes. The page's copy of the room is a read-only follower of the server's.

## What the browser loads

Worth knowing if you care about what ships to a page.

- **The server does not load the runtime.** `@journey-to-code/rooms/server` imports only `@zubra/sync/server`, and that entry imports no Zubra runtime.
- **The client does.** `@journey-to-code/rooms/client` imports `@zubra/sync` and `@zubra/sync/connect`. Both reach the main `@zubra/sync` entry (`connect` imports it), and that imports `@zubra/runtime`. Since 6.0 that runtime's reactivity is Zubra's own engine. It does not read a browser `Signal`, and loading it does not define `globalThis.Signal`. The rooms client calls none of the engine. It uses only the sync store and the connection. The engine is imported because `'use collection'` uses it; whether a bundler leaves that unused part out depends on your bundler.

## Two things learned about Sync

- **The live stream is authorized when it opens.** A browser that gets its cookie after connecting (by sitting down) keeps being treated as a stranger until it reconnects; `sit()` reopens the connection for this reason.
- **Sync has no plain-JavaScript way to follow a document yet**; documents reach `'use collection'` components. The client wraps the store (`configure({ store })`, public API) and tells subscribers about every save. The store is global to the page, so an app that calls `configure` itself after `openRoom` may replace it, and rooms would stop following. Call it before `openRoom`, or not at all.
