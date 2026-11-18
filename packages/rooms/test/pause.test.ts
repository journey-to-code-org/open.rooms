import { memoryLog } from "@zubra/sync/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRooms, RefusedMove, type MoveEvent, type RoomDefinition, type RoomsOptions } from "../src/server.js";

// Pausing a game, resuming it, and making a move for a seat at a paused table. Every test runs on a
// fake clock: time only passes when a test says so.
const T0 = Date.UTC(2026, 0, 1);
let open: { close(): void }[] = [];
beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  open.forEach((r) => r.close());
  open = [];
  vi.useRealTimers();
});
const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const BASE = "http://test";
function table<S, M>(def: RoomDefinition<S, M, any, any, any>, options: RoomsOptions = {}) {
  const rooms = createRooms(def, { seed: () => 1, id: () => "room01", botDelay: 5, ...options });
  open.push(rooms);
  const cookies: string[] = [];
  const send = async (who: number, path: string, body?: unknown) => {
    const response = (await rooms.fetch(
      new Request(BASE + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", cookie: cookies[who] ?? "" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    ))!;
    const set = response.headers.get("set-cookie");
    if (set) cookies[who] = set.split(";")[0]!;
    return { status: response.status, body: await response.json() };
  };
  return {
    rooms,
    cookies,
    post: (who: number, path: string, body: unknown = {}) => send(who, `/rooms/room01/${path}`, body),
    info: async () => (await send(0, "/rooms/room01")).body,
    moves: async () => {
      const doc = (await rooms.sync.documents()).get("moves", "room01") ?? {};
      return Object.keys(doc)
        .filter((k) => /^\d+$/.test(k))
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => doc[k] as { seat: number; move: unknown; at: number });
    },
  };
}

// The counting game, with a turn limit from the table's settings and a bot that adds 10.
interface Counting {
  total: number;
  turn: number;
}
type Add = { add: number };
const SEATS = 3;
const counting: RoomDefinition<Counting, Add, Counting, { start: number }, { total: number; turn: number }> = {
  seats: SEATS,
  setup: (options) => ({ total: options.start ?? 0, turn: 0 }),
  act(state, seat, move) {
    if (seat !== state.turn) throw new RefusedMove("Not your turn.");
    if (!Number.isInteger(move?.add) || move.add < 1) throw new RefusedMove("Add a positive number.");
    return { total: state.total + move.add, turn: (state.turn + 1) % SEATS };
  },
  view: (state) => state,
  summary: (state) => state,
  finished: (state) => state.total >= 100,
  settings: (given) => ({ limit: Number((given as { limit?: number } | undefined)?.limit) || 0 }),
  bot: (state, seat) => (state.turn === seat ? { add: 10 } : null),
  deadline: (state, { settings, seats }) => (settings.limit && !seats[state.turn]?.bot ? { after: settings.limit, seat: state.turn, move: () => ({ add: 1 }) } : null),
};

async function threePeople(def = counting, options: RoomsOptions = {}, limit = 30_000) {
  const t = table(def, options);
  await t.rooms.create({ start: 0 }, { limit });
  for (const seat of [0, 1, 2]) await t.post(seat, "sit", { seat, name: `P${seat}` });
  await t.post(0, "start");
  return t;
}

describe("pausing", () => {
  it("stops moves, with the reason, and lets chat carry on", async () => {
    const t = await threePeople(counting, {}, 0);
    expect(await t.rooms.pause("room01", "  A player is\n away  ")).toBeNull();
    expect((await t.info()).paused).toEqual({ at: T0, reason: "A player is away" });
    const refused = await t.post(0, "act", { move: { add: 5 } });
    expect(refused.status).toBe(423);
    expect(refused.body.error).toBe("The table is paused: A player is away");
    expect((await t.info()).summary).toEqual({ total: 0, turn: 0 });
    expect(await t.moves()).toEqual([]);
    expect((await t.post(1, "say", { text: "hello?" })).status).toBe(200);
    // Pausing again changes nothing (the first reason and time stand).
    await pass(1_000);
    expect(await t.rooms.pause("room01", "other")).toBeNull();
    expect((await t.info()).paused).toEqual({ at: T0, reason: "A player is away" });
  });

  it("lets moves through again after a resume", async () => {
    const t = await threePeople(counting, {}, 0);
    await t.rooms.pause("room01", "");
    expect(await t.rooms.resume("room01")).toBeNull();
    expect((await t.info()).paused ?? null).toBeNull();
    expect((await t.post(0, "act", { move: { add: 5 } })).status).toBe(200);
    expect((await t.info()).summary).toEqual({ total: 5, turn: 1 });
  });

  it("says why when it can't: no such table, not dealt, closed, over, not paused", async () => {
    const t = table(counting);
    expect(await t.rooms.pause("nope", "")).toBe("No such table.");
    expect(await t.rooms.resume("nope")).toBe("No such table.");
    await t.rooms.create({ start: 0 }, { limit: 0 });
    expect(await t.rooms.pause("room01", "")).toBe("The game hasn't started.");
    for (const seat of [0, 1, 2]) await t.post(seat, "sit", { seat, name: `P${seat}` });
    await t.post(0, "start");
    expect(await t.rooms.resume("room01")).toBe("That table isn't paused.");
    await t.post(0, "act", { move: { add: 100 } });
    expect(await t.rooms.pause("room01", "")).toBe("The game is over.");
  });

  it("refuses a pause at a closed table", async () => {
    const t = await threePeople(counting, {}, 0);
    await t.rooms.closeTable("room01", "closed");
    expect(await t.rooms.pause("room01", "")).toBe("That table is closed.");
  });
});

describe("bots", () => {
  async function withBots() {
    const t = table(counting);
    await t.rooms.create({ start: 0 }, { limit: 0 });
    await t.post(0, "sit", { seat: 0, name: "P0" });
    await t.rooms.seatBot("room01", 1, "Bot1");
    await t.rooms.seatBot("room01", 2, "Bot2");
    await t.post(0, "start");
    return t;
  }

  it("don't play while paused, and carry on when it is resumed", async () => {
    const t = await withBots();
    await t.post(0, "act", { move: { add: 1 } }); // the bot at seat 1 is about to move (5ms)
    await t.rooms.pause("room01", "look");
    await pass(10_000);
    expect((await t.info()).summary).toEqual({ total: 1, turn: 1 });
    expect(await t.moves()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await t.rooms.resume("room01");
    await pass(20);
    expect((await t.info()).summary.total).toBeGreaterThan(11);
  });

  it("don't play a move they were thinking of when the pause came", async () => {
    const thinker: RoomDefinition<Counting, Add, Counting, { start: number }, Counting> = {
      ...counting,
      bot: undefined,
      think: (state, seat) => (state.turn === seat ? new Promise((done) => setTimeout(() => done({ add: 10 }), 50)) : null),
    };
    const t = table(thinker);
    await t.rooms.create({ start: 0 }, { limit: 0 });
    await t.post(0, "sit", { seat: 0, name: "P0" });
    await t.rooms.seatBot("room01", 1, "Bot1");
    await t.rooms.seatBot("room01", 2, "Bot2");
    await t.post(0, "start");
    await t.post(0, "act", { move: { add: 1 } });
    await pass(10); // thinking
    await t.rooms.pause("room01", "");
    await pass(5_000);
    expect((await t.info()).summary).toEqual({ total: 1, turn: 1 });
    await t.rooms.resume("room01");
    await pass(200);
    expect((await t.info()).summary.total).toBeGreaterThan(1);
  });
});

describe("clocks", () => {
  it("stand still: a turn timer has the time it had left, and nothing fires while paused", async () => {
    const t = await threePeople();
    expect((await t.info()).deadline).toEqual({ at: T0 + 30_000, seat: 0 });
    await pass(20_000);
    await t.rooms.pause("room01", "");
    expect((await t.info()).deadline).toBeNull();
    await pass(10 * 60_000);
    expect((await t.info()).summary).toEqual({ total: 0, turn: 0 });
    expect(vi.getTimerCount()).toBe(0);

    await t.rooms.resume("room01");
    // 10 seconds were left when it was paused, and ten are left now.
    expect((await t.info()).deadline).toEqual({ at: T0 + 20_000 + 10 * 60_000 + 10_000, seat: 0 });
    await pass(9_999);
    expect((await t.info()).summary.total).toBe(0);
    await pass(1);
    expect((await t.info()).summary).toEqual({ total: 1, turn: 1 });
    expect((await t.info()).deadline.at).toBe(T0 + 20_000 + 10 * 60_000 + 10_000 + 30_000);
  });

  it("a move after a pause is timed without it", async () => {
    const t = await threePeople();
    await pass(5_000);
    await t.rooms.pause("room01", "");
    await pass(60_000);
    await t.rooms.resume("room01");
    await pass(5_000);
    await t.post(0, "act", { move: { add: 3 } });
    // The move happened at game time 10s: five seconds before the pause plus five after it.
    expect(await t.moves()).toEqual([{ seat: 0, move: { add: 3 }, at: T0 + 10_000 }]);
    // The next clock runs a full period from it, in server time.
    expect((await t.info()).deadline).toEqual({ at: T0 + 60_000 + 40_000, seat: 1 });
  });

  it("pauses more than once, adding the pauses up", async () => {
    const t = await threePeople();
    await pass(10_000);
    await t.rooms.pause("room01", "");
    await pass(100_000);
    await t.rooms.resume("room01");
    await pass(10_000);
    await t.rooms.pause("room01", "");
    await pass(100_000);
    await t.rooms.resume("room01");
    // 10 + 10 seconds used, 10 left.
    expect((await t.info()).deadline).toEqual({ at: T0 + 220_000 + 10_000, seat: 0 });
    await pass(10_000);
    expect((await t.info()).summary.total).toBe(1);
  });
});

// A chess clock: the banks change only through `act`'s time, so a pause must not leak into them.
interface Clocked {
  turn: number;
  bank: number[];
  moves: number;
  lostOnTime: number | null;
}
type ClockMove = { type: "move" } | { type: "flag" };
const clocked: RoomDefinition<Clocked, ClockMove, Clocked, object, Clocked> = {
  seats: 2,
  setup: () => ({ turn: 0, bank: [60_000, 60_000], moves: 0, lostOnTime: null }),
  act(state, seat, move, time) {
    if (state.lostOnTime !== null) throw new RefusedMove("The game is over.");
    if (seat !== state.turn) throw new RefusedMove("Not your turn.");
    const left = state.bank[seat]! - time.elapsed;
    const bank = state.bank.map((b, i) => (i === seat ? Math.max(0, left) : b));
    if (move.type === "flag" || left <= 0) {
      if (left > 0) throw new RefusedMove("There's time on the clock yet.");
      return { ...state, bank, lostOnTime: seat };
    }
    bank[seat] = left + 2_000;
    return { turn: 1 - seat, bank, moves: state.moves + 1, lostOnTime: null };
  },
  view: (state) => state,
  summary: (state) => state,
  finished: (state) => state.lostOnTime !== null,
  deadline: (state) => (state.lostOnTime === null ? { after: state.bank[state.turn]!, seat: state.turn, move: () => ({ type: "flag" }) } : null),
};

describe("a chess clock", () => {
  async function two(options: RoomsOptions = {}) {
    const t = table(clocked, options);
    await t.rooms.create({});
    for (const seat of [0, 1]) await t.post(seat, "sit", { seat, name: `P${seat}` });
    await t.post(0, "start");
    return t;
  }

  it("doesn't run down while paused", async () => {
    const t = await two();
    await pass(10_000);
    await t.rooms.pause("room01", "");
    await pass(30 * 60_000);
    await t.rooms.resume("room01");
    await pass(5_000);
    await t.post(0, "act", { move: { type: "move" } });
    // 15 seconds of its own time used: 60 - 15 + 2.
    expect((await t.info()).summary.bank).toEqual([47_000, 60_000]);
  });

  it("replays to the same clocks after a restart that came mid-pause and after it", async () => {
    const log = memoryLog({ keep: "latest" });
    const first = await two({ log });
    await pass(10_000);
    await first.rooms.pause("room01", "");
    await pass(60_000);
    first.rooms.close();

    // A new process, 5 minutes on, with the table still paused: it stays paused, nothing fires.
    vi.setSystemTime(T0 + 300_000);
    const second = table(clocked, { log });
    second.cookies.push(...first.cookies);
    await second.rooms.restored;
    expect((await second.info()).paused).toEqual({ at: T0 + 10_000, reason: "" });
    expect((await second.post(0, "act", { move: { type: "move" } })).status).toBe(423);
    await pass(10 * 60_000);
    expect((await second.info()).summary.lostOnTime).toBeNull();

    await second.rooms.resume("room01");
    // Fifty seconds are left; the table was paused from 10s to the resume, about 14 minutes.
    expect((await second.info()).deadline.at).toBe(Date.now() + 50_000);
    await pass(5_000);
    await second.post(0, "act", { move: { type: "move" } }); // 15 seconds of its own time
    expect((await second.info()).summary.bank).toEqual([47_000, 60_000]);
    second.rooms.close();

    // A third process replays all of it, the pause included, to the same banks.
    const third = table(clocked, { log });
    third.cookies.push(...first.cookies);
    await third.rooms.restored;
    expect(await third.info()).toMatchObject({ summary: { bank: [47_000, 60_000], turn: 1, moves: 1 } });
    expect((await third.info()).paused ?? null).toBeNull();
  });
});

describe("making a move for a seat", () => {
  it("needs the table paused first", async () => {
    const t = await threePeople(counting, {}, 0);
    expect(await t.rooms.moveFor("room01", 0, { add: 4 })).toBe("Pause the table first.");
    expect((await t.info()).summary.total).toBe(0);
  });

  it("goes through the game's rules, into the move log and out as the admin's", async () => {
    const seen: Pick<MoveEvent<unknown, unknown, unknown>, "seat" | "admin" | "timeout">[] = [];
    const t = await threePeople(counting, { onMove: (e) => void seen.push({ seat: e.seat, admin: e.admin, timeout: e.timeout }) }, 0);
    await t.rooms.pause("room01", "stepping in");
    expect(await t.rooms.moveFor("room01", 1, { add: 4 })).toBe("Not your turn.");
    expect(await t.rooms.moveFor("room01", 0, { add: 0 })).toBe("Add a positive number.");
    expect(await t.rooms.moveFor("room01", 9, { add: 4 })).toBe("No such seat.");
    expect((await t.info()).summary.total).toBe(0);

    expect(await t.rooms.moveFor("room01", 0, { add: 4 })).toBeNull();
    expect((await t.info()).summary).toEqual({ total: 4, turn: 1 });
    expect(await t.moves()).toEqual([{ seat: 0, move: { add: 4 }, at: T0 }]);
    expect(seen).toEqual([{ seat: 0, admin: true, timeout: undefined }]);
    // Still paused: the players can't move, the next seat's turn waits.
    expect((await t.info()).paused).toBeTruthy();
    expect((await t.post(1, "act", { move: { add: 1 } })).status).toBe(423);
    await t.rooms.resume("room01");
    expect((await t.post(1, "act", { move: { add: 1 } })).status).toBe(200);
  });

  it("is replayed after a restart like any move", async () => {
    const log = memoryLog({ keep: "latest" });
    const first = await threePeople(counting, { log }, 0);
    await first.rooms.pause("room01", "");
    await first.rooms.moveFor("room01", 0, { add: 7 });
    await first.rooms.resume("room01");
    await first.post(1, "act", { move: { add: 2 } });
    first.rooms.close();
    const second = table(counting, { log });
    second.cookies.push(...first.cookies);
    expect((await second.info()).summary).toEqual({ total: 9, turn: 2 });
  });

  it("ending the game takes the pause away", async () => {
    const t = await threePeople(counting, {}, 0);
    await t.rooms.pause("room01", "");
    expect(await t.rooms.moveFor("room01", 0, { add: 100 })).toBeNull();
    const info = await t.info();
    expect(info.summary.total).toBe(100);
    expect(info.paused ?? null).toBeNull();
  });

  it("makes the move for a bot's seat too, and the bots wait for the resume", async () => {
    const t = table(counting);
    await t.rooms.create({ start: 0 }, { limit: 0 });
    await t.post(0, "sit", { seat: 0, name: "P0" });
    await t.rooms.seatBot("room01", 1, "Bot1");
    await t.rooms.seatBot("room01", 2, "Bot2");
    await t.post(0, "start");
    await t.post(0, "act", { move: { add: 1 } });
    await t.rooms.pause("room01", "");
    expect(await t.rooms.moveFor("room01", 1, { add: 5 })).toBeNull();
    await pass(5_000);
    expect((await t.info()).summary).toEqual({ total: 6, turn: 2 });
    await t.rooms.resume("room01");
    await pass(20);
    // Bot 2 played its 10 and the turn is back with the person at seat 0.
    expect((await t.info()).summary).toEqual({ total: 16, turn: 0 });
  });
});

describe("telling the table", () => {
  it("announces in the chat as the server, not as a seat, and numbers it with the rest", async () => {
    const t = await threePeople(counting, {}, 0);
    await t.post(1, "say", { text: "hi" });
    expect(await t.rooms.announce("room01", "  The host   paused the game.  ")).toMatchObject({ seat: -1, name: "The host", text: "The host paused the game.", notice: true, bot: false });
    await t.post(2, "say", { text: "ok" });
    const chat = (await t.rooms.sync.documents()).get("chat", "room01")!;
    expect(Object.keys(chat).sort()).toEqual(["m000000", "m000001", "m000002"]);
    expect((chat.m000001 as { notice?: boolean; text: string }).text).toBe("The host paused the game.");
    expect((chat.m000000 as { notice?: boolean }).notice).toBeUndefined();
  });

  it("says why it can't: nothing to say, no such table", async () => {
    const t = await threePeople(counting, {}, 0);
    expect(await t.rooms.announce("room01", "   ")).toBe("Say something first.");
    expect(await t.rooms.announce("nope", "hello")).toBe("No such table.");
    expect(await t.rooms.announce("room01", "x".repeat(500))).toMatchObject({ text: "x".repeat(280) });
  });
});
