# open.rooms

Realtime multiplayer rooms for turn-based games.

A room has seats, takes moves that the server decides, shows each seat a private view of the game,
fills empty seats with computer players, and keeps a log of every move so a room can be replayed or
picked up again after a restart. It is built on [Zubra](https://github.com/journey-to-code-org/zubra)'s
sync layer and plays the games from [open.games](https://github.com/journey-to-code-org/open.games),
but knows nothing about any particular game.

## Packages

| Package | What it is |
| --- | --- |
| [`@journey-to-code/rooms`](packages/rooms) | Rooms: `createRooms` on the server, `createRoom` and `openRoom` in the browser |

Nothing is published to npm yet.

## Working on it

Node 22.12 or later.

```sh
npm install
npm run build
npm run typecheck
npm test
```

## History

`rooms` was moved here from open.parlor (formerly Card Room) with its history, and renamed from
`@spades/rooms`. open.parlor still uses its own copy until it is switched over.
