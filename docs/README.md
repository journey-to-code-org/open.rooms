---
title: open.rooms
order: 0
---

# open.rooms

Realtime multiplayer rooms for turn-based games.

A room has seats, takes moves that the server decides, shows each seat a private view of the game, fills empty seats with computer players, and keeps a log of every move so a room can be replayed or picked up again after a restart. It is built on [Zubra](https://github.com/zubra-js/zubra)'s sync layer and plays the games from [open.games](https://github.com/journey-to-code-org/open.games), but knows nothing about any particular game: a room is defined by a handful of functions.

One package: `@journey-to-code/rooms`, with a server (`/server`) and a browser client (`/client`).

## Pages

- [Getting started](getting-started.md): a whole room, server and page, in one small game.
- [The server](server.md): what a room definition is, the options, and what the server gives you back.
- [The browser client](client.md): `createRoom`, `openRoom`, and what the page loads.
- [Bots and deadlines](bots-and-deadlines.md): computer players, slow thinking, turn timers and clocks.
- [Privacy](privacy.md): how a hand stays in one browser, and how people watch.
- [The HTTP API](http-api.md): the routes, for a client written in something else.
- [Releasing](releasing.md): how a version reaches npm.
- [For agents](agents.md): the skills in `.agents/` that let a coding agent use and maintain this.

## Status

Version 0.1. Its API is still settling while a spades game shapes it. [MIT](https://github.com/journey-to-code-org/open.rooms/blob/main/LICENSE).
