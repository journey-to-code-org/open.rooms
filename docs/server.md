---
order: 2
---

# The server

`createRooms(definition, options?)` from `@journey-to-code/rooms/server`. One call makes one kind of room; each table opened with it is a room.

## The definition

A room is defined by functions. Only the first four are needed.

| Member | Does |
| --- | --- |
| `seats` | How many seats: a number, or a function of the room's options (a game for 2 to 6). |
| `setup(options, seed)` | A new game's state, from the options the room was made with and a random seed. |
| `act(state, seat, move, time)` | Apply a move and return the next state. Throw (a `RefusedMove`, or any `Error`) to refuse; the message goes to the player. `time` is `{ at, elapsed }`. |
| `view(state, seat)` | What that seat may see. |
| `summary(state)` | What everyone may see: scores, for a lobby. |
| `info(options)` | What everyone may see before the game starts: its rules, say. |
| `settings(given)` | A table's settings (bot skill, speed), checked and defaulted. Public; anyone seated can change them. |
| `bot(state, seat, name, settings)` | A bot's move for that seat, or `null` when it is not that seat's move. |
| `think(state, seat, name, settings, thinking)` | `bot`, for moves that take a while. See [bots and deadlines](bots-and-deadlines.md). |
| `botDelay(state, seat, name, settings)` | How long a bot takes over a move, in ms. Default 700. |
| `finished(state)` | Whether the game is over. A finished room leaves memory; the log keeps it. |
| `deadline(state, table)` | What happens if nobody moves. See [bots and deadlines](bots-and-deadlines.md). |
| `watch(state, views)` | What someone watching may see. Without it a table cannot be watched. See [privacy](privacy.md). |

**`act` and `deadline` must be deterministic and must not read the clock.** A restart rebuilds a room by replaying `setup` and every logged move, so the same moves must give the same state. A game that needs times keeps them from `act`'s `time` argument.

## The options

Everything is optional.

| Option | Default | Use |
| --- | --- | --- |
| `mount` | `"/rooms"` | Where the routes live. |
| `syncMount` | `"/_zb/sync"` | Where the sync stream lives. Match the client's `sync`. |
| `log` | in memory | The sync log. **Pass a real one for anything that should survive a restart**, such as `sqliteLog("rooms.db", { keep: "latest" })` from `@zubra/sync/sqlite`. |
| `botDelay` | the room's | A fixed pause for every bot. For tests. |
| `deadlineGrace` | `5000` | The least warning, in ms, when a deadline arrives with no notice (after a restart, or a changed setting). |
| `spectators()` | allowed | Return `false` to stop people who are not at a table from reading its watch view. |
| `allow(options)` | allow all | Return a reason to refuse a page opening a room with these options, or `null`. Server code's own `create` is not asked. |
| `seed()` | random | Seeds for new games. |
| `id()` | six random letters and digits | Room ids. |

Hooks, all called after the fact, and a throwing hook is logged and never breaks the room:

| Hook | When |
| --- | --- |
| `onMove({ id, before, after, seat, move, room, timeout? })` | After every move is published. `timeout` is true when the server made it. |
| `onSeats({ id, room })` | Someone sat, stood up, or a bot was added or removed before the game started. |
| `onStart({ id, state, room })` | After a game starts. |
| `beforeSay({ id, seat, text, room })` | Before a message joins the chat. Return the text to post, or `{ error }` to turn it away. |
| `onSay({ id, message, room })` | After a person (not a bot) says something. |

## What you get back

| Member | Does |
| --- | --- |
| `handle(req, res)` | For Node's `http`. Answers rooms and sync routes and resolves `true`; any other path resolves `false`. |
| `fetch(request)` | The same for `Request` and `Response`. Returns `null` for other paths. |
| `create(options, settings?)` | Open a room from server code, such as a house opening a table. Resolves to its id. |
| `start(id)` | Deal. Resolves to a problem, or `null`. |
| `say(id, seat, text)` | Add a chat message as a seat. Bots speak through this. |
| `seatPlayer(id, seat, player, name)`, `seatBot(id, seat, name)` | Seat someone from server code, before the game starts. |
| `unseat(id, seat)`, `replaceWithBot(id, seat, name)` | Free a seat, or put a bot in it at any point. |
| `lock(id, label?)` | Fix the seats for good (a tournament match) and name the table. |
| `exhibit(id, label?)` | Make an all-bot table anyone can watch with every seat's view. |
| `setDeck(id, deck)` | Set what the cards look like at a table; the app's pages decide what it means. |
| `closeTable(id, reason)` | Close a table for good. Every later seat, move or message is refused with `reason`. |
| `removePlayer(id, seat, bot?)` | Take a person out of a seat. After the deal a bot plays on in their place. |
| `redact(id, key)` | Take the words out of a chat message. |
| `holders(id)` | The player ids holding each seat. **Never send these to a page.** |
| `room(id)` | The public room document. |
| `nudge(id)` | Get a table's bots moving again (after a restart, nothing wakes a table of bots only). |
| `restored` | A promise that resolves once rooms that had a deadline running have theirs again. `await` it at startup. |
| `inMemory` | How many rooms have state in memory. |
| `close()` | Stop bot timers and deadlines, for shutdown and tests. |
| `sync` | The underlying sync server. |

Also exported: `RefusedMove`, `sharedView`, `newPlayerId`, `playerCookie`, `playerOf`, `overHttps`, `CHAT_LIMIT` (280 characters) and `REMOVED_TEXT`.

## Chat

Seated players can chat, up to 280 characters, one message about every 400 ms. Use `beforeSay` to moderate and `redact` to take a message back. Closed tables take no chat.
