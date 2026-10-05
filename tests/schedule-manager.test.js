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
    DutyRecordCollection: options.duties ?? [],
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
            async count() { return { total: (await reference.get()).data.length }; },
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
                  async update({ data }) {
                    if (options.failUpdate) throw new Error("simulated update failure");
                    const record = draft[name].find((item) => item._id === id);
                    assert.ok(record);
                    Object.assign(record, structuredClone(data));
                    return { stats: { updated: 1 } };
                  },
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

test("implemented reads and share configuration work", async () => {
  const schedule = loadScheduleManager();
  for (const action of ["getShareCard"]) {
    const response = await invoke(schedule, { action, matchId: "match-1" });
    assert.equal(response.code, 0);
    assert.equal(response.data.path, "/pages/respond/index?matchId=match-1");
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

const editableMatch = (overrides = {}) => match({
  matchTime: NOW + 72 * HOUR, endTime: NOW + 74 * HOUR,
  dutyRevision: 3, version: 5, cellStatus: "confirmed",
  confirmerOpenid: "manager-1", confirmerNickname: "经理人甲", confirmerType: "confirm", ...overrides,
});
const validEdit = (overrides = {}) => validCreate({ matchId: "match-1", version: 5, demands: ["饮用水"], ...overrides });

test("basis edits clear every confirmation field, retain history and advance revision/version once", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const changes = [
    { location: "新场馆" }, { matchTime: NOW + 73 * HOUR },
    { endTime: NOW + 75 * HOUR }, { isTbd: true },
  ];
  for (const change of changes) {
    const duty = { _id: "duty-1", matchId: "match-1", openid: "manager-1", type: "confirm" };
    const schedule = loadScheduleManager({ matches: [editableMatch()], duties: [duty] });
    const response = await invoke(schedule, validEdit(change));
    assert.equal(response.code, 0);
    const stored = schedule.collections.MatchCollection[0];
    assert.equal(stored.dutyRevision, 4);
    assert.equal(stored.version, 6);
    assert.equal(stored.cellStatus, change.isTbd ? "tbd" : "pending");
    for (const field of ["confirmerOpenid", "confirmerNickname", "confirmerType"]) assert.equal(stored[field], "");
    assert.deepEqual(schedule.collections.DutyRecordCollection, [duty]);
    assert.equal(stored.captainOpenid, "previous-captain");
    assert.equal(stored.teamId, "team-a");
    assert.equal(stored.lastSaveOpenid, "openid-captain");
    assert.equal(response.data.version, 6);
  }
});

test("text and demand edits preserve confirmation, status and revision including concurrent duty changes", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const state of ["confirmed", "pending", "help", "tbd"]) {
    const original = editableMatch({ cellStatus: state, ...(state === "tbd" ? { isTbd: true, matchTime: null, endTime: null } : {}) });
    const schedule = loadScheduleManager({ matches: [original] });
    const response = await invoke(schedule, validEdit({ sport: "排球", rival: "新对手", demands: ["摄影"], isTbd: original.isTbd }));
    assert.equal(response.code, 0);
    const saved = schedule.collections.MatchCollection[0];
    assert.equal(saved.confirmerOpenid, "manager-1");
    assert.equal(saved.dutyRevision, 3);
    assert.equal(saved.cellStatus, state);
  }
  const schedule = loadScheduleManager({ matches: [editableMatch()], beforeTransaction(state) {
    Object.assign(state.MatchCollection[0], { confirmerOpenid: "new-manager", cellStatus: "confirmed" });
  } });
  await invoke(schedule, validEdit({ rival: "新对手" }));
  assert.equal(schedule.collections.MatchCollection[0].confirmerOpenid, "new-manager");
});

test("TBD transitions normalize times and reset statuses at the exact 48-hour boundary", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const [distance, expected] of [[48 * HOUR, "pending"], [48 * HOUR - 1, "help"]]) {
    for (const wasTbd of [false, true]) {
      const original = editableMatch(wasTbd ? { isTbd: true, cellStatus: "tbd", matchTime: null, endTime: null } : {});
      const schedule = loadScheduleManager({ matches: [original] });
      const result = await invoke(schedule, validEdit({ matchTime: NOW + distance }));
      assert.equal(result.data.cellStatus, expected);
    }
  }
  const schedule = loadScheduleManager({ matches: [editableMatch()] });
  await invoke(schedule, validEdit({ isTbd: true, matchTime: "ignored", endTime: -1 }));
  assert.equal(schedule.collections.MatchCollection[0].matchTime, null);
  assert.equal(schedule.collections.MatchCollection[0].endTime, null);
});

test("reset uses the B-line all-declined rule while zero managers does not force red", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const [total, declined, expected] of [[0, 0, "pending"], [2, 1, "pending"], [2, 2, "help"]]) {
    const schedule = loadScheduleManager({
      matches: [editableMatch()],
      users: [captain(), ...Array.from({ length: total }, (_, i) => captain({ _id: `member-${i}`, openid: `manager-${i}`, role: "member" }))],
      duties: Array.from({ length: declined }, (_, i) => ({ _id: `duty-${i}`, matchId: "match-1", openid: `manager-${i}`, type: "decline" })),
    });
    assert.equal((await invoke(schedule, validEdit({ location: "新场馆" }))).data.cellStatus, expected);
  }
});

test("invalid edits, stale versions, forbidden states and already-started matches never write", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const cases = [
    ...[undefined, null, 0, -1, "5", 1.5].map((version) => ({ event: { version }, code: 400 })),
    { event: { version: 4 }, code: 409 }, { event: { requestId: " " }, code: 400 },
    { event: { location: " " }, code: 400 }, { event: { matchTime: NOW }, code: 400 },
    { event: { endTime: NOW + HOUR }, code: 400 }, { event: { demands: [42] }, code: 400 },
    ...["settle", "cancelled", "dutyCancelled", "invalid"].map((cellStatus) => ({ match: { cellStatus }, code: 409 })),
    { match: { isArchived: true }, code: 409 },
    { match: { matchTime: NOW }, code: 409 }, { match: { endTime: NOW - 1 }, code: 409 },
  ];
  for (const scenario of cases) {
    const original = editableMatch(scenario.match);
    const schedule = loadScheduleManager({ matches: [original] });
    const result = await invoke(schedule, validEdit(scenario.event));
    assert.equal(result.code, scenario.code, JSON.stringify(scenario));
    assert.deepEqual(schedule.collections.MatchCollection, [original]);
  }
});

test("identical concurrent retries return the saved result and cannot increment twice", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const schedule = loadScheduleManager({ matches: [editableMatch()] });
  const event = validEdit({ location: "新场馆" });
  const results = await Promise.all(Array.from({ length: 5 }, () => invoke(schedule, event)));
  assert.ok(results.every((value) => value.code === 0));
  assert.ok(results.every((value) => value.data.version === 6));
  assert.equal(schedule.collections.MatchCollection[0].dutyRevision, 4);
  Object.assign(schedule.collections.MatchCollection[0], { cellStatus: "settle", isArchived: true });
  t.mock.method(Date, "now", () => NOW + 100 * HOUR);
  assert.deepEqual(await invoke(schedule, event), results[0]);
  assert.equal(schedule.collections.MatchCollection[0].cellStatus, "settle");
});

test("different concurrent edits with the same version have exactly one winner", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const schedule = loadScheduleManager({ matches: [editableMatch()] });
  const results = await Promise.all(["one", "two"].map((requestId) => invoke(schedule, validEdit({ requestId, location: requestId }))));
  assert.deepEqual(results.map((value) => value.code).sort(), [0, 409]);
  assert.equal(schedule.collections.MatchCollection[0].version, 6);
});

test("edit transactions recheck identity, ownership, version and status and roll back SDK failures", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const [change, expected] of [
    [(s) => { s.UserCollection[0].role = "member"; }, 403],
    [(s) => { s.UserCollection[0].openid = "other"; }, 401],
    [(s) => { s.TeamCollection[0].enabled = false; }, 403],
    [(s) => { s.MatchCollection[0].teamId = "other"; }, 403],
    [(s) => { s.MatchCollection[0].version += 1; }, 409],
    [(s) => { s.MatchCollection[0].cellStatus = "settle"; }, 409],
    [(s) => { s.MatchCollection.length = 0; }, 404],
  ]) {
    const schedule = loadScheduleManager({ matches: [editableMatch()], beforeTransaction: change });
    assert.equal((await invoke(schedule, validEdit({ location: "新场馆" }))).code, expected);
    assert.notEqual(schedule.collections.MatchCollection[0]?.location, "新场馆");
  }
  const schedule = loadScheduleManager({ matches: [editableMatch()], failUpdate: true });
  assert.equal((await invoke(schedule, validEdit({ location: "新场馆" }))).code, 500);
  assert.equal(schedule.collections.MatchCollection[0].version, 5);
  assert.equal(schedule.collections.MatchCollection[0].confirmerOpenid, "manager-1");
});

test("another captain cannot replay a saved request and replay metadata remains private", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const schedule = loadScheduleManager({ matches: [editableMatch()] });
  await invoke(schedule, validEdit());
  const dto = await invoke(schedule, { action: "getMatchForEdit", matchId: "match-1" });
  assert.ok(!JSON.stringify(dto).includes("lastSave"));
  schedule.collections.MatchCollection[0].lastSaveOpenid = "another-captain";
  assert.equal((await invoke(schedule, validEdit())).code, 409);
});

test("cancellation clears the snapshot, keeps duty history and is idempotent for all allowed statuses", async () => {
  for (const cellStatus of ["pending", "confirmed", "help", "tbd", "dutyCancelled"]) {
    const original = match({ cellStatus, dutyRevision: 4, version: 7,
      confirmerOpenid: "member-1", confirmerNickname: "经理", confirmerType: "confirm",
      ...(cellStatus === "tbd" ? { isTbd: true, matchTime: null, endTime: null } : {}),
    });
    const duties = [{ _id: "duty-1", matchId: "match-1", openid: "member-1", type: "confirm" }];
    const schedule = loadScheduleManager({ matches: [original], duties });
    const event = { action: "cancelMatch", matchId: "match-1", version: 7 };
    const result = await invoke(schedule, event);
    assert.deepEqual(result, { code: 0, data: { cellStatus: "cancelled", version: 8 } });
    const cancelled = structuredClone(schedule.collections.MatchCollection[0]);
    assert.equal(cancelled.dutyRevision, 4);
    assert.equal(cancelled.matchTime, original.matchTime);
    assert.ok(cancelled.updatedAt > original.updatedAt);
    for (const field of ["confirmerOpenid", "confirmerNickname", "confirmerType"]) assert.equal(cancelled[field], "");
    assert.deepEqual(schedule.collections.DutyRecordCollection, duties);
    assert.deepEqual(await invoke(schedule, event), result);
    assert.deepEqual(schedule.collections.MatchCollection[0], cancelled);
    assert.equal((await invoke(schedule, { action: "getMyMatches" })).data.list[0].cellStatus, "cancelled");
  }
});

test("cancellation rejects malformed/stale versions, terminal states and elapsed endTime without writing", async (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const cases = [
    ...[undefined, 0, -1, 1.5, "1"].map((version) => ({ version, code: 400 })),
    { version: 2, code: 409 },
    ...[{ cellStatus: "settle" }, { isArchived: true }, { cellStatus: "unknown" }, { endTime: now }, { endTime: now - 1 }]
      .map((overrides) => ({ overrides, version: 1, code: 409 })),
  ];
  for (const scenario of cases) {
    const original = match(scenario.overrides);
    const schedule = loadScheduleManager({ matches: [original] });
    assert.equal((await invoke(schedule, { action: "cancelMatch", matchId: "match-1", version: scenario.version })).code, scenario.code);
    assert.deepEqual(schedule.collections.MatchCollection, [original]);
  }
  const ongoing = loadScheduleManager({ matches: [match({ matchTime: now - 1, endTime: now + 1 })] });
  assert.equal((await invoke(ongoing, { action: "cancelMatch", matchId: "match-1", version: 1 })).code, 0);
});

test("cancel transaction rereads identity, team, ownership, endTime and archive state", async () => {
  const cases = [
    { change: (c) => { c.UserCollection[0].role = "member"; }, code: 403 },
    { change: (c) => { c.UserCollection[0].openid = "replacement"; }, code: 401 },
    { change: (c) => { c.UserCollection = []; }, code: 401 },
    { change: (c) => { c.TeamCollection[0].enabled = false; }, code: 403 },
    { change: (c) => { c.MatchCollection[0].teamId = "other-team"; }, code: 403 },
    { change: (c) => { c.MatchCollection = []; }, code: 404 },
    { change: (c) => { c.MatchCollection[0].version = 2; }, code: 409 },
    { change: (c) => { c.MatchCollection[0].isArchived = true; }, code: 409 },
    { change: (c) => { c.MatchCollection[0].endTime = Date.now() - 1; }, code: 409 },
  ];
  for (const scenario of cases) {
    const schedule = loadScheduleManager({ beforeTransaction: scenario.change });
    assert.equal((await invoke(schedule, { action: "cancelMatch", matchId: "match-1", version: 1 })).code, scenario.code);
    assert.notEqual(schedule.collections.MatchCollection[0]?.cellStatus, "cancelled");
  }
});

test("concurrent cancellations increment once and a failed cancellation rolls back", async () => {
  const event = { action: "cancelMatch", matchId: "match-1", version: 1 };
  const schedule = loadScheduleManager();
  const results = await Promise.all([invoke(schedule, event), invoke(schedule, event)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].data.version, 2);
  assert.equal(schedule.collections.MatchCollection[0].version, 2);
  const original = match({ confirmerOpenid: "member-1", cellStatus: "confirmed" });
  const failed = loadScheduleManager({ matches: [original], failUpdate: true });
  assert.equal((await invoke(failed, event)).code, 500);
  assert.deepEqual(failed.collections.MatchCollection, [original]);
});

test("cancel and edit with the same version cannot both succeed and old saves cannot replay after cancellation", async () => {
  for (const cancelFirst of [true, false]) {
    const original = match();
    const schedule = loadScheduleManager({ matches: [original] });
    const cancel = { action: "cancelMatch", matchId: "match-1", version: 1 };
    const edit = { ...original, action: "saveMatch", matchId: "match-1", requestId: "edit-before-cancel", rival: "新对手" };
    const results = await Promise.all((cancelFirst ? [cancel, edit] : [edit, cancel]).map((event) => invoke(schedule, event)));
    assert.deepEqual(results.map((result) => result.code), [0, 409]);
    assert.equal(schedule.collections.MatchCollection[0].version, 2);
    if (!cancelFirst) {
      assert.equal((await invoke(schedule, { ...cancel, version: 2 })).code, 0);
      assert.equal((await invoke(schedule, edit)).code, 409);
      assert.equal(schedule.collections.MatchCollection[0].cellStatus, "cancelled");
    }
  }
});

test("captain share cards use respond for every allowed state, encode IDs and label TBD", async () => {
  for (const cellStatus of ["pending", "confirmed", "help", "tbd"]) {
    const stored = match({ _id: "match /?&中文", cellStatus, isTbd: cellStatus === "tbd" });
    const schedule = loadScheduleManager({ matches: [stored] });
    const result = await invoke(schedule, { action: "getShareCard", matchId: stored._id });
    assert.equal(result.code, 0);
    assert.deepEqual(Object.keys(result.data).sort(), ["path", "title"]);
    assert.equal(result.data.path, `/pages/respond/index?matchId=${encodeURIComponent(stored._id)}`);
    for (const text of [stored.sport, stored.teamName, stored.rival]) assert.ok(result.data.title.includes(text));
    if (stored.isTbd) assert.ok(result.data.title.includes("时间待定"));
    assert.equal(JSON.stringify(result).includes("openid"), false);
  }
});

test("share guards reject terminal/archive/end-time states without relying on TimerChecker", async () => {
  for (const fields of [
    ...["cancelled", "settle", "dutyCancelled", "unknown"].map((cellStatus) => ({ cellStatus })),
    { isArchived: true }, { endTime: Date.now() }, { endTime: null },
  ]) {
    const schedule = loadScheduleManager({ matches: [match(fields)] });
    assert.equal((await invoke(schedule, { action: "getShareCard", matchId: "match-1" })).code, 409);
  }
  const crossTeam = loadScheduleManager({ matches: [match({ teamId: "team-b" })] });
  assert.equal((await invoke(crossTeam, { action: "getShareCard", matchId: "match-1", teamId: "team-b" })).code, 403);
  assert.equal((await invoke(loadScheduleManager(), { action: "getShareCard", matchId: "missing" })).code, 404);
});
