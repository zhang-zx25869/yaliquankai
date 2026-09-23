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
  const database = {
    collection(name) {
      assert.ok(Object.hasOwn(collections, name), `Unexpected collection: ${name}`);
      return {
        where(query) {
          let limit = Infinity;
          const reference = {
            limit(value) {
              limit = value;
              return reference;
            },
            async get() {
              queries.push({ name, query, limit });
              if (options.databaseError === name) throw options.databaseException || new Error("database unavailable");
              return {
                data: collections[name]
                  .filter((record) => Object.entries(query).every(([key, value]) => record[key] === value))
                  .slice(0, limit),
              };
            },
          };
          return reference;
        },
      };
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
    return { ...schedule, queries, contextCalls: () => contextCalls };
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

test("registered actions authorize valid captains before returning the Day 3 development response", async () => {
  const schedule = loadScheduleManager();
  for (const action of Object.values(schedule.__test__.ACTION)) {
    const result = await invoke(schedule, { action, matchId: "match-1" });
    assert.deepEqual(result, { code: 501, message: `${action} 开发中` });
  }
  assert.equal((await invoke(schedule, { action: "saveMatch" })).code, 501);
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
  assert.equal((await invoke(schedule, { action: "getMatchForEdit", matchId: "match-1" })).code, 501);
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
  assert.equal((await invoke(schedule, { action: "saveMatch" })).code, 501);
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
  assert.equal((await invoke(schedule, { action: "saveMatch", matchId: undefined })).code, 501);
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
