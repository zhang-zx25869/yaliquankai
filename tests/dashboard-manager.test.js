const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const dashboardModulePath = path.resolve(
  __dirname,
  "../cloudfunctions/DashboardManager/index.js",
);
const statusPath = path.resolve(__dirname, "../miniprogram/utils/status.js");

function loadDashboardManager() {
  const originalLoad = Module._load;
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database: () => ({ command: {} }), // 纯函数测试不触库，仅满足顶层初始化
    getWXContext: () => ({ OPENID: "openid-c" }),
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "wx-server-sdk") return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[dashboardModulePath];
  try {
    return require(dashboardModulePath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[dashboardModulePath];
  }
}

test("DashboardManager constants are frozen and match the frontend status contract", () => {
  const { CELL_STATUS, ROLE, DUTY_TYPE, HOURS } = loadDashboardManager().__test__;
  const status = require(statusPath);

  assert.equal(Object.isFrozen(CELL_STATUS), true);
  assert.equal(Object.isFrozen(ROLE), true);
  assert.deepEqual(CELL_STATUS, status.CELL_STATUS);
  assert.deepEqual(ROLE, status.ROLE);
  assert.deepEqual(DUTY_TYPE, status.DUTY_TYPE);
  assert.deepEqual(HOURS, status.HOURS);
});

test("decideFallbackStatus settles matches that reached the scheduled end time", () => {
  const { decideFallbackStatus, CELL_STATUS } = loadDashboardManager().__test__;
  const now = Date.now();

  // 黄/绿/红态到场结束时间 → 橙（endTime 为 settle 判据）
  [CELL_STATUS.PENDING, CELL_STATUS.CONFIRMED, CELL_STATUS.HELP].forEach((cellStatus) => {
    assert.equal(
      decideFallbackStatus(
        { cellStatus, endTime: now - 1, matchTime: now - 7200 * 1000 },
        now,
      ),
      CELL_STATUS.SETTLE,
    );
  });
  // 恰好到点（endTime == now）→ 橙
  assert.equal(
    decideFallbackStatus({ cellStatus: CELL_STATUS.CONFIRMED, endTime: now, matchTime: now - 1 }, now),
    CELL_STATUS.SETTLE,
  );
});

test("decideFallbackStatus pulls red only for unconfirmed pending matches inside 48 hours", () => {
  const { decideFallbackStatus, CELL_STATUS, HOURS } = loadDashboardManager().__test__;
  const now = Date.now();

  // 黄态无跟场人且临期 → 红
  assert.equal(
    decideFallbackStatus(
      { cellStatus: CELL_STATUS.PENDING, matchTime: now + HOURS.FORCE_RED * 3600 * 1000 - 1 },
      now,
    ),
    CELL_STATUS.HELP,
  );
  // 恰好 48h → 黄（开区间契约「恰好 48 小时仍为黄色」）
  assert.equal(
    decideFallbackStatus(
      { cellStatus: CELL_STATUS.PENDING, matchTime: now + HOURS.FORCE_RED * 3600 * 1000 },
      now,
    ),
    null,
  );
  // >48h → 维持黄
  assert.equal(
    decideFallbackStatus(
      { cellStatus: CELL_STATUS.PENDING, matchTime: now + 3 * 24 * 3600 * 1000 },
      now,
    ),
    null,
  );
  // 已有跟场人 → 不拉红
  assert.equal(
    decideFallbackStatus(
      { cellStatus: CELL_STATUS.PENDING, confirmerOpenid: "openid-x", matchTime: now + 3600 * 1000 },
      now,
    ),
    null,
  );
  // TBD（matchTime=null）→ 不拉红
  assert.equal(
    decideFallbackStatus({ cellStatus: CELL_STATUS.PENDING, matchTime: null }, now),
    null,
  );
});

test("decideFallbackStatus leaves terminal and suspended states untouched", () => {
  const { decideFallbackStatus, CELL_STATUS } = loadDashboardManager().__test__;
  const now = Date.now();

  // tbd/cancelled/dutyCancelled/settle 不参与兜底；已取消无 endTime 亦不动
  [CELL_STATUS.TBD, CELL_STATUS.CANCELLED, CELL_STATUS.DUTY_CANCELLED, CELL_STATUS.SETTLE]
    .forEach((cellStatus) => {
      assert.equal(decideFallbackStatus({ cellStatus, endTime: now - 1, matchTime: null }, now), null);
    });
});

test("toDTO strips every openid field and keeps display metadata", () => {
  const { toDTO } = loadDashboardManager().__test__;

  const dto = toDTO({
    _id: "m1", teamId: "t1", teamName: "男排", sport: "排球", rival: "对手学院",
    matchTime: 1735000000000, endTime: 1735009000000, location: "气膜馆",
    demands: ["饮用水", "记分"], isTbd: false, cellStatus: "confirmed",
    captainOpenid: "openid-captain",      // 必须被剔除（接口约定 8.2）
    confirmerOpenid: "openid-member",     // 必须被剔除
    confirmerNickname: "小新", confirmerType: "confirm",
    isArchived: false,
  });

  assert.equal(dto.captainOpenid, undefined);
  assert.equal(dto.confirmerOpenid, undefined);
  assert.equal(dto.confirmerNickname, "小新");
  assert.equal(dto.confirmerType, "confirm");
  assert.equal(dto.demandsText, "饮用水、记分");
  assert.equal(dto.timeText.includes("月"), true);
  assert.equal(dto.isArchived, false);
});
