const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const scheduleModulePath = path.resolve(
  __dirname,
  "../cloudfunctions/ScheduleManager/index.js",
);

function loadScheduleManager(options = {}) {
  const originalLoad = Module._load;
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    getWXContext() {
      if (options.contextError) throw options.contextError;
      return { OPENID: options.openid || "openid-captain" };
    },
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "wx-server-sdk") return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[scheduleModulePath];
  try {
    return require(scheduleModulePath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[scheduleModulePath];
  }
}

test("registered ScheduleManager actions return the Day 2 development response", async () => {
  const schedule = loadScheduleManager();
  const actions = Object.values(schedule.__test__.ACTION);

  for (const action of actions) {
    const result = await schedule.main({ action });
    assert.deepEqual(result, { code: 501, message: `${action} 开发中` });
  }
});

test("unknown or missing actions return the standard parameter error", async () => {
  const schedule = loadScheduleManager();

  assert.deepEqual(await schedule.main({ action: "notRegistered" }), {
    code: 400,
    message: "未知操作",
  });
  assert.deepEqual(await schedule.main(), { code: 400, message: "未知操作" });
});

test("unexpected cloud errors are converted to the standard server error", async () => {
  const schedule = loadScheduleManager({ contextError: new Error("context unavailable") });
  const originalError = console.error;
  console.error = () => {};

  try {
    assert.deepEqual(await schedule.main({ action: "getMyMatches" }), {
      code: 500,
      message: "服务器开小差了",
    });
  } finally {
    console.error = originalError;
  }
});

test("response helpers and shared constants are frozen and contract-aligned", () => {
  const { ACTION, CELL_STATUS, ROLE, ok, fail } = loadScheduleManager().__test__;

  assert.equal(Object.isFrozen(ACTION), true);
  assert.equal(Object.isFrozen(CELL_STATUS), true);
  assert.equal(Object.isFrozen(ROLE), true);
  assert.deepEqual(ok({ matchId: "match-1" }), {
    code: 0,
    data: { matchId: "match-1" },
  });
  assert.deepEqual(fail(403, "无权操作"), { code: 403, message: "无权操作" });
  assert.deepEqual(CELL_STATUS, {
    PENDING: "pending",
    CONFIRMED: "confirmed",
    HELP: "help",
    SETTLE: "settle",
    TBD: "tbd",
    CANCELLED: "cancelled",
    DUTY_CANCELLED: "dutyCancelled",
  });
  assert.equal(ROLE.CAPTAIN, "captain");
});
