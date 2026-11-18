// Rooms: turn-based games (or anything with private per-person state) over @zubra/sync.
//
// The server is the only writer. A page never writes a document; it sends a move to
// `POST <mount>/<id>/act`, the room's `act` decides it, and the server writes every seat's view.
// `authorize` lets a player read only their own seat's view, so a hand stays in one browser.
//
// Collections:
//   rooms/<id>          public: seats (names, bots), whether it started, a summary,
//                       and the deadline that's running, if any                      (everyone reads)
//   views/<id>/<seat>   one seat's view of the game                                  (that seat only)
//   views/<id>/watch    what someone watching may see: nobody's hand                 (everyone, if watching is allowed)
//   games/<id>          options, seed, when it was dealt, and seat holders           (server only)
//   moves/<id>          every move and its time, one field per move, for replays     (server only)
//   chat/<id>           the table's chat, one field per message                       (everyone)
import { createSyncServer, memoryLog, type Log } from "@zubra/sync/server";

export interface RoomDefinition<State, Move, View, Options, Summary = unknown> {
  /** Seats at the table: a number, or worked out from the room's options (a game for 2 to 6, say). */
  seats: number | ((options: Options) => number);
  /** A new game, from the options a room was created with and a seed. */
  setup(options: Options, seed: number): State;
  /**
   * Apply a move by a seat. Throw a RefusedMove (or any Error) to refuse it; the message goes back to the player.
   * `time` is when the server decided the move and how long the table had waited for it. A game with
   * clocks (a bank per seat that runs down) keeps them in its state from this, and nothing else: the
   * move log keeps each move's time, so a replay hands `act` the same numbers. Never read the clock yourself.
   */
  act(state: State, seat: number, move: Move, time: MoveTime): State;
  /** What one seat may see. */
  view(state: State, seat: number): View;
  /**
   * What someone watching the table may see, from the state and every seat's view (in seat order).
   * Without it a table can't be watched. `sharedView` builds one from the views: what every seat
   * can see already.
   */
  watch?(state: State, views: View[]): unknown;
  /** What everyone may see (lobby, scoreboards, a blog embed). */
  summary?(state: State): Summary;
  /** What everyone may see before the game starts, from the room's options: its game and rules, say. */
  info?(options: Options): unknown;
  /**
   * A table's settings (how well and how fast its bots play, say), from a page: checked, with defaults
   * for anything missing. Without it a room has no settings. They're public, and anyone seated can change
   * them mid-game.
   */
  settings?(given: unknown): unknown;
  /** A bot's move for a seat, or null when it isn't that seat's move. `name` is the bot's name in that seat. */
  bot?(state: State, seat: number, name: string, settings?: any): Move | null;
  /**
   * `bot`, for a game whose computer players can take a while: the same move, worked out somewhere
   * that doesn't hold up every other table (a worker thread, say). When a room has it, its bots are
   * asked here and `bot` is left to whoever else wants a move at once (a deadline's timeout move).
   *
   * Return null, at once, when it isn't that seat's move; otherwise the move, or a promise of it.
   * The room starts the think as the bot's pause begins and plays the move when both are done, so a
   * think shorter than the pause costs the table no time at all. A promised move is only ever played
   * on the state it was asked for: if the game has moved on by the time it arrives (someone else
   * moved, a deadline fired) it is dropped and the seat is asked again, and if the bot was stopped
   * meanwhile (the settings changed, the seat changed hands, the game ended, the table closed) it is
   * dropped and that's that. `thinking.signal` aborts when the room no longer wants the answer.
   * A promise that resolves null, or rejects, leaves the seat waiting: resolve a move.
   */
  think?(state: State, seat: number, name: string, settings: any, thinking: Thinking): Move | null | Promise<Move | null>;
  /** Whether the game is over. Finished rooms are dropped from memory (the log keeps them). */
  finished?(state: State): boolean;
  /** How long (ms) a bot takes over its move, so bots feel like people. Default 700. */
  botDelay?(state: State, seat: number, name: string, settings?: any): number;
  /**
   * What happens if nobody moves: by when, and the move the server then makes for which seat (a turn
   * timer playing for someone who walked away, a flag falling on a chess clock, a claim window closing).
   * Null when the game waits for ever. Asked again after every move, so it describes this state only.
   * It must not read the clock: `after` counts from the last move, and a state that needs real times
   * gets them from `act`'s `time`.
   */
  deadline?(state: State, table: TableInfo): Deadline<Move> | null;
}

/** What a think is told besides the position (see RoomDefinition.think). */
export interface Thinking {
  /** Aborts when the room has stopped waiting for this answer: there's no need to finish working it out. */
  signal: AbortSignal;
  /** The room's id, for sharing thinking time fairly between tables. */
  table: string;
}

/** When a move was decided. */
export interface MoveTime {
  /** Server time (ms). Never earlier than the move before it. */
  at: number;
  /** Ms since the move before it (or since the deal, for the first move). */
  elapsed: number;
}

/** What a deadline may depend on besides the state: the table's settings, and who sits where. */
export interface TableInfo {
  /** The table's settings (see RoomDefinition.settings), or null. */
  settings: any;
  seats: Seat[];
}

export interface Deadline<Move> {
  /**
   * When time runs out, one of two ways. `after`: this many ms after the last move (or the deal); "30
   * seconds a turn" is `after: 30_000`, and a chess clock is `after: bank[turn]` with `act` taking each
   * move's `elapsed` off the mover's bank. `at`: a server time, for a state that keeps times itself
   * (it learned them from `act`'s `time`).
   */
  after?: number;
  at?: number;
  /** The seat the clock is on: the timeout move is made as this seat, and pages count down on it. */
  seat: number;
  /**
   * Ms the server waits past that time before it makes the move (none unless given). For a clock
   * short enough that the trip to the page and back matters: pages still count down to the time
   * itself, and a move sent as it reaches zero has this long to arrive.
   */
  grace?: number;
  /**
   * The move to make when time runs out, worked out only then (it may be a bot's whole think). Null
   * for nothing to do. It goes through `act` and into the move log like any other move.
   */
  move(): Move | null;
}

/** The deadline as pages see it: whose clock, and when it runs out (server time, ms). Never the move. */
export interface DeadlineDoc {
  at: number;
  seat: number;
}

/** What happened in a room, for an app that wants to react (bots chatting, say). */
export interface MoveEvent<State, Move, Summary> {
  id: string;
  before: State;
  after: State;
  seat: number;
  move: Move;
  room: RoomDoc<Summary>;
  /** The server made this move because the seat's time ran out (see RoomDefinition.deadline). */
  timeout?: boolean;
  /** The server's admin made this move for the seat, at a paused table (see `moveFor`). */
  admin?: boolean;
}

export class RefusedMove extends Error {
  override name = "RefusedMove";
}

export interface Seat {
  name: string | null;
  bot: boolean;
}

export interface RoomDoc<Summary = unknown> {
  seats: Seat[];
  /** The room's public info from its options (see RoomDefinition.info), or null. */
  info: unknown;
  /** The table's settings (see RoomDefinition.settings), or null. */
  settings?: unknown;
  started: boolean;
  /** Seats set by the server (a tournament match, say): nobody may sit, swap or change bots. */
  locked?: boolean;
  /** A name for the table, set by the server, for pages to show. */
  label?: string;
  /** Set by an app that lists the table somewhere public (a lobby), so its page can say so. */
  open?: boolean;
  /** The seat of whoever runs a listed table (they can remove players), set by the app. */
  host?: number | null;
  /** Seats that may not chat, set by the app. */
  muted?: number[];
  /**
   * A table to watch: every seat is a computer player and anyone may read every seat's view. Only
   * the server makes one (see `exhibit`).
   */
  watchable?: boolean;
  /** What the cards look like at this table, for everyone at it and watching: the app's to define (see `setDeck`). */
  deck?: unknown;
  /** Why the server's admin closed this table. A closed table takes no more seats, moves or chat. */
  closed?: string;
  /**
   * Set while the server's admin has paused the game (see `pause`): when (server time, ms) and why.
   * Nobody can move, no bot plays and no clock runs until it is resumed; chat carries on.
   */
  paused?: { at: number; reason: string };
  summary: Summary | null;
  /** The clock that's running, if the game has one (see RoomDefinition.deadline). */
  deadline?: DeadlineDoc | null;
  /**
   * When the last move was decided (server time, ms), in a room with deadlines: where a clock the
   * game keeps in its own state (a chess clock's two banks) has been running from.
   */
  moved?: number;
  version: number;
}

export interface ChatMessage {
  /** The seat that said it. */
  seat: number;
  name: string;
  text: string;
  /** Server time (ms). */
  at: number;
  bot: boolean;
  /** A moderator took the words away; `text` says so instead. */
  removed?: boolean;
  /** The server's own notice to the table (see `announce`), not a seat's words: `seat` is -1. */
  notice?: boolean;
}

/** What a removed chat message says instead. */
export const REMOVED_TEXT = "(removed by a moderator)";

/** How long a message may be, and how often one player may send. */
export const CHAT_LIMIT = 280;
const CHAT_GAP_MS = 400;

export interface ViewDoc<View = unknown> {
  view: View;
  version: number;
}

interface GameDoc<Options> {
  options: Options;
  settings?: unknown;
  seed: number | null;
  /** When the game was dealt (server time, ms): where the first move's clock starts. */
  startedAt?: number;
  /** Total time the game has spent paused, not counting a pause that is going on (ms). */
  pausedMs?: number;
  /** When the pause that is going on began (server time, ms), or null. */
  pausedAt?: number | null;
  holders: (string | null)[];
}

interface Armed {
  /** When time runs out, in game time (the clock less the time spent paused). Pages are told it in server time. */
  at: number;
  /** When the server makes the move: `at`, plus the deadline's own grace. Game time too. */
  fire: number;
  seat: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** A bot's move in the making: the pause that makes it feel like a person, and the think behind it. */
interface Turn<State, Move> {
  seat: number;
  name: string;
  settings: unknown;
  /** The state the answer is for. An answer is only ever played on this very state. */
  state: State;
  /** The move, or a promise of it from `think`. */
  answer: Move | Promise<Move | null>;
  /** Tells `think` the answer isn't wanted any more. */
  stop: AbortController;
}

interface Live<State> {
  state: State | null;
  moves: number;
  version: number;
  /** The bot that's about to move: pausing, thinking or both. One at a time. */
  bot: Turn<State, any> | null;
  /** That bot's pause, while it runs. */
  timer: ReturnType<typeof setTimeout> | null;
  /** When the last move was decided (or the game dealt): where `elapsed` and `after` count from. Game time. */
  last: number;
  /** The settings and seats a deadline may read, kept here so a timer never has to wait for them. */
  table: TableInfo;
  /** The deadline that's armed. Separate from the bot's timer: both can be waiting at once. */
  deadline: Armed | null;
  /** Time spent paused so far, not counting a pause going on (ms). Game time is the server's clock less this. */
  paused: number;
  /** When the pause that's going on began, or null. While it is set nothing moves and no clock runs. */
  pausedAt: number | null;
}

/** setTimeout can't wait longer than this (about 24.8 days): a longer deadline wakes and waits again. */
const LONGEST_TIMEOUT = 2 ** 31 - 1;

export interface RoomsOptions {
  /** Where the rooms endpoints live. Default `/rooms`. */
  mount?: string;
  /** Where the sync log is served. Default `/_zb/sync`. */
  syncMount?: string;
  /** The sync log. Default: in memory, keeping each field's latest value. */
  log?: Log;
  /** A fixed time (ms) every bot waits before moving, overriding the room's own botDelay. For tests. */
  botDelay?: number;
  /**
   * The least warning (ms) a seat gets when a deadline arrives out of nowhere: a room coming back after
   * a restart with its time already up, or a setting that puts the clock on someone mid-turn. Default 5000.
   */
  deadlineGrace?: number;
  /** Whether people who aren't at a table may read its watch view. Default: they may. */
  spectators?(): boolean | Promise<boolean>;
  /** Whether a page may open a room with these options: a reason to refuse, or null. Server code's own `create` isn't asked. */
  allow?(options: unknown): string | null | Promise<string | null>;
  /** After every move is published. */
  onMove?(event: MoveEvent<any, any, any>): void;
  /** After the seats change before a game starts: someone sat, stood up, or a bot was added or removed. */
  onSeats?(event: { id: string; room: RoomDoc<any> }): void;
  /** After a game starts. */
  onStart?(event: { id: string; state: any; room: RoomDoc<any> }): void;
  /**
   * Before a person's message is added to the chat: return the text to post (changed, perhaps), or
   * `{ error }` to turn it away with a reason.
   */
  beforeSay?(event: { id: string; seat: number; text: string; room: RoomDoc<any> }): string | { error: string } | Promise<string | { error: string }>;
  /** After a person (not a bot) says something. */
  onSay?(event: { id: string; message: ChatMessage; room: RoomDoc<any> }): void;
  /** Seeds for new games. Default: random. */
  seed?: () => number;
  /** Room ids. Default: 6 random letters and digits. */
  id?: () => string;
}

const COOKIE = "rooms_player";
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const randomId = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ALPHABET[b % ALPHABET.length]).join("");

/** A new player id: the secret a browser's cookie holds. */
export const newPlayerId = () => randomId(24);

/** Whether the browser reached us over HTTPS: directly, or through a proxy that says so (Railway). */
export function overHttps(request?: Request): boolean {
  if (!request) return false;
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The Set-Cookie value that makes a browser this player, for a year. Over HTTPS it's also Secure, so
 * the browser never sends it over plain http; plain-http development (localhost) still works.
 */
export const playerCookie = (player: string, request?: Request) => `${COOKIE}=${player}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${overHttps(request) ? "; Secure" : ""}`;

export function playerOf(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-z0-9]+)`));
  return match?.[1] ?? null;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function createRooms<State, Move, View, Options, Summary = unknown>(
  def: RoomDefinition<State, Move, View, Options, Summary>,
  options: RoomsOptions = {},
) {
  const mount = (options.mount ?? "/rooms").replace(/\/$/, "");
  const fixedDelay = options.botDelay;
  const grace = options.deadlineGrace ?? 5000;
  const seatsFor = (o: Options) => (typeof def.seats === "function" ? def.seats(o) : def.seats);
  /** Run an app's hook without letting it break the room. */
  const safely = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      console.error("rooms: a hook threw", e);
    }
  };
  const newSeed = options.seed ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]!);
  const newId = options.id ?? (() => randomId(6));
  const live = new Map<string, Live<State>>();

  const sync = createSyncServer({
    mount: options.syncMount ?? "/_zb/sync",
    log: options.log ?? memoryLog({ keep: "latest" }),
    authorize: async ({ request, collection, key, kind }) => {
      if (kind === "change") return false; // the server is the only writer
      if (collection === "rooms") return true; // reading, and presence (who's at the table)
      if (collection === "chat" && kind === "read") return true;
      if (collection === "views" && kind === "read") {
        // The watch view holds only what every seat can already see.
        if (key.endsWith("/watch")) return (await options.spectators?.()) ?? true;
        const [id, seat] = splitViewKey(key);
        // A table of computer players has no hands to keep secret.
        if ((await room(id))?.watchable) return true;
        const player = playerOf(request);
        return player !== null && (await game(id))?.holders[seat] === player;
      }
      return false; // games and moves are the server's alone
    },
  });
  const docs = sync.documents();

  const splitViewKey = (key: string): [string, number] => {
    const at = key.lastIndexOf("/");
    return [key.slice(0, at), Number(key.slice(at + 1))];
  };
  const game = async (id: string) => (await docs).get("games", id) as GameDoc<Options> | undefined;
  const room = async (id: string) => (await docs).get("rooms", id) as RoomDoc<Summary> | undefined;

  /** The live state of a room, replaying its move log after a restart. */
  async function stateOf(id: string): Promise<Live<State>> {
    const entry = live.get(id);
    if (entry) return entry;
    // Two requests for a room that isn't in memory share one restore: a second copy of the room
    // would mean a second deadline, and a timeout applied twice.
    let pending = restoring.get(id);
    if (!pending) {
      pending = restore(id).finally(() => restoring.delete(id));
      restoring.set(id, pending);
    }
    return pending;
  }
  const restoring = new Map<string, Promise<Live<State>>>();

  async function restore(id: string): Promise<Live<State>> {
    const r = await room(id);
    const g = await game(id);
    const entry: Live<State> = { state: null, moves: 0, version: r?.version ?? 0, bot: null, timer: null, last: Date.now(), table: tableOf(r, g), deadline: null, paused: g?.pausedMs ?? 0, pausedAt: g?.pausedAt ?? null };
    if (g?.seed != null) {
      // A game dealt before moves had times starts its clock now, for good: writing it down means
      // every later replay counts from the same moment.
      const startedAt = g.startedAt ?? Date.now();
      if (g.startedAt == null) void sync.write("games", id, { startedAt });
      let state = def.setup(g.options, g.seed);
      const log = (await docs).get("moves", id) ?? {};
      const count = Object.keys(log).filter((k) => /^\d+$/.test(k)).length;
      // Each move gets the time it was first decided at, so a game with clocks replays to the same
      // state. A move from before times were kept took no time at all.
      let last = startedAt;
      for (let n = 0; n < count; n++) {
        const { seat, move, at } = log[String(n)] as { seat: number; move: Move; at?: number };
        const when = Math.max(at ?? last, last);
        state = def.act(state, seat, move, { at: when, elapsed: when - last });
        last = when;
      }
      entry.state = state;
      entry.moves = count;
      entry.last = last;
    }
    live.set(id, entry);
    // The clock kept running while the server was away: the deadline is where it was, measured from
    // the last move's own time. If that has already passed, the seat gets a moment's grace first.
    arm(id, entry, true);
    const now = deadlineDoc(entry);
    if (now?.at !== r?.deadline?.at || now?.seat !== r?.deadline?.seat) void sync.write("rooms", id, { deadline: now });
    return entry;
  }

  const tableOf = (r: RoomDoc<Summary> | undefined, g: GameDoc<Options> | undefined): TableInfo => ({
    // A room from before it had settings plays with the defaults.
    settings: g?.settings ?? def.settings?.(undefined) ?? null,
    seats: r?.seats ?? [],
  });
  /** The game's own clock: the server's, less the time the game has spent paused. It stands still during a pause. */
  const gameNow = (entry: Live<State>) => (entry.pausedAt ?? Date.now()) - entry.paused;
  /** The deadline as pages see it, in server time. */
  const deadlineDoc = (entry: Live<State>): DeadlineDoc | null => (entry.deadline ? { at: entry.deadline.at + entry.paused, seat: entry.deadline.seat } : null);

  function disarm(entry: Live<State>) {
    if (entry.deadline?.timer) clearTimeout(entry.deadline.timer);
    entry.deadline = null;
  }

  /**
   * Ask the game for its deadline in this state and set the one timer that keeps it. `sudden` is for a
   * deadline nobody at the table saw coming (a restart, a changed setting): it's never closer than the
   * grace period, unless the one it replaces already was. Returns whether there is one now.
   */
  function arm(id: string, entry: Live<State>, sudden = false): boolean {
    const before = entry.deadline ? entry.deadline.at + entry.paused : null;
    disarm(entry);
    // A paused game has no clock: it is armed again, with the time it had left, when it is resumed.
    if (entry.pausedAt !== null) return false;
    if (!def.deadline || entry.state === null || def.finished?.(entry.state)) return false;
    let due: Deadline<Move> | null = null;
    try {
      due = def.deadline(entry.state, entry.table);
    } catch (e) {
      console.error(`rooms: the deadline of ${id} threw`, e);
    }
    const asked = due ? (due.at ?? (due.after === undefined ? NaN : entry.last + due.after)) : NaN;
    if (!due || !Number.isFinite(asked)) return false;
    // The game asks in game time; the grace and the timers are the server's.
    let wall = Math.round(asked) + entry.paused;
    // The grace never puts off a deadline that was already armed, or asking twice would be a way to stall.
    if (sudden) wall = Math.max(wall, Math.min(Date.now() + grace, before ?? Infinity));
    const at = wall - entry.paused;
    const armed: Armed = { at, fire: at + Math.max(0, due.grace ?? 0), seat: due.seat, timer: null };
    const wait = () => {
      armed.timer = setTimeout(() => {
        armed.timer = null;
        if (entry.deadline !== armed) return; // a move got in first
        if (Date.now() < armed.fire + entry.paused) return wait(); // longer than one timer can sleep, or the timer woke early
        timeUp(id, entry, armed);
      }, Math.min(Math.max(armed.fire + entry.paused - Date.now(), 0), LONGEST_TIMEOUT));
    };
    entry.deadline = armed;
    wait();
    return true;
  }

  /**
   * Time ran out: make the game's timeout move, exactly as if the seat had sent it. Everything up to
   * recording the move happens with no await, and a move that got in first has already put this
   * deadline away (see apply), so a move and a timeout can never both land on the same state.
   */
  function timeUp(id: string, entry: Live<State>, armed: Armed) {
    entry.deadline = null;
    if (entry.pausedAt !== null) return; // paused: no clock runs
    let applied: { before: State; move: Move } | null = null;
    try {
      const due = entry.state === null ? null : def.deadline!(entry.state, entry.table);
      const move = due && due.seat === armed.seat ? due.move() : null;
      if (move !== null) applied = { before: apply(id, entry, armed.seat, move), move };
    } catch (e) {
      console.error(`rooms: the timeout move in ${id} for seat ${armed.seat} was refused`, e);
    }
    // Nothing to do for that seat: the game waits, and pages stop counting down.
    if (!applied) return void sync.write("rooms", id, { deadline: null });
    void settle(id, entry, applied.before, armed.seat, applied.move, true);
  }

  /** After any move: tell everyone, then let the bots and the clock carry on (or put the game away). */
  async function settle(id: string, entry: Live<State>, before: State, seat: number, move: Move, timeout = false, admin = false) {
    const after = entry.state as State;
    await publish(id, entry);
    void moved(id, before, after, seat, move, timeout, admin);
    if (!forgetIfFinished(id, entry)) void driveBots(id);
  }

  /** Messages per room, counted once from the log and then kept here. */
  const chatCount = new Map<string, number>();
  const lastSaid = new Map<string, number>();

  /** Add a message to a room's chat, as a seat. Bots speak through this too. */
  async function say(id: string, seat: number, text: string): Promise<ChatMessage | string> {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, CHAT_LIMIT);
    if (!clean) return "Say something first.";
    const r = await room(id);
    const who = r?.seats[seat];
    if (!r || !who) return "No such seat.";
    return append(id, { seat, name: who.name ?? `Seat ${seat + 1}`, text: clean, at: Date.now(), bot: who.bot });
  }

  /** Put a message in a room's chat, numbering it after the ones already there. */
  async function append(id: string, message: ChatMessage): Promise<ChatMessage> {
    if (!chatCount.has(id)) {
      const existing = (await docs).get("chat", id) ?? {};
      chatCount.set(id, Object.keys(existing).filter((k) => /^m\d+$/.test(k)).length);
    }
    const n = chatCount.get(id)!;
    chatCount.set(id, n + 1);
    await sync.write("chat", id, { [`m${String(n).padStart(6, "0")}`]: message });
    return message;
  }

  /**
   * A notice from the server to everyone at a table, in the chat ("The host paused the game"). It is not a
   * seat's message: `seat` is -1, `notice` is true and `name` is `from`. Resolves to the message, or a problem.
   */
  async function announce(id: string, text: string, from = "The host"): Promise<ChatMessage | string> {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, CHAT_LIMIT);
    if (!clean) return "Say something first.";
    if (!(await room(id))) return "No such table.";
    return append(id, { seat: -1, name: from.replace(/\s+/g, " ").trim().slice(0, 40) || "The host", text: clean, at: Date.now(), bot: false, notice: true });
  }

  /** Open a new room with these options. Resolves to its id. */
  async function create(roomOptions: Options, given?: unknown): Promise<string> {
    const id = newId();
    const n = seatsFor(roomOptions);
    const settings = def.settings ? def.settings(given) : null;
    await sync.write("games", id, { options: roomOptions, settings, seed: null, holders: Array(n).fill(null) });
    await sync.write("rooms", id, { seats: Array.from({ length: n }, () => ({ name: null, bot: false })), info: def.info?.(roomOptions) ?? null, settings, started: false, summary: null, version: 0 });
    return id;
  }

  /**
   * Seat a player (by their player id) or a bot, from server code, before the game starts. An app
   * that sets up a table itself (a challenge, say) uses these instead of the HTTP endpoints.
   */
  async function seatPlayer(id: string, seat: number, player: string, name: string): Promise<void> {
    const g = await game(id);
    const r = await room(id);
    if (!g || !r || r.started) throw new Error("That table isn't open.");
    const holders = g.holders.map((h) => (h === player ? null : h));
    holders[seat] = player;
    const seats = r.seats.map((s, i) => (holders[i] === null && !s.bot ? { name: null, bot: false } : s));
    seats[seat] = { name: name.trim().slice(0, 20) || "Player", bot: false };
    await sync.write("games", id, { holders });
    await sync.write("rooms", id, { seats });
    await seatsChanged(id);
  }
  async function seatBot(id: string, seat: number, name: string): Promise<void> {
    const r = await room(id);
    if (!r || r.started) throw new Error("That table isn't open.");
    const seats = [...r.seats];
    seats[seat] = { name, bot: true };
    await sync.write("rooms", id, { seats });
    await seatsChanged(id);
  }
  /** Free a person's seat before the game starts (they left, say). Resolves to whether anyone was there. */
  async function unseat(id: string, seat: number): Promise<boolean> {
    const g = await game(id);
    const r = await room(id);
    if (!g || !r || r.started || !g.holders[seat]) return false;
    const holders = [...g.holders];
    holders[seat] = null;
    const seats = [...r.seats];
    seats[seat] = { name: null, bot: false };
    await sync.write("games", id, { holders });
    await sync.write("rooms", id, { seats });
    await seatsChanged(id);
    return true;
  }
  /**
   * Take a person's seat away and sit a bot there, at any point. In a game that's been dealt, the bot
   * plays on from where they were. Resolves to whether anyone was there.
   */
  async function replaceWithBot(id: string, seat: number, name: string): Promise<boolean> {
    const g = await game(id);
    const r = await room(id);
    if (!g || !r || !g.holders[seat]) return false;
    const holders = [...g.holders];
    holders[seat] = null;
    const seats = [...r.seats];
    seats[seat] = { name, bot: true };
    await sync.write("games", id, { holders });
    await sync.write("rooms", id, { seats });
    if (!r.started) return await seatsChanged(id), true;
    if (r.closed) return true; // nothing plays on at a closed table
    const entry = await stateOf(id);
    entry.table = { ...entry.table, seats };
    stopBot(entry);
    // A clock that was running on the person isn't the bot's: work it out again.
    if (def.deadline && entry.state !== null) {
      const before = deadlineDoc(entry);
      arm(id, entry, true);
      const now = deadlineDoc(entry);
      if (before?.at !== now?.at || before?.seat !== now?.seat) void sync.write("rooms", id, { deadline: now });
    }
    void driveBots(id);
    return true;
  }
  /** Tell the app the seats changed. */
  async function seatsChanged(id: string) {
    if (!options.onSeats) return;
    const r = await room(id);
    if (r) safely(() => options.onSeats!({ id, room: r }));
  }
  /** Deal: from a seated player's request, or from server code. Resolves to a problem, or null. */
  async function start(id: string): Promise<string | null> {
    const g = await game(id);
    const r = await room(id);
    if (!g || !r) return "No such table.";
    if (r.started) return null;
    if (r.seats.some((s, i) => !s.bot && !g.holders[i])) return "Every seat needs a player or a bot.";
    const seed = newSeed();
    const entry = await stateOf(id);
    if (entry.state !== null) return null; // two people pressed Deal at once
    const startedAt = Date.now();
    entry.paused = 0;
    entry.pausedAt = null;
    entry.state = def.setup(g.options, seed);
    entry.moves = 0;
    entry.last = startedAt;
    entry.table = tableOf(r, g);
    await sync.write("games", id, { seed, startedAt });
    await publish(id, entry);
    if (options.onStart) {
      const started = await room(id);
      if (started) safely(() => options.onStart!({ id, state: entry.state, room: started }));
    }
    void driveBots(id);
    return null;
  }
  /** Set the seats for good (after seating everyone from server code), and name the table. */
  async function lock(id: string, label?: string): Promise<void> {
    await sync.write("rooms", id, { locked: true, ...(label ? { label: label.slice(0, 60) } : {}) });
  }

  /**
   * Make a table one to watch: its seats are set (all computer players, seated from server code)
   * and anyone may read every seat's view. Refuses a table with a person at it.
   */
  async function exhibit(id: string, label?: string): Promise<void> {
    const g = await game(id);
    const r = await room(id);
    if (!g || !r || g.holders.some(Boolean) || r.seats.some((s) => !s.bot)) throw new Error("Only a table of computer players can be watched this way.");
    await sync.write("rooms", id, { locked: true, watchable: true, ...(label ? { label: label.slice(0, 60) } : {}) });
  }

  /**
   * Close a table for good (moderation): bots stop, and every later seat, move or message is
   * refused with `reason`. Pages see `closed` on the room. Resolves false when there's no such table.
   */
  async function closeTable(id: string, reason: string): Promise<boolean> {
    if (!(await room(id))) return false;
    await sync.write("rooms", id, { closed: reason.replace(/\s+/g, " ").trim().slice(0, 200) || "This table was closed." });
    const entry = live.get(id);
    if (entry) stopBot(entry);
    live.delete(id);
    return true;
  }

  /**
   * Pause a game that's being played (moderation): nobody can move, no bot plays and no clock runs, until
   * `resume`. Chat carries on, and pages see `paused` on the room. The game's own clock stands still, so
   * a turn timer or a chess clock has the time left that it had, and `act` sees no time pass. Resolves to
   * a problem, or null (also when it is paused already).
   */
  async function pause(id: string, reason = ""): Promise<string | null> {
    const g = await game(id);
    const r = await room(id);
    if (!g || !r) return "No such table.";
    if (r.closed) return "That table is closed.";
    if (!r.started) return "The game hasn't started.";
    const entry = await stateOf(id);
    if (entry.state === null || def.finished?.(entry.state)) return "The game is over.";
    if (entry.pausedAt !== null) return null;
    // From here to the write there is no await that matters: a move that arrives now finds the table paused.
    const at = Date.now();
    entry.pausedAt = at;
    stopBot(entry);
    disarm(entry);
    const why = reason.replace(/\s+/g, " ").trim().slice(0, 200);
    await sync.write("games", id, { pausedAt: at });
    await sync.write("rooms", id, { paused: { at, reason: why }, deadline: null });
    return null;
  }

  /** Let a paused game go on. Its clocks have the time they had left; the bots play again. Resolves to a problem, or null. */
  async function resume(id: string): Promise<string | null> {
    const g = await game(id);
    const r = await room(id);
    if (!g || !r) return "No such table.";
    if (!r.paused && g.pausedAt == null) return "That table isn't paused.";
    const entry = await stateOf(id);
    if (entry.pausedAt === null) return "That table isn't paused.";
    entry.paused += Math.max(0, Date.now() - entry.pausedAt);
    entry.pausedAt = null;
    // One write for the game: the time paused and the end of the pause go down together.
    await sync.write("games", id, { pausedMs: entry.paused, pausedAt: null });
    arm(id, entry);
    await sync.write("rooms", id, { paused: null, deadline: deadlineDoc(entry), ...(def.deadline ? { moved: entry.last + entry.paused } : {}) });
    void driveBots(id);
    return null;
  }

  /**
   * Make a move for a seat at a paused table (moderation): as if the seat had sent it, through `act`,
   * into the move log (so a restart replays it), and `onMove` is told it was the admin's. The table has
   * to be paused first, so no bot or clock can move at the same time. Resolves to a problem, or null.
   */
  async function moveFor(id: string, seat: number, move: Move): Promise<string | null> {
    const g = await game(id);
    const r = await room(id);
    if (!g || !r) return "No such table.";
    if (r.closed) return "That table is closed.";
    if (!Number.isInteger(seat) || seat < 0 || seat >= r.seats.length) return "No such seat.";
    const entry = await stateOf(id);
    if (entry.state === null) return "The game hasn't started.";
    if (entry.pausedAt === null) return "Pause the table first.";
    let before: State;
    try {
      before = apply(id, entry, seat, move, true);
    } catch (e) {
      return e instanceof Error ? e.message : "That move isn't allowed.";
    }
    const over = def.finished?.(entry.state as State) === true;
    const heldSince = entry.pausedAt;
    await settle(id, entry, before, seat, move, false, true);
    // A game that ended on that move isn't paused any more: there is nothing left to hold.
    if (over) {
      await sync.write("games", id, { pausedMs: entry.paused + Math.max(0, Date.now() - heldSince), pausedAt: null });
      await sync.write("rooms", id, { paused: null });
    }
    return null;
  }

  /**
   * `moveFor`, with the move the game's own computer player would make for the seat (`bot`, or `think` if
   * that is what the game has). For a player who has gone, in any game that has bots, with no move to
   * write by hand. Resolves to a problem, or null; the problem is "That seat has no move to make." when the
   * bot has none, and "This game has no computer players." when it has no bot.
   */
  async function botMoveFor(id: string, seat: number): Promise<string | null> {
    if (!def.bot && !def.think) return "This game has no computer players.";
    const g = await game(id);
    const r = await room(id);
    if (!g || !r) return "No such table.";
    if (r.closed) return "That table is closed.";
    if (!Number.isInteger(seat) || seat < 0 || seat >= r.seats.length) return "No such seat.";
    const entry = await stateOf(id);
    if (entry.state === null) return "The game hasn't started.";
    if (entry.pausedAt === null) return "Pause the table first.";
    const stop = new AbortController();
    const state = entry.state;
    let move: Move | null;
    try {
      move = await ask(id, state, seat, r.seats[seat]?.name ?? "", g.settings ?? def.settings?.(undefined), stop);
    } catch (e) {
      console.error(`rooms: the bot in ${id} seat ${seat} couldn't think`, e);
      return "The computer player couldn't find a move.";
    }
    if (move === null) return "That seat has no move to make.";
    if (entry.state !== state) return "The game moved on. Try again.";
    return moveFor(id, seat, move);
  }

  /**
   * Take a person out of a seat (moderation). Before the game starts the seat is simply free again;
   * once it has, a bot called `bot` plays the seat on, so the others can finish. Resolves to a
   * problem, or null.
   */
  async function removePlayer(id: string, seat: number, bot = "Bot"): Promise<string | null> {
    const g = await game(id);
    const r = await room(id);
    if (!g || !r) return "No such table.";
    if (!Number.isInteger(seat) || seat < 0 || seat >= r.seats.length || !g.holders[seat]) return "Nobody's sitting there.";
    const gone = r.started ? await replaceWithBot(id, seat, bot.trim().slice(0, 20) || "Bot") : await unseat(id, seat);
    return gone ? null : "Nobody's sitting there.";
  }

  /** Take the words out of a chat message (moderation). `key` is the message's field in `chat/<id>`. */
  async function redact(id: string, key: string): Promise<boolean> {
    const message = ((await docs).get("chat", id) ?? {})[key] as ChatMessage | undefined;
    if (!/^m\d+$/.test(key) || !message) return false;
    await sync.write("chat", id, { [key]: { ...message, text: REMOVED_TEXT, removed: true } });
    return true;
  }

  /** Who holds each seat (player ids), for server code. Never send these to a page. */
  async function holders(id: string): Promise<(string | null)[]> {
    return (await game(id))?.holders ?? [];
  }

  /** A finished game no longer needs its state in memory: a later request replays it from the log. */
  function forgetIfFinished(id: string, entry: Live<State>): boolean {
    if (entry.state === null || !def.finished?.(entry.state)) return false;
    stopBot(entry);
    disarm(entry);
    live.delete(id);
    return true;
  }

  /** Write every seat's view and the public room doc. */
  async function publish(id: string, entry: Live<State>) {
    entry.version += 1;
    // The state changed, so its deadline did: arm it before anything is awaited, and publish it with the rest.
    arm(id, entry);
    const deadline = deadlineDoc(entry);
    const writes: Promise<unknown>[] = [];
    if (entry.state !== null) {
      const n = (await game(id))?.holders.length ?? 0;
      const views = Array.from({ length: n }, (_, seat) => def.view(entry.state as State, seat));
      for (const [seat, view] of views.entries()) writes.push(sync.write("views", `${id}/${seat}`, { view, version: entry.version }));
      if (def.watch) writes.push(sync.write("views", `${id}/watch`, { view: def.watch(entry.state, views), version: entry.version }));
    }
    writes.push(
      sync.write("rooms", id, {
        started: entry.state !== null,
        summary: entry.state !== null && def.summary ? def.summary(entry.state) : null,
        ...(def.deadline ? { deadline, moved: entry.last + entry.paused } : {}),
        version: entry.version,
      }),
    );
    await Promise.all(writes);
  }

  /** Apply a move. No await between deciding and recording it, so two moves can't interleave. */
  function apply(id: string, entry: Live<State>, seat: number, move: Move, admin = false): State {
    if (entry.pausedAt !== null && !admin) throw new RefusedMove("The table is paused.");
    const before = entry.state as State;
    const at = Math.max(gameNow(entry), entry.last); // a clock set back never makes a move take less than no time
    const next = def.act(before, seat, move, { at, elapsed: at - entry.last }); // throws to refuse
    entry.state = next;
    entry.last = at;
    // The deadline was for the state before this move: put it away now, so it can't fire on this one.
    disarm(entry);
    const n = entry.moves++;
    void sync.write("moves", id, { [String(n)]: { seat, move, at } });
    return before;
  }

  async function moved(id: string, before: State, after: State, seat: number, move: Move, timeout = false, admin = false) {
    if (!options.onMove) return;
    const r = await room(id);
    if (r) safely(() => options.onMove!({ id, before, after, seat, move, room: r, ...(timeout ? { timeout } : {}), ...(admin ? { admin } : {}) }));
  }

  /** Stop the bot that's about to move, whatever it was doing: its pause ends and its answer, if one is still coming, is dropped. */
  function stopBot(entry: Live<State>) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.bot?.stop.abort();
    entry.bot = null;
  }

  /** Ask for a bot's move: from `think` when the room has one (it may answer later), else from `bot`. */
  const ask = (id: string, state: State, seat: number, name: string, settings: unknown, stop: AbortController): Move | null | Promise<Move | null> =>
    def.think ? def.think(state, seat, name, settings, { signal: stop.signal, table: id }) : def.bot!(state, seat, name, settings);
  const later = (answer: unknown): answer is Promise<Move | null> => typeof (answer as { then?: unknown } | null)?.then === "function";

  /**
   * If it's a bot's move, make it after a pause. The think starts as the pause does, so a think
   * that takes a while (see RoomDefinition.think) hides inside the pause instead of adding to it.
   */
  async function driveBots(id: string) {
    const entry = await stateOf(id);
    if ((!def.bot && !def.think) || entry.state === null || entry.bot) return;
    const current = await room(id);
    if (current?.closed || current?.paused || entry.pausedAt !== null) return;
    const seats = current?.seats ?? [];
    // A room from before it had settings plays with the defaults.
    const settings = (await game(id))?.settings ?? def.settings?.(undefined);
    if (entry.bot) return; // set while this was reading
    for (let seat = 0; seat < seats.length; seat++) {
      if (!seats[seat]?.bot) continue;
      const name = seats[seat]!.name ?? "";
      const stop = new AbortController();
      const answer = ask(id, entry.state, seat, name, settings, stop);
      if (answer === null) continue;
      const delay = fixedDelay ?? def.botDelay?.(entry.state, seat, name, settings) ?? 700;
      const turn: Turn<State, Move> = { seat, name, settings, state: entry.state, answer, stop };
      // An answer that fails is reported when the pause ends; until then it mustn't count as unhandled.
      if (later(answer)) answer.catch(() => {});
      entry.bot = turn;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        void play(id, entry, turn);
      }, delay);
      return;
    }
  }

  /**
   * A bot's pause is over: play its move, on the state it was worked out for and no other. A pause
   * isn't restarted because someone else moved meanwhile (in a race, a quick person mustn't keep
   * resetting the computer's clock): the move is worked out again from the table as it is now, and
   * played as soon as it's known.
   */
  async function play(id: string, entry: Live<State>, turn: Turn<State, Move>) {
    for (;;) {
      if (entry.bot !== turn || entry.state === null) return; // stopped: nobody wants this move any more
      if (entry.state !== turn.state) {
        turn.stop.abort();
        turn.stop = new AbortController();
        turn.state = entry.state;
        try {
          const answer = ask(id, turn.state, turn.seat, turn.name, turn.settings, turn.stop);
          // Not this seat's move any more: see whose it is now.
          if (answer === null) return void ((entry.bot = null), live.get(id) === entry && driveBots(id));
          turn.answer = answer;
        } catch (e) {
          console.error(`rooms: the bot in ${id} seat ${turn.seat} couldn't think`, e);
          return void (entry.bot = null);
        }
      }
      const state = turn.state;
      let move = turn.answer as Move | null;
      if (later(turn.answer)) {
        try {
          move = await turn.answer;
        } catch (e) {
          if (entry.bot !== turn) return;
          console.error(`rooms: the bot in ${id} seat ${turn.seat} couldn't think`, e);
          return void (entry.bot = null);
        }
        if (entry.bot !== turn) return; // stopped while it was thinking: the answer is dropped
        // The game moved on while it was thinking (a person moved, a deadline's move): the answer
        // was for a table that's gone. Drop it and ask again.
        if (entry.state !== state) continue;
        if (move === null) {
          console.error(`rooms: the bot in ${id} seat ${turn.seat} had a move to make and then made none`);
          return void (entry.bot = null);
        }
      }
      entry.bot = null;
      if (entry.pausedAt !== null) return; // paused while it was thinking: nothing plays
      let before: State;
      try {
        before = apply(id, entry, turn.seat, move as Move);
      } catch (e) {
        console.error(`rooms: bot in ${id} seat ${turn.seat} made a refused move`, e);
        return;
      }
      await settle(id, entry, before, turn.seat, move as Move);
      return;
    }
  }

  async function body(request: Request): Promise<Record<string, unknown>> {
    try {
      const value = await request.json();
      return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  async function handleRooms(request: Request, path: string): Promise<Response> {
    const parts = path.split("/").filter(Boolean);
    const method = request.method;

    // POST /rooms { options, settings? } → { id }
    if (parts.length === 0 && method === "POST") {
      const { options: given, settings } = await body(request);
      const refused = await options.allow?.(given ?? {});
      if (refused) return json({ error: refused }, 403);
      return json({ id: await create((given ?? {}) as Options, settings) }, 201);
    }

    const id = parts[0]!;
    const action = parts[1] ?? "";
    const g = await game(id);
    const r = await room(id);
    if (!g || !r) return json({ error: "There's no table with that code." }, 404);
    const player = playerOf(request);
    const mySeat = player ? g.holders.indexOf(player) : -1;

    // GET /rooms/:id → the public room and which seat (if any) this browser holds
    // `now` is the server's clock, so a page can count down to a deadline by it and not its own.
    if (action === "" && method === "GET") return json({ id, ...r, seat: mySeat >= 0 ? mySeat : null, now: Date.now() });

    if (method !== "POST") return json({ error: "Not found" }, 404);
    if (r.closed) return json({ error: r.closed }, 410);
    const input = await body(request);

    if (action === "sit") {
      if (r.locked) return json({ error: "The seats at this table are already set." }, 409);
      const seat = Number(input.seat);
      const name = String(input.name ?? "").trim().slice(0, 20) || "Player";
      if (!Number.isInteger(seat) || seat < 0 || seat >= r.seats.length) return json({ error: "No such seat." }, 400);
      if (r.started && mySeat !== seat) return json({ error: "This game has started." }, 409);
      const holder = g.holders[seat];
      if ((holder && holder !== player) || r.seats[seat]?.bot) return json({ error: "Someone's already sitting there." }, 409);
      const me = player ?? newPlayerId();
      const holders = g.holders.map((h) => (h === me ? null : h));
      holders[seat] = me;
      const seats = r.seats.map((s, i) => (holders[i] === null && !s.bot ? { name: null, bot: false } : s));
      seats[seat] = { name, bot: false };
      await sync.write("games", id, { holders });
      await sync.write("rooms", id, { seats });
      const entry = live.get(id);
      if (entry) entry.table = { ...entry.table, seats };
      await seatsChanged(id);
      return json({ seat }, 200, player ? {} : { "set-cookie": playerCookie(me, request) });
    }

    if (mySeat < 0) return json({ error: "Take a seat first." }, 403);

    // POST /rooms/:id/stand → give up your seat, before the game starts
    if (action === "stand") {
      if (r.started) return json({ error: "This game has started." }, 409);
      if (r.locked) return json({ error: "The seats at this table are already set." }, 409);
      await unseat(id, mySeat);
      return json({ ok: true });
    }

    // POST /rooms/:id/settings { settings } → anyone seated changes the table's settings, mid-game too.
    // A bot already waiting to move starts over at the new pace.
    if (action === "settings") {
      if (!def.settings) return json({ error: "This table has no settings." }, 404);
      const settings = def.settings(input.settings);
      await sync.write("games", id, { settings });
      await sync.write("rooms", id, { settings });
      const entry = live.get(id);
      if (entry) stopBot(entry);
      // A deadline may depend on the settings (a turn timer): work it out again. The clock isn't
      // restarted, or changing a setting would be a way to stall.
      if (entry && def.deadline && entry.state !== null) {
        const before = deadlineDoc(entry);
        entry.table = { ...entry.table, settings };
        arm(id, entry, true);
        const now = deadlineDoc(entry);
        if (before?.at !== now?.at || before?.seat !== now?.seat) void sync.write("rooms", id, { deadline: now });
      }
      void driveBots(id);
      return json({ settings });
    }

    if (action === "bot") {
      const seat = Number(input.seat);
      const add = input.add !== false;
      if (r.started) return json({ error: "This game has started." }, 409);
      if (r.locked) return json({ error: "The seats at this table are already set." }, 409);
      if (!Number.isInteger(seat) || seat < 0 || seat >= r.seats.length || g.holders[seat]) return json({ error: "That seat isn't free." }, 409);
      const seats = [...r.seats];
      seats[seat] = add ? { name: String(input.name ?? `Bot ${seat + 1}`), bot: true } : { name: null, bot: false };
      await sync.write("rooms", id, { seats });
      await seatsChanged(id);
      return json({ ok: true });
    }

    if (action === "start") {
      const problem = await start(id);
      return problem ? json({ error: problem }, 409) : json({ ok: true });
    }

    // POST /rooms/:id/say { text }
    if (action === "say") {
      const key = `${id}/${mySeat}`;
      const now = Date.now();
      if (now - (lastSaid.get(key) ?? 0) < CHAT_GAP_MS) return json({ error: "Slow down a little." }, 429);
      const checked = options.beforeSay ? await options.beforeSay({ id, seat: mySeat, text: String(input.text ?? ""), room: r }) : String(input.text ?? "");
      if (typeof checked !== "string") return json({ error: checked.error }, 403);
      const result = await say(id, mySeat, checked);
      if (typeof result === "string") return json({ error: result }, 400);
      lastSaid.set(key, now); // only a message that was sent counts toward the pace
      if (options.onSay) {
        const said = await room(id);
        if (said) safely(() => options.onSay!({ id, message: result, room: said }));
      }
      return json(result);
    }

    if (action === "act") {
      const entry = await stateOf(id);
      if (entry.state === null) return json({ error: "The game hasn't started." }, 409);
      if (entry.pausedAt !== null) return json({ error: `The table is paused${r.paused?.reason ? `: ${r.paused.reason}` : "."}` }, 423);
      let before: State;
      try {
        before = apply(id, entry, mySeat, input.move as Move);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "That move isn't allowed." }, 400);
      }
      await settle(id, entry, before, mySeat, input.move as Move);
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  }

  // Deadlines have to be kept even if nobody opens the table again after a restart (a day a move):
  // bring back every room that had a clock running. Rooms without one wait for their next request.
  const restored: Promise<void> = def.deadline
    ? docs.then(async (d) => {
        for (const r of d.all("rooms")) if (r.started && r.deadline) await stateOf(r.key).catch((e) => console.error(`rooms: couldn't restore ${r.key}`, e));
      }, (e) => console.error("rooms: couldn't read the rooms to restore their deadlines", e))
    : Promise.resolve();

  return {
    sync,
    /** Resolves once the rooms that had a deadline running before a restart have theirs again. */
    restored,
    create,
    say,
    announce,
    seatPlayer,
    seatBot,
    unseat,
    replaceWithBot,
    start,
    lock,
    exhibit,
    /** Set what the cards look like at a table (anything the app's pages understand), or null for the app's own. */
    setDeck: async (id: string, deck: unknown) => void (await sync.write("rooms", id, { deck: deck ?? null })),
    /** Get a table's computer players moving again (after a restart, nothing else would wake a table with no people). */
    nudge: (id: string) => void driveBots(id),
    holders,
    closeTable,
    pause,
    resume,
    moveFor,
    botMoveFor,
    removePlayer,
    redact,
    /** The public room doc, or undefined. */
    room,
    /** How many rooms have their state in memory (finished ones are dropped). */
    get inMemory() {
      return live.size;
    },
    /** Answers rooms and sync requests; null for anything else. */
    async fetch(request: Request): Promise<Response | null> {
      const { pathname } = new URL(request.url);
      if (pathname === mount || pathname.startsWith(`${mount}/`)) return handleRooms(request, pathname.slice(mount.length));
      return sync.fetch(request);
    },
    /** For Node's http: answers rooms and sync requests and resolves true, else false. */
    async handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<boolean> {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === mount || url.pathname.startsWith(`${mount}/`)) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const request = new Request(url, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
        });
        const response = await handleRooms(request, url.pathname.slice(mount.length));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return true;
      }
      return sync.handle(req, res);
    },
    /** Stop bot timers and deadlines (for tests and shutdown). */
    close() {
      for (const entry of live.values()) {
        stopBot(entry);
        disarm(entry);
      }
    },
  };
}

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What a list of values have in common: the value where they all agree; where they don't, nothing (see sharedView). */
function common(values: unknown[]): unknown {
  const first = values[0];
  if (values.every((v) => same(v, first))) return first;
  // Lists of the same length are compared place by place: a list of seats, a grid of cards.
  if (values.every(Array.isArray)) {
    const lists = values as unknown[][];
    return lists.every((l) => l.length === lists[0]!.length) ? lists[0]!.map((_, i) => common(lists.map((l) => l[i]))) : [];
  }
  // Records with the same keys are compared key by key. Anything else that differs is simply not shown.
  if (values.every(isRecord)) {
    const records = values as Record<string, unknown>[];
    const keys = Object.keys(records[0]!);
    if (records.every((r) => Object.keys(r).length === keys.length && keys.every((k) => k in r))) return Object.fromEntries(keys.map((k) => [k, common(records.map((r) => r[k]))]));
  }
  return null;
}

/**
 * A view for someone watching, made from every seat's view: whatever all the seats see alike is
 * kept, and whatever differs between them (a hand, the moves on offer, a card only one player has
 * peeked at) becomes null, or an empty list. A watcher so learns nothing that every player at the
 * table doesn't already know, in any game, without the game saying which parts are private.
 *
 * Name a game's private parts in `blank` anyway (their values replace the seats' own before
 * comparing): two hands that happened to match in some detail would otherwise show it. `from`
 * takes the named keys from one seat's view as they are, for the parts that say where the viewer
 * sits rather than what they know.
 */
export function sharedView<View extends object>(views: View[], { blank = {}, from }: { blank?: Partial<View>; from?: { seat: number; keys: (keyof View)[] } } = {}): View {
  if (!views.length) throw new Error("A table has at least one seat.");
  const placed = from ? views[from.seat] ?? views[0]! : null;
  const comparable = views.map((v) => {
    const copy = { ...v, ...blank } as Record<string, unknown>;
    // Where the viewer sits differs by definition; it's set from one seat below.
    for (const key of from?.keys ?? []) delete copy[key as string];
    return copy;
  });
  const shared = common(comparable) as Record<string, unknown>;
  for (const key of from?.keys ?? []) shared[key as string] = (placed as Record<string, unknown>)[key as string];
  return shared as View;
}
