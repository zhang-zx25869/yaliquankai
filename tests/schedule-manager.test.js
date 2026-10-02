const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const scheduleModulePath = path.resolve(
  __dirname,
  "../cloudfunctions/ScheduleManager/index.js",
);

const captain = (overrides = {}) => ({
  _id: "user-1",
  openid: "openid-captain",
  role: "captain",
  teamId: "team-a",
  ...overrides,
});
const team = (overrides = {}) => ({
  _id: "team-a",
  teamName: "测试队",
  enabled: true,
  ...overrides,
});
const match = (overrides = {}) => ({
  _id: "match-1",
  teamId: "team-a",
  captainOpenid: "previous-captain",
  cellStatus: "pending",
  teamName: "测试队", sport: "篮球", rival: "对手队", location: "体育馆",
  matchTime: Date.now() + 72 * 60 * 60 * 1000, endTime: Date.now() + 74 * 60 * 60 * 1000,
  demands: ["饮用水"], isTbd: false, isArchived: false, updatedAt: 100, version: 1,
  ...overrides,
});

function loadScheduleManager(options = {}) {
  const originalLoad = Module._load;
  const queries = [];
  const collections = {
    UserCollection: options.users ?? [captain()],
    TeamCollection: options.teams ?? [team()],
    MatchCollection: options.matches ?? [match()],
  };
  let transactionQueue = Promise.resolve();
  const database = {
    collection(name) {
      assert.ok(Object.hasOwn(collections, name), `Unexpected collection: ${name}`);
      return {
        where(query) {
          let limit = Infinity;
          let offset = 0;
          const order = [];
          const reference = {
            limit(value) { limit = value; return reference; },
            skip(value) { offset = value; return reference; },
            orderBy(field, direction) { order.push({ field, direction }); return reference; },
            async get() {
              queries.push({ name, query, limit });
              if (options.databaseError === name) throw options.databaseException || new Error("database unavailable");
              const result = collections[name].filter((record) =>
                Object.entries(query).every(([key, value]) => record[key] === value));
              if (order.length) result.sort((a, b) => {
                for (const { field, direction } of order) {
                  if (a[field] === b[field]) continue;
                  return (a[field] < b[field] ? -1 : 1) * (direction === "desc" ? -1 : 1);
                }
                return 0;
              });
              return { data: result.slice(offset, offset + limit) };
            },
          };
          return reference;
        },
      };
    },
    runTransaction(callback) {
      const execute = async () => {
        if (options.beforeTransaction) options.beforeTransaction(collections);
        const draft = structuredClone(collections);
        const transaction = {
          collection(name) {
            return {
              doc(id) {
                return {
                  async get() { return { data: draft[name].find((item) => item._id === id) || null }; },
                };
              },
              async add({ data }) {
                if (options.failAdd) throw new Error("simulated write failure");
                if (draft[name].some((item) => item._id === data._id || item.createRequestId === data.createRequestId)) {
                  throw new Error("duplicate document or createRequestId");
                }
                draft[name].push(structuredClone(data));
                return { _id: data._id };
              },
            };
          },
        };
        const result = await callback(transaction);
        for (const name of Object.keys(collections)) collections[name] = draft[name];
        return result;
      };
      const result = transactionQueue.then(execute, execute);
      transactionQueue = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  let contextCalls = 0;
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database: () => database,
    getWXContext() {
      contextCalls += 1;
      if (options.contextError) throw options.contextError;
      return { OPENID: Object.hasOwn(options, "openid") ? options.openid : "openid-captain" };
    },
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "wx-server-sdk") return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[scheduleModulePath];
  try {
    const schedule = require(scheduleModulePath);
    return { ...schedule, queries, collections, contextCalls: () => contextCalls };
  } finally {
    Module._load = originalLoad;
    delete require.cache[scheduleModulePath];
  }
}

async function invoke(schedule, event) {
  const originalError = console.error;
  console.error = () => {};
  try {
    return await schedule.main(event);
  } finally {
    console.error = originalError;
  }
}

test("implemented reads work while edit writes, share and cancellation remain guarded placeholders", async () => {
  const schedule = loadScheduleManager();
  for (const action of ["getShareCard", "cancelMatch", "saveMatch"]) {
    assert.deepEqual(await invoke(schedule, { action, matchId: "match-1" }), { code: 501, message: `${action} 开发中` });
  }
  for (const action of ["getMyMatches", "getMatchForEdit"]) {
    assert.equal((await invoke(schedule, { action, matchId: "match-1" })).code, 0);
  }
  assert.equal((await invoke(schedule, { action: "saveMatch" })).code, 400);
});

test("unknown, missing, and null actions are rejected before requesting cloud identity", async () => {
  const schedule = loadScheduleManager({ contextError: new Error("must not read identity") });
  for (const event of [undefined, null, {}, { action: null }, { action: "notRegistered" }]) {
    assert.deepEqual(await invoke(schedule, event), { code: 400, message: "未知操作" });
  }
  assert.equal(schedule.contextCalls(), 0);
  assert.deepEqual(schedule.queries, []);
});

test("all five actions reject unbound users and non-captain roles", async () => {
  const scenarios = [
    { users: [], expected: 401 },
    { users: [captain({ role: "guest" })], expected: 401 },
    ...["member", "admin"].map((role) => ({ users: [captain({ role })], expected: 403 })),
  ];
  for (const scenario of scenarios) {
    const schedule = loadScheduleManager(scenario);
    for (const action of Object.values(schedule.__test__.ACTION)) {
      const result = await invoke(schedule, { action, matchId: "match-1" });
      assert.equal(result.code, scenario.expected, action);
      assert.equal(typeof result.message, "string");
      assert.equal(Object.hasOwn(result, "data"), false);
    }
    assert.ok(schedule.queries.every(({ name }) => name === "UserCollection"));
  }
});

test("missing cloud OPENID cannot be replaced with identity supplied by the caller", async () => {
  for (const openid of [undefined, null, "", "   "]) {
    const schedule = loadScheduleManager({ openid });
    const result = await invoke(schedule, {
      action: "saveMatch", openid: "openid-captain", OPENID: "openid-captain",
      role: "captain", teamId: "team-a", captainOpenid: "openid-captain",
    });
    assert.equal(result.code, 401);
    assert.deepEqual(schedule.queries, []);
  }
});

test("caller-supplied identity cannot elevate a member or impersonate a different captain", async () => {
  const schedule = loadScheduleManager({
    openid: "openid-member",
    users: [captain(), captain({ _id: "member-1", openid: "openid-member", role: "member" })],
  });
  const result = await invoke(schedule, {
    action: "saveMatch", openid: "openid-captain", OPENID: "openid-captain",
    role: "captain", teamId: "team-a", user: captain(),
  });
  assert.equal(result.code, 403);
  assert.deepEqual(schedule.queries, [
    { name: "UserCollection", query: { openid: "openid-member" }, limit: 2 },
  ]);
});

test("requireCaptain resolves a unique stored identity and enabled team", async () => {
  const user = captain();
  const storedTeam = team();
  const schedule = loadScheduleManager({ users: [user], teams: [storedTeam] });
  assert.deepEqual(await schedule.__test__.requireCaptain("openid-captain"), {
    user, team: storedTeam,
  });
  assert.deepEqual(schedule.queries, [
    { name: "UserCollection", query: { openid: "openid-captain" }, limit: 2 },
    { name: "TeamCollection", query: { _id: "team-a" }, limit: 1 },
  ]);
});

test("duplicate identities fail closed instead of choosing an arbitrary role or team", async () => {
  const schedule = loadScheduleManager({ users: [captain(), captain({ _id: "user-2", teamId: "team-b" })] });
  assert.equal((await invoke(schedule, { action: "getMyMatches" })).code, 500);
  assert.deepEqual(schedule.queries.map(({ name }) => name), ["UserCollection"]);
});

test("missing or disabled teams reject the captain and malformed team names fail closed", async () => {
  const scenarios = [
    ...[undefined, null, "", "   "].map((teamId) => ({ users: [captain({ teamId })], expected: 403 })),
    { teams: [], expected: 403 },
    ...[false, undefined, null, "true", 1].map((enabled) => ({ teams: [team({ enabled })], expected: 403 })),
    ...[undefined, null, "", "   ", 12].map((teamName) => ({ teams: [team({ teamName })], expected: 500 })),
  ];
  for (const scenario of scenarios) {
    const schedule = loadScheduleManager(scenario);
    assert.equal((await invoke(schedule, { action: "saveMatch" })).code, scenario.expected);
    assert.ok(schedule.queries.every(({ name }) => name !== "MatchCollection"));
  }
});

test("editing, sharing, cancellation and existing-match saves enforce team ownership", async () => {
  for (const action of ["getMatchForEdit", "getShareCard", "cancelMatch", "saveMatch"]) {
    const schedule = loadScheduleManager({ matches: [match({ teamId: "team-b" })] });
    const result = await invoke(schedule, {
      action, matchId: "match-1", teamId: "team-b", teamName: "伪造队伍", captainOpenid: "previous-captain",
    });
    assert.equal(result.code, 403, action);
    assert.deepEqual(schedule.queries.at(-1), {
      name: "MatchCollection", query: { _id: "match-1" }, limit: 1,
    });
  }
});

test("ownership follows the captain's current team, allowing another captain of that team", async () => {
  const original = match({ captainOpenid: "other-captain" });
  const schedule = loadScheduleManager({ matches: [original] });
  assert.equal(await schedule.__test__.requireOwnMatch("team-a", "match-1"), original);
  assert.equal((await invoke(schedule, { action: "getMatchForEdit", matchId: "match-1" })).code, 0);
});

test("match identifiers must be nonempty strings and absent matches return 404", async () => {
  for (const action of ["getMatchForEdit", "getShareCard", "cancelMatch"]) {
    for (const matchId of [undefined, null, "", "   ", 123, {}, []]) {
      const schedule = loadScheduleManager();
      assert.equal((await invoke(schedule, { action, matchId })).code, 400, action);
      assert.ok(schedule.queries.every(({ name }) => name !== "MatchCollection"));
    }
  }
  for (const action of ["getMatchForEdit", "getShareCard", "cancelMatch", "saveMatch"]) {
    const schedule = loadScheduleManager({ matches: [] });
    assert.equal((await invoke(schedule, { action, matchId: "missing" })).code, 404, action);
  }
});

test("new-match saves need captain authorization without looking up a match", async () => {
  const schedule = loadScheduleManager();
  assert.equal((await invoke(schedule, { action: "saveMatch" })).code, 400);
  assert.deepEqual(schedule.queries.map(({ name }) => name), ["UserCollection", "TeamCollection"]);
});

test("guard failures are Errors with business codes", async () => {
  const schedule = loadScheduleManager({ users: [], matches: [] });
  await assert.rejects(schedule.__test__.requireCaptain("unknown"), (error) => error instanceof Error && error.code === 401);
  await assert.rejects(schedule.__test__.requireOwnMatch("team-a", "missing"), (error) => error instanceof Error && error.code === 404);
  await assert.rejects(schedule.__test__.requireOwnMatch("team-a", ""), (error) => error instanceof Error && error.code === 400);
});

test("unexpected context and database errors use the standard server response", async () => {
  const scenarios = [
    { contextError: new Error("context unavailable") },
    ...["UserCollection", "TeamCollection", "MatchCollection"].map((databaseError) => ({ databaseError })),
  ];
  for (const scenario of scenarios) {
    const schedule = loadScheduleManager(scenario);
    assert.deepEqual(await invoke(schedule, { action: "getMatchForEdit", matchId: "match-1" }), {
      code: 500, message: "服务器开小差了",
    });
  }
});

test("response helpers and shared constants are frozen and contract-aligned", () => {
  const { ACTION, CELL_STATUS, ROLE, ok, fail } = loadScheduleManager().__test__;
  assert.equal(Object.isFrozen(ACTION), true);
  assert.equal(Object.isFrozen(CELL_STATUS), true);
  assert.equal(Object.isFrozen(ROLE), true);
  assert.deepEqual(ok({ matchId: "match-1" }), { code: 0, data: { matchId: "match-1" } });
  assert.deepEqual(fail(403, "无权操作"), { code: 403, message: "无权操作" });
  assert.deepEqual(CELL_STATUS, {
    PENDING: "pending", CONFIRMED: "confirmed", HELP: "help", SETTLE: "settle",
    TBD: "tbd", CANCELLED: "cancelled", DUTY_CANCELLED: "dutyCancelled",
  });
  assert.equal(ROLE.CAPTAIN, "captain");
});


test("explicit malformed matchId values cannot bypass the save ownership guard", async () => {
  for (const matchId of [null, "", "   ", 123, {}, []]) {
    const schedule = loadScheduleManager();
    assert.equal((await invoke(schedule, { action: "saveMatch", matchId })).code, 400);
    assert.ok(schedule.queries.every(({ name }) => name !== "MatchCollection"));
  }
  const schedule = loadScheduleManager();
  assert.equal((await invoke(schedule, { action: "saveMatch", matchId: undefined })).code, 400);
  assert.ok(schedule.queries.every(({ name }) => name !== "MatchCollection"));
});

test("an SDK error with a code cannot impersonate a trusted business error", async () => {
  const schedule = loadScheduleManager({
    databaseError: "UserCollection",
    databaseException: Object.assign(new Error("private SDK diagnostics"), { code: 403 }),
  });
  assert.deepEqual(await invoke(schedule, { action: "getMyMatches" }), {
    code: 500, message: "服务器开小差了",
  });
});

const NOW = Date.parse("2026-10-02T12:00:00+08:00");
const HOUR = 60 * 60 * 1000;
const validCreate = (overrides = {}) => ({
  action: "saveMatch", requestId: "request-new-1", sport: "篮球", rival: "对手队",
  location: "体育馆", demands: ["饮用水", "摄影"], isTbd: false,
  matchTime: NOW + 72 * HOUR, endTime: NOW + 74 * HOUR, ...overrides,
});

test("management list is team-scoped, excludes archives, retains cancellation, orders and paginates", async () => {
  const records = Array.from({ length: 205 }, (_, index) => match({
    _id: `match-${String(index).padStart(3, "0")}`, updatedAt: index,
  }));
  records[100].isArchived = true;
  records[110].cellStatus = "cancelled";
  records.push(match({ _id: "foreign", teamId: "team-b", updatedAt: 1000 }));
  const schedule = loadScheduleManager({ matches: records });
  const result = await invoke(schedule, { action: "getMyMatches", teamId: "team-b" });
  assert.equal(result.code, 0);
  assert.equal(result.data.list.length, 204);
  assert.equal(result.data.list[0]._id, "match-204");
  assert.equal(result.data.list.at(-1)._id, "match-000");
  assert.ok(result.data.list.some((item) => item._id === "match-110" && item.cellStatus === "cancelled"));
  assert.ok(!JSON.stringify(result.data).includes("Openid"));
  assert.equal(schedule.queries.filter(({ name }) => name === "MatchCollection").length, 3);
  assert.ok(schedule.queries.filter(({ name }) => name === "MatchCollection").every(({ query }) => query.teamId === "team-a"));
  assert.deepEqual((await invoke(loadScheduleManager({ matches: [] }), { action: "getMyMatches" })).data, { list: [] });
});

test("edit read returns raw timestamps and version without private fields and normalizes TBD", async () => {
  const schedule = loadScheduleManager({ matches: [
    match({ matchTime: NOW + 72 * HOUR, endTime: NOW + 74 * HOUR, version: 7, lastRequestId: "private" }),
    match({ _id: "tbd", isTbd: true, cellStatus: "tbd", matchTime: 1, endTime: 2 }),
  ] });
  const result = await invoke(schedule, { action: "getMatchForEdit", matchId: "match-1" });
  assert.equal(result.data.match.matchTime, NOW + 72 * HOUR);
  assert.equal(result.data.match.version, 7);
  assert.deepEqual(result.data.match.demands, ["饮用水"]);
  assert.equal(Object.hasOwn(result.data.match, "captainOpenid"), false);
  assert.equal(Object.hasOwn(result.data.match, "lastRequestId"), false);
  const tbd = await invoke(schedule, { action: "getMatchForEdit", matchId: "tbd" });
  assert.equal(tbd.data.match.matchTime, null);
  assert.equal(tbd.data.match.endTime, null);
});

test("new match derives protected fields, normalizes inputs and initializes revision/version", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const schedule = loadScheduleManager({ matches: [] });
  const result = await invoke(schedule, validCreate({
    sport: " 篮球 ", rival: " 对手队 ", location: " 体育馆 ",
    demands: [" 饮用水 ", "饮用水", "摄影"],
    teamId: "team-b", teamName: "伪造队伍", captainOpenid: "attacker",
    confirmerOpenid: "attacker", dutyRevision: 9, cellStatus: "confirmed", isArchived: true,
  }));
  assert.deepEqual(result.data, { matchId: result.data.matchId, cellStatus: "pending", version: 1 });
  const stored = schedule.collections.MatchCollection[0];
  assert.equal(stored._id, result.data.matchId);
  assert.equal(stored.teamId, "team-a");
  assert.equal(stored.teamName, "测试队");
  assert.equal(stored.captainOpenid, "openid-captain");
  assert.equal(stored.sport, "篮球");
  assert.deepEqual(stored.demands, ["饮用水", "摄影"]);
  assert.equal(stored.dutyRevision, 1);
  assert.equal(stored.version, 1);
  assert.equal(stored.isArchived, false);
  assert.equal(Object.hasOwn(stored, "confirmerOpenid"), false);
  assert.equal(stored.createRequestId, "request-new-1");
  assert.equal(stored.lastRequestId, "request-new-1");
  assert.equal(stored.createdAt, NOW);
  assert.equal(stored.updatedAt, NOW);
  assert.ok(!JSON.stringify(result).includes("openid"));
});

test("new ordinary matches respect the exact 48-hour boundary and TBD ignores time values", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const [distance, expected] of [[48 * HOUR, "pending"], [48 * HOUR - 1, "help"], [HOUR, "help"]]) {
    const schedule = loadScheduleManager({ matches: [] });
    const result = await invoke(schedule, validCreate({ matchTime: NOW + distance }));
    assert.equal(result.code, 0);
    assert.equal(result.data.cellStatus, expected);
  }
  const schedule = loadScheduleManager({ matches: [] });
  const result = await invoke(schedule, validCreate({ isTbd: true, matchTime: "stale", endTime: -1 }));
  assert.equal(result.data.cellStatus, "tbd");
  assert.equal(schedule.collections.MatchCollection[0].matchTime, null);
  assert.equal(schedule.collections.MatchCollection[0].endTime, null);
});

test("invalid new-match fields and timestamps are rejected without writes", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const cases = [
    { requestId: "" }, { requestId: 1 }, { version: 1 },
    ...["sport", "rival", "location"].flatMap((field) =>
      [undefined, null, " ", 1].map((value) => ({ [field]: value }))),
    { demands: undefined }, { demands: "饮用水" }, { demands: [1] }, { demands: [" "] },
    { isTbd: undefined }, { isTbd: "false" },
    ...[undefined, null, "123", Infinity, 1.5, 8640000000000001].map((matchTime) => ({ matchTime })),
    { matchTime: NOW }, { matchTime: NOW - 1 },
    { endTime: NOW + 72 * HOUR }, { endTime: NOW + HOUR }, { endTime: null },
  ];
  for (const fields of cases) {
    const schedule = loadScheduleManager({ matches: [] });
    assert.equal((await invoke(schedule, validCreate(fields))).code, 400, JSON.stringify(fields));
    assert.equal(schedule.collections.MatchCollection.length, 0);
  }
});

test("concurrent and sequential retries create one record, including retries after start time", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const schedule = loadScheduleManager({ matches: [] });
  const event = validCreate();
  const responses = await Promise.all(Array.from({ length: 5 }, () => invoke(schedule, event)));
  assert.ok(responses.every((result) => result.code === 0));
  assert.ok(responses.every((result) => result.data.matchId === responses[0].data.matchId));
  assert.equal(schedule.collections.MatchCollection.length, 1);
  t.mock.method(Date, "now", () => NOW + 100 * HOUR);
  assert.deepEqual(await invoke(schedule, event), responses[0]);
  assert.equal(schedule.collections.MatchCollection.length, 1);
});

test("requestId collisions cannot disclose another team's match or another captain's result", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const overrides of [{ teamId: "team-b" }, { captainOpenid: "another-captain" }]) {
    const schedule = loadScheduleManager({ matches: [match({
      captainOpenid: "openid-captain", createRequestId: "request-new-1", ...overrides,
    })] });
    assert.equal((await invoke(schedule, validCreate())).code, 409);
    assert.equal(schedule.collections.MatchCollection.length, 1);
  }
});

test("new writes recheck identity and enabled team in the transaction, with rollback on failure", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const scenarios = [
    { beforeTransaction: (state) => { state.UserCollection[0].role = "member"; }, code: 403 },
    { beforeTransaction: (state) => { state.UserCollection[0].teamId = "team-b"; }, code: 403 },
    { beforeTransaction: (state) => { state.TeamCollection[0].enabled = false; }, code: 403 },
    { failAdd: true, code: 500 },
  ];
  for (const { code, ...options } of scenarios) {
    const schedule = loadScheduleManager({ matches: [], ...options });
    assert.equal((await invoke(schedule, validCreate())).code, code);
    assert.equal(schedule.collections.MatchCollection.length, 0);
  }
});

test("ordinary and TBD form payloads are accepted by the real ScheduleManager with mocked storage", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { buildCreatePayload } = require("../miniprogram/utils/schedule-form");
  const schedule = loadScheduleManager({ matches: [] });
  const form = {
    sport: "篮球", rival: "对手队", location: "体育馆", demands: [],
    startDate: "2026-10-05", startTime: "14:00", endDate: "2026-10-05", endTime: "16:00",
  };
  for (const isTbd of [false, true]) {
    const payload = buildCreatePayload({ ...form, isTbd }, NOW);
    const result = await invoke(schedule, { action: "saveMatch", requestId: `form-${isTbd}`, ...payload });
    assert.equal(result.code, 0);
    assert.equal(result.data.cellStatus, isTbd ? "tbd" : "pending");
  }
  assert.equal(schedule.collections.MatchCollection.length, 2);
});
