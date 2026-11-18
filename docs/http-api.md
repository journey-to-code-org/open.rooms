---
order: 6
---

# The HTTP API

The routes `createRooms` answers, for a client written in something else. Paths are relative to `mount` (default `/rooms`). Bodies and answers are JSON. A failure is a non-2xx status with `{ "error": "words for the person" }`.

| Route | Does |
| --- | --- |
| `POST /` | Open a room. Body `{ options, settings? }`. Answers `201 { id }`. `403` if `allow` refused. |
| `GET /<id>` | The public room, with `seat` (this browser's, or `null`) and `now` (the server's clock in ms). |
| `POST /<id>/sit` | `{ seat, name }`. Sets the `rooms_player` cookie if the browser has none. Name is cut to 20 characters. |
| `POST /<id>/stand` | Give up the seat, before the game starts. |
| `POST /<id>/bot` | `{ seat, name?, add? }`. Add a bot (or remove it with `add: false`), before the game starts. |
| `POST /<id>/settings` | `{ settings }`. Change the table's settings. |
| `POST /<id>/start` | Deal. |
| `POST /<id>/act` | `{ move }`. Send a move. |
| `POST /<id>/say` | `{ text }`. Say something. Answers the message. |

The room's documents are served by the sync stream at `syncMount` (default `/_zb/sync`), which is what `onRoom`, `onView` and `onChat` follow.

## Statuses

| Status | When |
| --- | --- |
| 400 | A move that `act` refused (with its message), a seat that does not exist, or a chat message that was not accepted. |
| 403 | No seat yet ("Take a seat first."), or `beforeSay` turned the message away. |
| 404 | No such table, or an unknown route. |
| 409 | The seat is taken, the game has started or has not started, or the seats are locked. |
| 410 | The table was closed; the body says why. |
| 423 | The game is paused by the server's admin; the body says why. Chat still works. |
| 429 | Chat faster than about one message every 400 ms. |

Everything except opening a room and reading it needs the seat's cookie. A request with no seat gets `403`.
