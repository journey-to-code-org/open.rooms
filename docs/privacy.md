---
order: 5
---

# Privacy and watching

## How a hand stays private

| Collection | Holds | Who reads it |
| --- | --- | --- |
| `rooms/<id>` | seats, started, summary, the deadline that is running | everyone |
| `views/<id>/<seat>` | one seat's view | that seat's holder |
| `games/<id>` | options, seed, seat holders | the server |
| `moves/<id>` | every move and when it was decided, one field each | the server |
| `chat/<id>` | the table's chat, one field per message | everyone |

- **Pages never write.** Every page push is refused. Moves go to `POST /rooms/<id>/act`, and the server writes the result.
- **A seat is a cookie.** Sitting down sets an HttpOnly `rooms_player` cookie (a year, `SameSite=Lax`, and `Secure` over HTTPS, including behind a proxy that sets `x-forwarded-proto`), and a request can read a seat's view only when its cookie holds that seat. `newPlayerId()`, `playerCookie()` and `playerOf()` let your app use the same identity.
- **Moves cannot interleave.** The server decides a move and records it with no `await` in between.
- **Finished games leave memory.** With `finished`, a room's state is dropped once the game ends; a later request replays it from the log.
- **`seed` and `holders` stay on the server.** Do not put either in a view, a summary or `info`.

What a view contains is your game's decision. `view(state, seat)` must leave out everything that seat may not see, and a mistake there leaks it to that seat's holder only. Nothing else is sent to a seat.

## Letting people watch

Give the room `watch(state, views)` and the server writes one more view after each move, `views/<id>/watch`, that anyone may read. A page follows it with `room.onView("watch", …)`. Pass `spectators()` in the options to say otherwise at any moment.

`sharedView(views, { blank, from })` builds that view from every seat's: what all the seats see alike is kept, and what differs between them becomes `null` or an empty list, so a watcher learns nothing that every player does not already know. Name the private parts in `blank` as well (two hands that happened to match in some detail would otherwise show it), and in `from` the keys that say where the viewer sits.

A table that is all computer players can be opened right up instead: `exhibit(id)` lets anyone read every seat's view.

## Moderation

`closeTable(id, reason)` closes a table for good, `removePlayer(id, seat)` takes a person out of a seat (a bot plays on after the deal), `redact(id, key)` takes the words out of a chat message, and `beforeSay` can turn a message away. A table's `muted` seats, `host` and `open` flags are set by your app and are only for your pages to read.

**Pausing.** `pause(id, reason)` holds a game that is being played: moves are refused with `423` and the reason, bots stop (a move one was thinking of is dropped), and no deadline fires. Chat carries on. Pages see `paused: { at, reason }` on the room (public, so say nothing in the reason you would not say at the table) and `deadline: null`. The game's own clock stands still: a turn timer has the time it had left when `resume(id)` arms it again, and `act` sees no pause in `time.elapsed`, so a chess bank is not charged for it. A pause survives a restart. `moveFor(id, seat, move)` then lets the server's admin make a move for a seat, for a player who has gone or a game that is stuck; it needs the table paused so that no bot or clock moves at the same time, and it is logged and replayed like any move. Your app should tell the players (the admin app of open.parlor puts a notice in the table's chat).
