const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { calendarView, shiftMonth } = require("../miniprogram/utils/calendar");
const NOW = Date.parse("2026-10-05T16:30:00Z");
const empty = () => ({ matches: [], tbdMatches: [] });
const match = (id, fields = {}) => ({ _id: id, teamName: "新雅", rival: "对手", cellStatus: "pending", ...fields });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function loadHome(options = {}) {
  const filename = path.resolve(__dirname, "../miniprogram/pages/index/index.js");
  let definition, stops = 0, user = options.user || { role: "guest" };
  const calls = [], routes = [];
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    Page(value) { definition = value; },
    require(specifier) {
      if (specifier === "../../utils/call") return {
        getUser: () => user,
        waitForUser: options.waitForUser || (() => Promise.resolve(user)),
        call(name, payload, config) {
          calls.push({ name, payload, config });
          return options.call ? options.call(payload) : Promise.resolve(empty());
        },
      };
      return require(path.resolve(path.dirname(filename), specifier));
    },
    wx: { stopPullDownRefresh() { stops += 1; }, navigateTo(route) { routes.push(route); } },
  }, { filename });
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = (patch) => Object.assign(page.data, patch);
  page.onLoad();
  return { page, calls, routes, get stops() { return stops; }, setUser(value) { user = value; } };
}
const selectDay = (page, date) => page.onSelectDay({ currentTarget: { dataset: { date } } });
const toggle = (page, id) => page.onToggleMatch({ detail: { id } });

test("calendar windows use Shanghai midnight, half-open days and leap months", () => {
  const upcoming = calendarView("upcoming", "", NOW);
  assert.equal(upcoming.selectedDate, "2026-10-06");
  assert.equal(upcoming.fromTs, Date.parse("2026-10-06T00:00:00+08:00"));
  assert.equal(upcoming.toTs, Date.parse("2026-11-01T00:00:00+08:00"));
  const leap = calendarView("month", "2024-02-14", NOW);
  assert.equal((leap.toTs - leap.fromTs) / 86400000, 29);
  assert.equal(leap.days.filter((day) => day.day).length, 29);
  assert.equal(leap.days.findIndex((day) => day.day === 1), 4);
  const last = calendarView("day", "2026-12-31", NOW);
  const next = calendarView("day", "2027-01-01", NOW);
  assert.equal(last.toTs, next.fromTs);
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.throws(() => calendarView("day", "2026-02-30", NOW));
});

test("public calendar loads before identity resolves and remains available when login fails", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const login = deferred();
  const context = loadHome({ waitForUser: () => login.promise });
  const show = context.page.onShow();
  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].name, "CalendarManager");
  assert.equal(context.calls[0].payload.fromTs, Date.parse("2026-10-06T00:00:00+08:00"));
  assert.deepEqual(Object.keys(context.calls[0].payload).sort(), ["action", "fromTs", "toTs"]);
  await nextTurn();
  assert.equal(context.page.data.loading, false);
  login.reject(new Error("登录失败"));
  await show;
  assert.equal(context.page.data.isCaptain, false);
  assert.equal(context.page.data.errorText, "");
});

test("public list preserves cancellation, archived zero scores and independent TBD rows", async () => {
  const result = { matches: [match("cancel", { cellStatus: "cancelled" }), match("archive", { isArchived: true, score: "0:0", result: "平" })], tbdMatches: [match("tbd", { isTbd: true, matchTime: null })] };
  const { page, calls } = loadHome({ call: async () => result });
  await page.onShow();
  assert.deepEqual(page.data.matches, result.matches);
  assert.deepEqual(page.data.tbdMatches, result.tbdMatches);
  await selectDay(page, "2025-02-01");
  assert.equal(calls.at(-1).payload.toTs - calls.at(-1).payload.fromTs, 86400000);
  assert.deepEqual(page.data.tbdMatches, result.tbdMatches);
  await page.onMonthChange({ detail: { value: "2025-12" } });
  await page.onShiftMonth({ currentTarget: { dataset: { offset: 1 } } });
  assert.equal(page.data.month, "2026-01");
  assert.equal(page.data.mode, "month");
  await selectDay(page, "2026-01-15");
  await page.onWholeMonth();
  assert.equal(page.data.fromTs, Date.parse("2026-01-01T00:00:00+08:00"));
});

test("today range advances after midnight on returning to the home page", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const { page } = loadHome();
  await page.onShow();
  page.onHide();
  now += 86400000;
  await page.onShow();
  assert.equal(page.data.selectedDate, "2026-10-07");
  await selectDay(page, "2024-02-29");
  await page.onToday();
  assert.equal(page.data.selectedDate, "2026-10-07");
});

test("list failures and malformed responses are retryable, with empty states after recovery", async () => {
  let result = "failure";
  const context = loadHome({ call: async () => {
    if (result === "failure") throw new Error("网络中断");
    return result;
  } });
  await context.page.onShow();
  assert.equal(context.page.data.errorText, "网络中断");
  assert.equal(context.page.data.loading, false);
  result = {};
  await context.page.onRetry();
  assert.match(context.page.data.errorText, /数据异常/);
  result = empty();
  await context.page.onPullDownRefresh();
  assert.equal(context.page.data.errorText, "");
  assert.equal(context.page.data.matches.length, 0);
  assert.equal(context.page.data.tbdMatches.length, 0);
  assert.equal(context.stops, 3);
});

test("fast date changes discard stale list successes and failures and retain latest loading state", async () => {
  const requests = [];
  const context = loadHome({ call: () => { const request = deferred(); requests.push(request); return request.promise; } });
  const first = context.page.onShow();
  const second = selectDay(context.page, "2026-10-08");
  requests[0].resolve({ matches: [match("old")], tbdMatches: [] });
  await first;
  assert.equal(context.page.data.loading, true);
  assert.equal(context.stops, 0);
  const third = selectDay(context.page, "2026-10-09");
  requests[2].resolve({ matches: [match("latest")], tbdMatches: [] });
  await third;
  requests[1].reject(new Error("old failure"));
  await second;
  assert.equal(context.page.data.matches[0]._id, "latest");
  assert.equal(context.page.data.errorText, "");
  assert.equal(context.page.data.loading, false);
  assert.equal(context.stops, 1);
});

test("overlapping pull refreshes only stop the current indicator when the latest request completes", async () => {
  const requests = [];
  const context = loadHome({ call: () => { const request = deferred(); requests.push(request); return request.promise; } });
  const first = context.page.onShow();
  requests[0].resolve(empty());
  await first;
  const old = context.page.onPullDownRefresh();
  const latest = context.page.onPullDownRefresh();
  requests[1].reject(new Error("stale"));
  await old;
  assert.equal(context.page.data.loading, true);
  assert.equal(context.stops, 1);
  requests[2].resolve(empty());
  await latest;
  assert.equal(context.stops, 2);
});

test("detail API is read on each expansion for ordinary and TBD cards, with no management actions", async () => {
  const { page, calls } = loadHome({ call: async (payload) => payload.action === "getCalendar"
    ? { matches: [match("a")], tbdMatches: [match("b", { isTbd: true })] }
    : { match: match(payload.matchId, { cellStatus: "cancelled" }) } });
  await page.onShow();
  await toggle(page, "a");
  assert.equal(page.data.detail.cellStatus, "cancelled");
  assert.equal(calls.at(-1).payload.action, "getMatchDetail");
  await toggle(page, "a");
  assert.equal(page.data.expandedId, "");
  assert.equal(page.data.detail, null);
  await toggle(page, "b");
  assert.equal(page.data.detail._id, "b");
  await toggle(page, "b");
  await toggle(page, "b");
  assert.equal(calls.filter((call) => call.payload.action === "getMatchDetail").length, 3);
  await toggle(page, "missing");
  assert.equal(page.data.expandedId, "b");
  assert.ok(calls.every((call) => call.config.loading === false && call.config.toast === false));
});

test("detail errors, missing matches and mismatched DTOs recover through independent retry", async () => {
  let result = { code: 404 };
  const { page } = loadHome({ call: async (payload) => {
    if (payload.action === "getCalendar") return { matches: [match("a")], tbdMatches: [] };
    if (result.code) throw result;
    return result;
  } });
  await page.onShow();
  await toggle(page, "a");
  assert.match(page.data.detailError, /不存在/);
  assert.equal(page.data.matches.length, 1);
  result = { match: match("wrong") };
  await page.onRetryDetail();
  assert.equal(page.data.detail, null);
  assert.match(page.data.detailError, /异常/);
  result = { match: match("a", { score: "2:1", isArchived: true }) };
  await page.onRetryDetail();
  assert.equal(page.data.detail.score, "2:1");
  assert.equal(page.data.detailError, "");
});

test("opening a second card and collapsing invalidate previous detail requests", async () => {
  const requests = [];
  const { page } = loadHome({ call: (payload) => {
    if (payload.action === "getCalendar") return Promise.resolve({ matches: [match("a"), match("b")], tbdMatches: [] });
    const request = deferred(); requests.push(request); return request.promise;
  } });
  await page.onShow();
  const a = toggle(page, "a");
  const b = toggle(page, "b");
  requests[1].resolve({ match: match("b") });
  await b;
  requests[0].reject(new Error("stale error"));
  await a;
  assert.equal(page.data.detail._id, "b");
  assert.equal(page.data.detailError, "");
  const next = toggle(page, "a");
  await toggle(page, "a");
  requests[2].resolve({ match: match("a") });
  await next;
  assert.equal(page.data.detail, null);
  assert.equal(page.data.expandedId, "");
});

test("list refresh invalidates pending detail even if the same match is opened again", async () => {
  const requests = [];
  const { page } = loadHome({ call: (payload) => {
    if (payload.action === "getCalendar") return Promise.resolve({ matches: [match("a")], tbdMatches: [] });
    const request = deferred(); requests.push(request); return request.promise;
  } });
  await page.onShow();
  const old = toggle(page, "a");
  await page.onPullDownRefresh();
  assert.equal(page.data.expandedId, "");
  const latest = toggle(page, "a");
  requests[1].resolve({ match: match("a", { score: "3:0" }) });
  await latest;
  requests[0].resolve({ match: match("a", { score: "0:0" }) });
  await old;
  assert.equal(page.data.detail.score, "3:0");
});

test("hidden and unloaded pages discard late list, detail and identity responses", async () => {
  for (const lifecycle of ["onHide", "onUnload"]) {
    const login = deferred(), list = deferred();
    const { page } = loadHome({ user: { role: "captain" }, waitForUser: () => login.promise, call: () => list.promise });
    const show = page.onShow();
    page[lifecycle]();
    const snapshot = structuredClone(page.data);
    login.resolve(); list.resolve({ matches: [match("late")], tbdMatches: [] });
    await show;
    assert.deepEqual(structuredClone(page.data), snapshot);
  }
  const detail = deferred();
  const { page } = loadHome({ call: (payload) => payload.action === "getCalendar"
    ? Promise.resolve({ matches: [match("a")], tbdMatches: [] }) : detail.promise });
  await page.onShow();
  const request = toggle(page, "a");
  page.onHide();
  detail.resolve({ match: match("a") });
  await request;
  assert.equal(page.data.detail, null);
  await page.onShow();
  assert.equal(page.data.matches[0]._id, "a");
});

test("captain controls recheck live identity and do not change the public request", async () => {
  const context = loadHome({ user: { role: "captain" } });
  await context.page.onShow();
  assert.equal(context.page.data.isCaptain, true);
  context.page.onPublish(); context.page.onManage();
  assert.deepEqual(context.routes.map((route) => route.url), ["/pages/schedule-form/index", "/pages/schedule-list/index"]);
  context.setUser({ role: "guest" });
  context.page.onPublish(); context.page.onManage();
  assert.equal(context.routes.length, 2);
  await context.page.onShow();
  assert.equal(context.page.data.isCaptain, false);
});

test("shared card labels archived matches without waiting for settlement and clears old status", () => {
  let definition;
  const filename = path.resolve(__dirname, "../miniprogram/components/match-detail-card/index.js");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    Component(value) { definition = value; },
    require(specifier) { return require(path.resolve(path.dirname(filename), specifier)); },
  });
  const card = { data: {}, setData(patch) { Object.assign(this.data, patch); } };
  const observe = definition.properties.match.observer.bind(card);
  observe(match("a", { cellStatus: "settle", isArchived: true }));
  assert.equal(card.data.statusMeta.label, "已归档");
  observe(match("a", { cellStatus: "cancelled", isArchived: true }));
  assert.equal(card.data.statusMeta.label, "已取消");
  observe(null);
  assert.equal(Object.keys(card.data.statusMeta).length, 0);
});
