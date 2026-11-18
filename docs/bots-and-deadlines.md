---
order: 4
---

# Bots and deadlines

## Computer players

Give the room `bot(state, seat, name, settings)`. It returns that seat's move, or `null` when it is not that seat's move. A page fills a seat with `room.addBot(seat)`, and server code with `seatBot`. A bot waits `botDelay` (700 ms unless the room says otherwise) before moving, so it feels like a person, and its move goes through `act` and into the log like any other.

`bot` runs on the server's one thread. That is fine for a move that is quick to find.

## Bots that take a while

For a move that is not quick, give the room `think` as well. It is asked in `bot`'s place and may answer later.

```ts
think: (state, seat, name, settings, { signal, table }) =>
  state.turn !== seat ? null                     // not this seat's move: say so at once
  : pool.think({ state, seat }, { signal, table }), // a promise of the move (a worker thread, say)
```

- **The pause hides the think.** The room asks as the bot's pause begins and plays the move when both are done, so a think shorter than the pause costs the table nothing.
- **Only on the state it was for.** If the game moved on while the bot thought (someone moved, a deadline fired), the answer is dropped and the bot is asked again about the table as it is now, with no second pause. If the bot was stopped (the game finished, the settings changed, its seat changed hands, the table closed, the server restarted), the answer is dropped and that is all. `signal` aborts either way, for a think that can be cancelled.
- **Still a move like any other.** It goes through `act` and into the move log.
- A deadline's `move()` is worked out there and then, on the server's thread: it never waits behind anyone's think.
- A promise that rejects, or resolves `null`, is logged and leaves the seat waiting. Resolve a move, whatever happens.

`table` is the room's id, so a shared pool of workers can share its time fairly between tables.

## Deadlines

A room waits for its seats for ever unless its definition has a `deadline`: by when, and the move the server makes for which seat if nothing else happens first. A turn timer, a flag falling on a chess clock, a window for claiming a discard and "a day a move" are all this.

```ts
createRooms({
  // ...
  act(state, seat, move, time) { /* time = { at, elapsed } */ },
  deadline: (state, { settings, seats }) =>
    state.over ? null : { after: settings.limit, seat: state.turn, move: () => botMove(state, state.turn) },
});
```

| Field | Meaning |
| --- | --- |
| `after` | Ms after the last move (or the deal). "30 seconds a turn" is `after: 30_000`; a chess clock is `after: state.bank[state.turn]`. |
| `at` | Instead of `after`: a server time, for a state that keeps times itself. |
| `seat` | Whose clock it is. The timeout move is made as this seat. |
| `grace` | Optional: ms the server waits past that time before it makes the move. For clocks of a few seconds. |
| `move()` | The move, worked out only when time runs out. `null`: nothing happens, and the room waits. |

- **One timer a room.** The server asks for the deadline after every move, arms one timer, and puts it away when the game finishes. It is separate from the bot's timer; both can be waiting.
- **A timeout is a move.** It goes through `act`, into the move log, and out through `onMove` (with `timeout: true`), so a replay gives the same game.
- **Never both.** A move puts the deadline away in the same breath that it is decided, and the timer checks it is still the armed one before it moves: a move and a timeout cannot both land on one state.
- **Moves have times.** `act`'s fourth argument is `{ at, elapsed }`: the server time the move was decided, and the ms since the move before it. The log keeps `at`, and a replay hands `act` the same numbers, so a state may hold clocks as long as they change only by `elapsed`. `deadline` and `act` must never read the clock themselves.
- **Restarts.** The clock keeps running while the server is down: a deadline counts from the last move's logged time, not from the restart, so nobody gets a fresh period (and a chess bank loses the downtime). Rooms that had a deadline running are restored when the server starts, without waiting for a request: `await rooms.restored`. If the time has already passed, the seat gets `deadlineGrace` (default 5 seconds) from the restart before the timeout move is made.
- **Pauses.** `pause(id)` stops every clock. The game keeps *game time*, the server's clock less the time spent paused (kept in the game document), and `act`'s `time.at` is game time; so are `after` and `at` in a deadline. A move's logged `at` is game time too, so a replay reproduces the same clocks whether or not the game was ever paused. Pages are told the deadline in server time as before. A game that was never paused is unchanged: its game time is the server's.
- **Settings.** A deadline may depend on the table's settings. It is worked out again when they change, without restarting the clock.

Timers cannot sleep longer than about 24.8 days, so a longer deadline wakes and waits again. A deadline that throws is logged and treated as none.

## Showing the clock

Pages see when, never what: the public room has `deadline: { at, seat } | null`, in **server time**. A phone's clock can be minutes out, so count down by the server's:

```ts
room.onRoom((doc) => show(doc.deadline?.seat, room.timeLeft(doc.deadline)));  // ms left, never below zero
room.serverNow();       // the server's time, as near as this browser can tell
room.clockOffset();     // how far ahead the server's clock is, in ms
await room.syncClock(); // ask again (after the phone slept)
```

Every `info()` answer carries the server's time; the client takes the quickest round trip it has seen as the most trustworthy.
