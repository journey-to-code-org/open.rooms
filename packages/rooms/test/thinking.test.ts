// A bot whose move arrives later (RoomDefinition.think): the pause and the think run together, and
// an answer is only ever played on the state it was asked for.
import { memoryLog } from "@zubra/sync/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRooms, RefusedMove, type RoomDefinition, type RoomsOptions } from "../src/server.js";

// A free-for-all: anyone adds to the total whenever they like, until it reaches the goal. A move
// says what total it was made for, and the game refuses one made for any other: a bot's answer
// played on the wrong state would show up as a refused move.
interface State {
  total: number;
  goal: number;
}
type Move = { add: number; saw: number };
interface Asked {
  state: State;
  seat: number;
  name: string;
  settings: any;
  signal: AbortSignal;
  at: number;
  /** Answer with the move a bot would make for the state it was asked about. */
  answer(): void;
  resolve(move: Move | null): void;
  reject(error: Error): void;
}

function game(extra: Partial<RoomDefinition<State, Move, State, { goal?: number }, State>> = {}) {
  const asked: Asked[] = [];
  const def: RoomDefinition<State, Move, State, { goal?: number }, State> = {
    seats: 2,
    setup: (options) => ({ total: 0, goal: options.goal ?? 100 }),
    act(state, _seat, move) {
      if (state.total >= state.goal) throw new RefusedMove("It's over.");
      if (move.saw !== state.total) throw new RefusedMove(`That move was for ${move.saw}, and the total is ${state.total}.`);
      return { ...state, total: state.total + move.add };
    },
    view: (state) => state,
    summary: (state) => state,
    finished: (state) => state.total >= state.goal,
    settings: (given) => ({ step: Number((given as { step?: number } | null)?.step) || 1 }),
    bot: (state, _seat, _name, settings) => (state.total >= state.goal ? null : { add: settings?.step ?? 1, saw: state.total }),
    think(state, seat, name, settings, thinking) {
      if (state.total >= state.goal) return null;
      return new Promise<Move | null>((resolve, reject) => {
        asked.push({ state, seat, name, settings, signal: thinking.signal, at: Date.now(), resolve, reject, answer: () => resolve({ add: settings?.step ?? 1, saw: state.total }) });
      });
    },
    ...extra,
  };
  return { def, asked };
}

const BASE = "http://test";
let open: { close(): void }[] = [];
afterEach(() => {
  open.forEach((r) => r.close());
  open = [];
  vi.restoreAllMocks();
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A table with a person in seat 0 and a bot in seat 1, dealt. */
async function table(def: RoomDefinition<State, Move, State, { goal?: number }, State>, options: RoomsOptions = {}, goal = 100) {
  const rooms = createRooms(def, { botDelay: 30, id: () => "think1", ...options });
  open.push(rooms);
  let cookie = "";
  const post = async (path: string, body: unknown = {}) => {
    const response = (await rooms.fetch(new Request(BASE + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", cookie } })))!;
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return { status: response.status, body: await response.json() };
  };
  const { id } = (await post("/rooms", { options: { goal } })).body;
  await post(`/rooms/${id}/sit`, { seat: 0, name: "Ann" });
  await post(`/rooms/${id}/bot`, { seat: 1, name: "Bot" });
  await post(`/rooms/${id}/start`);
  const total = async () => ((await rooms.room(id))!.summary as State).total;
  const moves = async () => {
    const log = (await rooms.sync.documents()).get("moves", id) ?? {};
    return Object.keys(log).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b)).map((k) => log[k] as { seat: number; move: Move });
  };
  /** The person adds one. */
  const add = async () => post(`/rooms/${id}/act`, { move: { add: 1, saw: await total() } });
  return { rooms, id, post, total, moves, add };
}

describe("a bot that thinks somewhere else", () => {
  it("starts thinking as its pause starts, and plays when both are done: a quick think hides in the pause", async () => {
    const { def, asked } = game();
    const t = await table(def, { botDelay: 250 });
    const dealt = Date.now();
    await wait(10);
    expect(asked).toHaveLength(1); // asked at once, not when the pause ends
    expect(asked[0]!.at).toBeLessThan(dealt + 10);
    asked[0]!.answer();
    await wait(30);
    expect(await t.total()).toBe(0); // the answer is in, the pause isn't over
    await wait(300);
    expect(await t.total()).toBe(1);
    expect(await t.moves()).toEqual([{ seat: 1, move: { add: 1, saw: 0 }, at: expect.any(Number) }]);
    // And it's asked again for its next move.
    expect(asked).toHaveLength(2);
    expect(asked[1]!.state.total).toBe(1);
  });

  it("plays a think longer than the pause the moment it arrives", async () => {
    const { def, asked } = game();
    const t = await table(def, { botDelay: 10 });
    await wait(60);
    expect(await t.total()).toBe(0);
    expect(asked).toHaveLength(1); // still the one think: nothing asks twice while it waits
    asked[0]!.answer();
    await wait(15);
    expect(await t.total()).toBe(1);
  });

  it("drops an answer when a person moved first, and asks again for the table as it is", async () => {
    const refused = vi.spyOn(console, "error").mockImplementation(() => {});
    const { def, asked } = game();
    const t = await table(def, { botDelay: 10 });
    await wait(30); // the pause is over; the bot is still thinking about total 0
    expect((await t.add()).status).toBe(200);
    expect(await t.total()).toBe(1);
    asked[0]!.answer(); // a move for total 0
    await wait(15);
    // It wasn't played (the game would have refused it, and said so)...
    expect(await t.total()).toBe(1);
    expect(refused).not.toHaveBeenCalled();
    expect(asked[0]!.signal.aborted).toBe(true);
    // ...the bot was asked again, about total 1, and that answer is played with no second pause.
    expect(asked).toHaveLength(2);
    expect(asked[1]!.state.total).toBe(1);
    asked[1]!.answer();
    await wait(5);
    expect(await t.total()).toBe(2);
    expect((await t.moves()).map((m) => [m.seat, m.move.saw])).toEqual([[0, 0], [1, 1]]);
  });

  it("drops an answer for a state that moved on during the pause, without waiting for it", async () => {
    const { def, asked } = game();
    const t = await table(def, { botDelay: 40 });
    await wait(5);
    await t.add(); // mid-pause
    await wait(60);
    // The pause wasn't restarted: when it ended the bot was asked about the new table at once.
    expect(asked).toHaveLength(2);
    expect(asked[0]!.signal.aborted).toBe(true);
    asked[0]!.answer(); // late, and for nothing
    asked[1]!.answer();
    await wait(10);
    expect(await t.total()).toBe(2);
    expect((await t.moves()).map((m) => [m.seat, m.move.saw])).toEqual([[0, 0], [1, 1]]);
  });

  it("drops an answer when a deadline's move got in first", async () => {
    const { def, asked } = game({
      // Whoever is in seat 0 has 40 ms; then the server adds 5 for them.
      deadline: (state) => (state.total === 0 ? { after: 40, seat: 0, move: () => ({ add: 5, saw: state.total }) } : null),
    });
    const t = await table(def, { botDelay: 5 });
    await wait(80);
    expect(await t.total()).toBe(5); // the timeout move
    asked[0]!.answer(); // the bot's move for total 0
    await wait(15);
    expect(await t.total()).toBe(5);
    expect(asked[1]!.state.total).toBe(5);
    asked[1]!.answer();
    await wait(5);
    expect((await t.moves()).map((m) => [m.seat, m.move.saw])).toEqual([[0, 0], [1, 5]]);
  });

  it("a timed-out seat's move never waits for a bot's think", async () => {
    const { def, asked } = game({ deadline: (state) => (state.total === 0 ? { after: 30, seat: 0, move: () => ({ add: 5, saw: state.total }) } : null) });
    const t = await table(def, { botDelay: 5 });
    await wait(70);
    // The bot has been thinking the whole time and still is; the deadline's move went in on time.
    expect(asked).toHaveLength(1);
    expect(await t.total()).toBe(5);
    expect((await t.moves())[0]).toMatchObject({ seat: 0, move: { add: 5 } });
  });

  it("drops an answer when the game ended meanwhile, and asks for nothing more", async () => {
    const refused = vi.spyOn(console, "error").mockImplementation(() => {});
    const { def, asked } = game();
    const t = await table(def, { botDelay: 5 }, 1); // first to 1
    await wait(20);
    await t.add(); // the person ends it
    expect(asked[0]!.signal.aborted).toBe(true);
    asked[0]!.answer();
    await wait(20);
    expect(await t.total()).toBe(1);
    expect(await t.moves()).toHaveLength(1);
    expect(asked).toHaveLength(1);
    expect(refused).not.toHaveBeenCalled();
    expect(t.rooms.inMemory).toBe(0);
  });

  it("drops an answer when the settings changed, and thinks again with the new ones", async () => {
    const { def, asked } = game();
    const t = await table(def, { botDelay: 5 });
    await wait(20);
    await t.post(`/rooms/${t.id}/settings`, { settings: { step: 7 } });
    expect(asked[0]!.signal.aborted).toBe(true);
    asked[0]!.answer(); // would add 1
    await wait(20);
    expect(await t.total()).toBe(0);
    expect(asked).toHaveLength(2);
    expect(asked[1]!.settings).toEqual({ step: 7 });
    asked[1]!.answer();
    await wait(20);
    expect(await t.total()).toBe(7);
  });

  it("drops an answer when the table was closed", async () => {
    const { def, asked } = game();
    const t = await table(def, { botDelay: 5 });
    await wait(20);
    await t.rooms.closeTable(t.id, "Closed by the host.");
    expect(asked[0]!.signal.aborted).toBe(true);
    asked[0]!.answer();
    await wait(20);
    expect(await t.moves()).toHaveLength(0);
    expect(asked).toHaveLength(1);
  });

  it("drops an answer when the seat changed hands, and the new bot thinks for itself", async () => {
    const { def, asked } = game();
    const t = await table(def, { botDelay: 5 });
    await wait(20);
    // The person leaves too: a bot takes their seat, which stops and restarts the table's bots.
    await t.rooms.replaceWithBot(t.id, 0, "Robo");
    expect(asked[0]!.signal.aborted).toBe(true);
    await wait(20);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({ seat: 0, name: "Robo" });
    asked[0]!.answer();
    await wait(10);
    expect(await t.total()).toBe(0); // the old answer went nowhere
    asked[1]!.answer();
    await wait(20);
    expect((await t.moves()).map((m) => m.seat)).toEqual([0]);
  });

  it("picks a game up after a restart with a think in flight: the old answer is lost, the bot is asked again", async () => {
    const log = memoryLog({ keep: "latest" });
    const first = game();
    const t = await table(first.def, { botDelay: 5, log });
    await wait(20);
    expect(first.asked).toHaveLength(1);
    t.rooms.close(); // the server stops mid-think

    const second = game();
    const rooms = createRooms(second.def, { botDelay: 5, log });
    open.push(rooms);
    rooms.nudge(t.id);
    await wait(30);
    expect(second.asked).toHaveLength(1);
    expect(second.asked[0]!.state.total).toBe(0);
    first.asked[0]!.answer(); // the old server's think, finishing after it stopped
    await wait(20);
    expect(((await rooms.room(t.id))!.summary as State).total).toBe(0);
    second.asked[0]!.answer();
    await wait(20);
    expect(((await rooms.room(t.id))!.summary as State).total).toBe(1);
    const moves = (await rooms.sync.documents()).get("moves", t.id) ?? {};
    expect(Object.keys(moves).filter((k) => /^\d+$/.test(k))).toEqual(["0"]);
  });

  it("leaves the seat waiting, and the server standing, when a think fails", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const { def, asked } = game();
    const t = await table(def, { botDelay: 5 });
    await wait(20);
    asked[0]!.reject(new Error("the engine fell over"));
    await wait(20);
    expect(said).toHaveBeenCalledWith(expect.stringContaining("couldn't think"), expect.any(Error));
    expect(await t.total()).toBe(0);
    // The table isn't stuck for good: the next move anyone makes gets the bots going again.
    await t.add();
    await wait(20);
    expect(asked).toHaveLength(2);
    asked[1]!.answer();
    await wait(10);
    expect(await t.total()).toBe(2);
  });

  it("takes a move given at once just as it takes `bot`'s, and uses `think` in its place", async () => {
    const calls: string[] = [];
    const { def } = game({
      bot: () => {
        calls.push("bot");
        return null;
      },
      think: (state, _seat, _name, settings) => {
        calls.push("think");
        return state.total >= state.goal ? null : { add: settings?.step ?? 1, saw: state.total };
      },
    });
    const t = await table(def, { botDelay: 5 }, 3);
    await wait(80);
    expect(await t.total()).toBe(3);
    expect((await t.moves()).map((m) => [m.seat, m.move.saw])).toEqual([[1, 0], [1, 1], [1, 2]]);
    expect(calls).not.toContain("bot");
  });
});
