const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const timerModulePath = path.resolve(
  __dirname,
  "../cloudfunctions/TimerChecker/index.js",
);
const statusPath = path.resolve(__dirname, "../miniprogram/utils/status.js");

function loadTimerChecker() {
  const originalLoad = Module._load;
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database: () => ({ command: {} }), // 纯函数测试不触库，仅满足顶层初始化
    getWXContext: () => ({}), // 定时触发无 OPENID
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "wx-server-sdk") return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[timerModulePath];
  try {
    return require(timerModulePath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[timerModulePath];
  }
}

test("TimerChecker constants are frozen and match the frontend status contract", () => {
  const { CELL_STATUS, HOURS } = loadTimerChecker().__test__;
  const status = require(statusPath);

  assert.equal(Object.isFrozen(CELL_STATUS), true);
  assert.deepEqual(CELL_STATUS, status.CELL_STATUS);
  assert.deepEqual(HOURS, status.HOURS);
});

test("isOverdueForHelp pulls red only inside 48h, unconfirmed, with a real time", () => {
  const { isOverdueForHelp, CELL_STATUS, HOURS } = loadTimerChecker().__test__;
  const now = Date.now();

  // 黄态无跟场人且临期 → 应拉红
  assert.equal(
    isOverdueForHelp({ cellStatus: CELL_STATUS.PENDING, matchTime: now + HOURS.FORCE_RED * 3600 * 1000 - 1 }, now),
    true,
  );
  // 恰好 48h → 不拉红（开区间契约「恰好 48 小时仍为黄色」）
  assert.equal(
    isOverdueForHelp({ cellStatus: CELL_STATUS.PENDING, matchTime: now + HOURS.FORCE_RED * 3600 * 1000 }, now),
    false,
  );
  // >48h → 不拉红
  assert.equal(
    isOverdueForHelp({ cellStatus: CELL_STATUS.PENDING, matchTime: now + 3 * 24 * 3600 * 1000 }, now),
    false,
  );
  // 已有跟场人 → 不拉红
  assert.equal(
    isOverdueForHelp({ cellStatus: CELL_STATUS.PENDING, confirmerOpenid: "openid-x", matchTime: now + 3600 * 1000 }, now),
    false,
  );
  // TBD（matchTime=null）→ 不拉红
  assert.equal(
    isOverdueForHelp({ cellStatus: CELL_STATUS.PENDING, matchTime: null }, now),
    false,
  );
  // 红态本身 → 不再重复拉红
  assert.equal(
    isOverdueForHelp({ cellStatus: CELL_STATUS.HELP, matchTime: now + 3600 * 1000 }, now),
    false,
  );
});

test("isEndedForSettle turns orange exactly at the scheduled end time", () => {
  const { isEndedForSettle, CELL_STATUS } = loadTimerChecker().__test__;
  const now = Date.now();

  // 黄/绿/红态到点 → 应转橙
  [CELL_STATUS.PENDING, CELL_STATUS.CONFIRMED, CELL_STATUS.HELP].forEach((cellStatus) => {
    assert.equal(isEndedForSettle({ cellStatus, endTime: now }, now), true);
  });
  // 恰好 endTime == now → 转橙
  assert.equal(isEndedForSettle({ cellStatus: CELL_STATUS.CONFIRMED, endTime: now }, now), true);
  // 未到点 → 不转
  assert.equal(isEndedForSettle({ cellStatus: CELL_STATUS.CONFIRMED, endTime: now + 1 }, now), false);
  // endTime 为 null（TBD）→ 不转
  assert.equal(isEndedForSettle({ cellStatus: CELL_STATUS.PENDING, endTime: null }, now), false);
  // 已是橙态 → 不重复转
  assert.equal(isEndedForSettle({ cellStatus: CELL_STATUS.SETTLE, endTime: now }, now), false);
});
