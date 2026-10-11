const assert = require("node:assert/strict");
const test = require("node:test");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { createScheduleFlow } = require("./helpers/schedule-flow");

const NOW = Date.parse("2026-10-11T12:00:00+08:00");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function seedTeamData(flow) {
  flow.rows.MatchCollection.push(
    {
      _id: "t-arch", teamId: "team-a", teamName: "测试A-队伍", sport: "排球", rival: "历史对手",
      location: "东操", demands: ["饮用水"], isTbd: false, cellStatus: "settle", isArchived: true,
      matchTime: NOW - 7 * 864e5, endTime: NOW - 7 * 864e5 + 72e5,
      confirmerNickname: "部员甲", version: 1, dutyRevision: 1, createdAt: NOW, updatedAt: NOW,
    },
    {
      _id: "t-future", teamId: "team-a", teamName: "测试A-队伍", sport: "排球", rival: "未来对手",
      location: "综体", demands: [], isTbd: false, cellStatus: "pending", isArchived: false,
      matchTime: NOW + 3 * 864e5, endTime: NOW + 3 * 864e5 + 72e5,
      version: 1, dutyRevision: 1, createdAt: NOW, updatedAt: NOW,
    },
    {
      _id: "t-tbd", teamId: "team-a", teamName: "测试A-队伍", sport: "排球", rival: "待定对手",
      location: "待定", demands: [], isTbd: true, cellStatus: "tbd", isArchived: false,
      matchTime: null, endTime: null,
      version: 1, dutyRevision: 1, createdAt: NOW, updatedAt: NOW,
    },
  );
  flow.rows.ArchiveCollection.push({
    _id: "arch-t", matchId: "t-arch", score: "3:1", result: "胜", mediaLink: "https://cloud.example/x",
  });
}

async function open(flow, options = {}) {
  const page = flow.page("team", options);
  await page.onShow();
  return page;
}

test("team page: guest browses roster then a team with upcoming and archived sections", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = createScheduleFlow();
  flow.setIdentity({ role: "guest" }, "guest");
  seedTeamData(flow);
  const page = await open(flow);

  assert.deepEqual(page.data.teams, [{ teamId: "team-a", teamName: "测试A-队伍", sport: "排球" }]);
  assert.equal(page.data.showManage, false);
  assert.equal(page.data.listLoading, false);

  await page.onSelectTeam({ currentTarget: { dataset: { id: "team-a", name: "测试A-队伍", sport: "排球" } } });
  assert.equal(page.data.matchLoading, false);
  // upcoming：TBD 排末尾；archived：带归档比分。
  assert.deepEqual(page.data.upcoming.map((m) => m._id).join(","), "t-future,t-tbd");
  assert.deepEqual(page.data.archived.map((m) => m._id).join(","), "t-arch");
  assert.equal(page.data.archived[0].score, "3:1");
  assert.equal(page.data.archived[0].result, "胜");
  assert.equal(page.data.archived[0].hasMedia, true);
});

test("team page: expands a card via CalendarManager.getMatchDetail and discards stale detail", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = createScheduleFlow();
  flow.setIdentity({ role: "guest" }, "guest");
  seedTeamData(flow);
  const page = await open(flow);
  await page.onSelectTeam({ currentTarget: { dataset: { id: "team-a", name: "测试A-队伍", sport: "排球" } } });

  // 挂起详情请求，切换展开目标后旧响应必须被丢弃。
  const originalCall = flow.api.call;
  flow.api.call = (name, data, opts) => {
    if (name === "CalendarManager") {
      const promise = Promise.resolve({ match: { _id: data.matchId, teamName: "陈旧详情" } });
      return { then: (fn) => promise.then(fn) };
    }
    return originalCall(name, data, opts);
  };
  page.onToggleMatch({ detail: { id: "t-future" } });
  const staleSeq = page._detailSeq;
  flow.api.call = originalCall;
  page.onToggleMatch({ detail: { id: "t-arch" } });
  await nextTurn();
  await nextTurn();
  assert.equal(page.data.expandedId, "t-arch");
  assert.ok(page.data.detail && page.data.detail._id === "t-arch");
  assert.ok(staleSeq < page._detailSeq);
});

test("team page: list failure retries and match failure retries independently", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  // beforeCall 抛错 → callFunction 拒绝 → call.js 走网络异常分支；页面展示独立重试。
  const flags = { failList: true, failMatches: false };
  const flow = createScheduleFlow({
    beforeCall(name, data) {
      if (flags.failList && data.action === "getTeamList") throw new Error("列表请求失败");
      if (flags.failMatches && data.action === "getTeamMatches") throw new Error("赛程请求失败");
    },
  });
  flow.setIdentity({ role: "guest" }, "guest");
  seedTeamData(flow);
  const page = flow.page("team");
  await page.onShow();
  assert.equal(page.data.listError, "列表请求失败");
  assert.equal(page.data.listLoading, false);

  flags.failList = false;
  await page.loadTeams();
  assert.equal(page.data.listError, "");
  assert.equal(page.data.teams.length, 1);

  // 选队后比赛加载失败与列表互不影响。
  flags.failMatches = true;
  await page.onSelectTeam({ currentTarget: { dataset: { id: "team-a", name: "测试A-队伍", sport: "排球" } } });
  assert.equal(page.data.matchError, "赛程请求失败");
  assert.equal(page.data.listError, "");
  flags.failMatches = false;
  await page.onRetryMatches();
  assert.equal(page.data.matchError, "");
  assert.equal(page.data.upcoming.length, 2);
});

test("team page: captain sees manage entry only for own team and jumps to schedule-list", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = createScheduleFlow();
  seedTeamData(flow);
  flow.setIdentity({ role: "captain", teamId: "team-a", nickname: "队长" }, "private-captain");
  const page = await open(flow);
  assert.equal(page.data.showManage, true);

  await page.onSelectTeam({ currentTarget: { dataset: { id: "team-a", name: "测试A-队伍", sport: "排球" } } });
  assert.equal(page.data.showManage, true);
  page.onManage();
  assert.equal(flow.routes.at(-1).url, "/pages/schedule-list/index");

  // 非本队队长不显示管理入口。
  await page.onBackToTeams();
  flow.setIdentity({ role: "captain", teamId: "team-other", nickname: "别队队长" }, "captain-other");
  await page.refreshIdentity();
  await page.onSelectTeam({ currentTarget: { dataset: { id: "team-a", name: "测试A-队伍", sport: "排球" } } });
  assert.equal(page.data.showManage, false);
  page.onManage();
  assert.equal(flow.routes.at(-1).url, "/pages/schedule-list/index");
});

test("team page: hide discards late responses and re-show refreshes selected team", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = createScheduleFlow();
  flow.setIdentity({ role: "guest" }, "guest");
  seedTeamData(flow);
  const page = flow.page("team");

  const gate = deferred();
  const originalCall = flow.api.call;
  flow.api.call = (name, data, opts) => (data.action === "getTeamList" ? gate.promise : originalCall(name, data, opts));
  const showing = page.onShow();
  page.onHide(); // 挂起期间离开
  gate.resolve({ teams: [{ teamId: "team-x", teamName: "迟到数据", sport: "x" }] });
  await showing;
  await nextTurn();
  assert.equal(page.data.teams.length, 0); // 迟到响应被丢弃

  flow.api.call = originalCall;
  page._active = true;
  await page.onSelectTeam({ currentTarget: { dataset: { id: "team-a", name: "测试A-队伍", sport: "排球" } } });
  page.onHide();
  page.onShow();
  await nextTurn();
  await nextTurn();
  assert.equal(page.data.teamId, "team-a");
  assert.equal(page.data.upcoming.length, 2);
});
