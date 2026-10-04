const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { dateTimeFields, toTimestamp, buildCreatePayload } = require("../miniprogram/utils/schedule-form");

const NOW = Date.parse("2026-10-02T12:00:00+08:00");
const validForm = () => ({
  sport: "篮球", rival: "对手队", location: "体育馆", demands: ["饮用水"],
  isTbd: false, startDate: "2026-10-05", startTime: "14:00",
  endDate: "2026-10-05", endTime: "16:00",
});

function loadPage(relativePath, options = {}) {
  const filename = path.resolve(__dirname, "../miniprogram/pages", relativePath, "index.js");
  let definition;
  let user = options.user || { role: "captain" };
  const calls = [];
  const toasts = [];
  const routes = [];
  const modals = [];
  const context = {
    Date,
    Page(value) { definition = value; },
    getCurrentPages: () => options.pages || [],
    require(specifier) {
      if (specifier === "../../utils/call") return {
        getUser: () => user,
        waitForUser: () => options.waitForUser ? options.waitForUser() : Promise.resolve(user),
        async call(name, payload) {
          calls.push({ name, payload: structuredClone(payload) });
          if (options.call) return options.call(name, payload);
          return { matchId: "saved-match", cellStatus: "pending", version: 1 };
        },
      };
      return require(path.resolve(path.dirname(filename), specifier));
    },
    wx: {
      setNavigationBarTitle() {},
      showToast(value) { toasts.push(value); },
      showModal(value) {
        modals.push(value);
        if (options.modal) options.modal(value);
        else if (value.success) value.success({ confirm: options.confirmCancel === true });
      },
      navigateTo(value) { routes.push(value); },
      redirectTo(value) { routes.push(value); },
      navigateBack(value) { routes.push(value); },
      stopPullDownRefresh() {},
      switchTab(value) { routes.push(value); },
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split(".");
      let target = page.data;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts.at(-1)] = value;
    }
  };
  return { page, calls, toasts, routes, modals, setUser(value) { user = value; } };
}

test("form dates use Shanghai time and reject calendar rollovers", () => {
  assert.equal(toTimestamp("2026-10-05", "14:00"), Date.parse("2026-10-05T06:00:00Z"));
  assert.deepEqual(dateTimeFields(Date.parse("2026-10-04T16:30:00Z")), { date: "2026-10-05", time: "00:30" });
  for (const [date, time] of [["2026-02-30", "12:00"], ["2026-13-01", "12:00"], ["2026-10-05", "24:00"], ["", "14:00"]]) {
    assert.ok(Number.isNaN(toTimestamp(date, time)));
  }
  assert.equal(buildCreatePayload(validForm(), NOW).endTime, Date.parse("2026-10-05T08:00:00Z"));
  const tbd = buildCreatePayload({ ...validForm(), isTbd: true, startDate: "", endDate: "" }, NOW);
  assert.equal(tbd.matchTime, null);
  assert.equal(tbd.endTime, null);
});

test("front-end validation rejects required fields, past starts and invalid ends", () => {
  for (const fields of [
    { sport: " " }, { rival: "" }, { location: "" }, { startDate: "" }, { startTime: "" },
    { startDate: "2026-10-01" }, { endTime: "14:00" }, { endDate: "2026-10-04" },
  ]) assert.throws(() => buildCreatePayload({ ...validForm(), ...fields }, NOW));
});

test("captain form submits the contract payload and prevents a second successful save", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { page, calls, toasts } = loadPage("schedule-form");
  page.onLoad({});
  await page.onShow();
  page.setData({ form: validForm() });
  await page.onSave();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "ScheduleManager");
  assert.equal(calls[0].payload.action, "saveMatch");
  assert.equal(calls[0].payload.matchTime, Date.parse("2026-10-05T06:00:00Z"));
  for (const field of ["matchId", "version", "teamId", "teamName", "openid"]) {
    assert.equal(Object.hasOwn(calls[0].payload, field), false);
  }
  assert.ok(calls[0].payload.requestId.startsWith("schedule-"));
  assert.equal(page.data.saved, true);
  assert.equal(page.data.saving, false);
  assert.equal(toasts.at(-1).title, "发布成功");
  await page.onSave();
  assert.equal(calls.length, 1);
  page.onCreateAnother();
  page.setData({ form: { ...validForm(), isTbd: true } });
  await page.onSave();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].payload.matchTime, null);
  assert.notEqual(calls[0].payload.requestId, calls[1].payload.requestId);
});

test("in-flight duplicates are blocked and network retries preserve the original payload/requestId", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  let attempt = 0;
  let release;
  const { page, calls } = loadPage("schedule-form", {
    async call() {
      attempt += 1;
      if (attempt === 1) {
        await new Promise((resolve) => { release = resolve; });
        throw { errMsg: "network interrupted" };
      }
      return { matchId: "saved-match", cellStatus: "pending", version: 1 };
    },
  });
  page.onLoad({});
  await page.onShow();
  page.setData({ form: validForm() });
  const first = page.onSave();
  await page.onSave();
  assert.equal(calls.length, 1);
  release();
  await first;
  assert.equal(page.data.retryPending, true);
  assert.equal(page.data.saving, false);
  page.onFieldInput({ currentTarget: { dataset: { field: "rival" } }, detail: { value: "changed" } });
  assert.equal(page.data.form.rival, "对手队");
  await page.onSave();
  assert.deepEqual(calls[1].payload, calls[0].payload);
  assert.equal(page.data.saved, true);
  assert.equal(page.data.retryPending, false);
});

test("definite validation failure allows correction and creates a new save intent", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  let attempt = 0;
  const { page, calls } = loadPage("schedule-form", {
    async call() {
      attempt += 1;
      if (attempt === 1) throw { code: 400, message: "时间非法" };
      return { matchId: "saved-match", cellStatus: "pending", version: 1 };
    },
  });
  page.onLoad({});
  await page.onShow();
  page.setData({ form: validForm() });
  await page.onSave();
  assert.equal(page.data.retryPending, false);
  page.onFieldInput({ currentTarget: { dataset: { field: "rival" } }, detail: { value: "新对手" } });
  await page.onSave();
  assert.notEqual(calls[1].payload.requestId, calls[0].payload.requestId);
  assert.equal(calls[1].payload.rival, "新对手");
});

test("unbound users and changed identities cannot submit or use the home captain entry", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const guest = loadPage("schedule-form", { user: { role: "guest" } });
  guest.page.onLoad({});
  await guest.page.onShow();
  guest.page.setData({ form: validForm() });
  await guest.page.onSave();
  assert.equal(guest.calls.length, 0);
  assert.equal(guest.page.data.authorized, false);
  const home = loadPage("index");
  await home.page.onShow();
  assert.equal(home.page.data.isCaptain, true);
  home.setUser({ role: "guest" });
  home.page.onPublish();
  assert.equal(home.routes.length, 0);
  await home.page.onShow();
  assert.equal(home.page.data.isCaptain, false);
});

test("terminal detail uses getMatchForEdit and cannot accidentally create a new match", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { page, calls } = loadPage("schedule-form", {
    async call() {
      return { match: {
        _id: "match-1", sport: "篮球", rival: "对手队", location: "体育馆", demands: [],
        isTbd: true, matchTime: null, endTime: null, cellStatus: "cancelled", version: 1,
      } };
    },
  });
  page.onLoad({ matchId: "match-1" });
  await page.onShow();
  assert.equal(calls[0].payload.action, "getMatchForEdit");
  assert.equal(page.data.form.isTbd, true);
  assert.equal(page.data.viewOnly, true);
  await page.onSave();
  assert.equal(calls.length, 1);
});

test("failed identity loading is handled without exposing submission controls", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { page, calls } = loadPage("schedule-form", {
    waitForUser: () => Promise.reject(new Error("身份加载失败")),
  });
  page.onLoad({});
  await page.onShow();
  assert.equal(page.data.ready, true);
  assert.equal(page.data.authorized, false);
  assert.equal(page.data.errorText, "身份加载失败");
  await page.onSave();
  assert.equal(calls.length, 0);
});

test("an incomplete success response preserves the original request for a safe retry", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  let attempt = 0;
  const { page, calls } = loadPage("schedule-form", {
    async call() {
      attempt += 1;
      return attempt === 1 ? null : { matchId: "saved-match", cellStatus: "pending", version: 1 };
    },
  });
  page.onLoad({});
  await page.onShow();
  page.setData({ form: validForm() });
  await page.onSave();
  assert.equal(page.data.retryPending, true);
  await page.onSave();
  assert.deepEqual(calls[1].payload, calls[0].payload);
  assert.equal(page.data.saved, true);
});

const editDTO = (overrides = {}) => ({
  _id: "match-1", sport: "篮球", rival: "对手队", location: "体育馆", demands: ["饮用水"],
  isTbd: false, matchTime: toTimestamp("2026-10-05", "14:00"), endTime: toTimestamp("2026-10-05", "16:00"),
  cellStatus: "confirmed", version: 5, isArchived: false, ...overrides,
});

test("editable DTO populates versioned saves, preserves seconds, and reloads after success", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  let current = editDTO({ matchTime: editDTO().matchTime + 12345, endTime: editDTO().endTime + 45678, demands: ["饮用水", "自定义需求"] });
  const { page, calls, toasts, modals } = loadPage("schedule-form", {
    async call(_name, payload) {
      if (payload.action === "getMatchForEdit") return { match: structuredClone(current) };
      current = { ...current, ...payload, version: payload.version + 1 };
      return { matchId: "match-1", cellStatus: "confirmed", version: current.version };
    },
  });
  page.onLoad({ matchId: "match-1" });
  await page.onShow();
  assert.equal(page.data.viewOnly, false);
  assert.ok(page.data.demandOptions.some((item) => item.value === "自定义需求" && item.checked));
  page.onFieldInput({ currentTarget: { dataset: { field: "rival" } }, detail: { value: "新对手" } });
  await page.onShow();
  assert.equal(page.data.form.rival, "新对手");
  assert.equal(calls.length, 1);
  await page.onSave();
  assert.equal(calls[1].payload.matchId, "match-1");
  assert.equal(calls[1].payload.version, 5);
  assert.equal(calls[1].payload.matchTime, editDTO().matchTime + 12345);
  assert.equal(calls[1].payload.endTime, editDTO().endTime + 45678);
  assert.equal(toasts.at(-1).title, "修改成功");
  assert.equal(modals.length, 0);
  page.onCreateAnother();
  assert.equal(page.data.saved, true);
  await page.onReload();
  assert.equal(page.data.saved, false);
  page.onDemandsChange({ detail: { value: ["摄影"] } });
  await page.onSave();
  assert.equal(calls.at(-1).payload.version, 6);
  assert.equal(modals.length, 1);
  assert.ok(modals[0].content.includes("私聊"));
});

test("version conflicts keep the draft locked until an explicit refresh loads the current version", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  let version = 5;
  const { page, calls } = loadPage("schedule-form", {
    async call(_name, payload) {
      if (payload.action === "getMatchForEdit") return { match: editDTO({ version }) };
      if (payload.version !== version) throw { code: 409, message: "赛程已被修改，请刷新后重试" };
      return { matchId: "match-1", cellStatus: "confirmed", version: version + 1 };
    },
  });
  page.onLoad({ matchId: "match-1" });
  await page.onShow();
  page.onFieldInput({ currentTarget: { dataset: { field: "rival" } }, detail: { value: "草稿" } });
  version = 6;
  await page.onSave();
  assert.equal(page.data.conflict, true);
  assert.equal(page.data.form.rival, "草稿");
  await page.onSave();
  assert.equal(calls.length, 2);
  await page.onReload();
  assert.equal(page.data.conflict, false);
  assert.equal(page.data.form.rival, "对手队");
  await page.onSave();
  assert.equal(calls.at(-1).payload.version, 6);
  assert.notEqual(calls[1].payload.requestId, calls.at(-1).payload.requestId);
});

test("edit weak-network retries survive hide/show and cannot be replaced by refresh", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  let saves = 0;
  const { page, calls } = loadPage("schedule-form", {
    async call(_name, payload) {
      if (payload.action === "getMatchForEdit") return { match: editDTO() };
      saves += 1;
      if (saves === 1) throw { code: 500, message: "响应丢失" };
      return { matchId: "match-1", cellStatus: "pending", version: 6 };
    },
  });
  page.onLoad({ matchId: "match-1" });
  await page.onShow();
  page.onFieldInput({ currentTarget: { dataset: { field: "location" } }, detail: { value: "新场馆" } });
  await page.onSave();
  await page.onShow();
  await page.onReload();
  assert.equal(calls.length, 2);
  assert.equal(page.data.retryPending, true);
  assert.equal(page.data.form.location, "新场馆");
  await page.onSave();
  assert.deepEqual(calls[1].payload, calls[2].payload);
  assert.equal(page.data.saved, true);
});

test("archived, ended and suspended matches and failed edit loads cannot submit", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const scenarios = [
    { isArchived: true }, { cellStatus: "settle" }, { cellStatus: "cancelled" },
    { cellStatus: "dutyCancelled" }, { matchTime: NOW }, { endTime: NOW - 1 }, null,
  ];
  for (const scenario of scenarios) {
    const { page, calls } = loadPage("schedule-form", {
      async call() {
        if (!scenario) throw { code: 500, message: "读取失败" };
        return { match: editDTO(scenario) };
      },
    });
    page.onLoad({ matchId: "match-1" });
    await page.onShow();
    assert.equal(page.data.viewOnly, true);
    await page.onSave();
    assert.equal(calls.length, 1);
  }
});

test("TBD edits send null times and demand reordering does not trigger a private-message reminder", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { page, calls, modals } = loadPage("schedule-form", {
    async call(_name, payload) {
      if (payload.action === "getMatchForEdit") return { match: editDTO({ isTbd: true, matchTime: null, endTime: null, cellStatus: "tbd", demands: ["摄影", "饮用水"] }) };
      return { matchId: "match-1", cellStatus: "tbd", version: 6 };
    },
  });
  page.onLoad({ matchId: "match-1" });
  await page.onShow();
  page.onDemandsChange({ detail: { value: ["饮用水", "摄影"] } });
  await page.onSave();
  assert.equal(calls.at(-1).payload.matchTime, null);
  assert.equal(calls.at(-1).payload.endTime, null);
  assert.equal(modals.length, 0);
});

test("captains can reach the management list and list rows open original edit data", async () => {
  const home = loadPage("index");
  await home.page.onShow();
  home.page.onManage();
  assert.equal(home.routes[0].url, "/pages/schedule-list/index");
  home.setUser({ role: "guest" });
  home.page.onManage();
  assert.equal(home.routes.length, 1);
  let cellStatus = "pending";
  const context = loadPage("schedule-list", { async call() {
    return { list: [{ _id: "match/1", cellStatus, timeText: "时间待定" }] };
  } });
  context.page.onLoad();
  await context.page.onShow();
  assert.equal(context.calls[0].payload.action, "getMyMatches");
  context.page.onOpenMatch({ currentTarget: { dataset: { id: "match/1" } } });
  assert.equal(context.routes[0].url, "/pages/schedule-form/index?matchId=match%2F1");
  cellStatus = "cancelled";
  await context.page.onShow();
  assert.equal(context.page.data.list[0].actionLabel, "查看已取消赛程");
  context.page.onOpenMatch({ currentTarget: { dataset: { id: "missing" } } });
  assert.equal(context.routes.length, 1);
});

test("management list handles empty, denied, failed and overlapping refreshes", async () => {
  for (const role of ["guest", "member", "admin"]) {
    const context = loadPage("schedule-list", { user: { role } });
    context.page.onLoad();
    await context.page.onShow();
    assert.equal(context.page.data.authorized, false);
    assert.equal(context.calls.length, 0);
  }
  let fail = true;
  const context = loadPage("schedule-list", { async call() {
    if (fail) throw { code: 500, message: "加载失败" };
    return { list: [] };
  } });
  context.page.onLoad();
  await context.page.onShow();
  assert.equal(context.page.data.errorText, "加载失败");
  fail = false;
  await context.page.onPullDownRefresh();
  assert.equal(context.page.data.errorText, "");
  assert.equal(context.page.data.list.length, 0);
  let release;
  let count = 0;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const overlapping = loadPage("schedule-list", { async call() {
    if (++count === 1) return new Promise((resolve) => { release = resolve; signalStarted(); });
    return { list: [{ _id: "latest", cellStatus: "cancelled" }] };
  } });
  overlapping.page.onLoad();
  const old = overlapping.page.onShow();
  await started;
  await overlapping.page.onShow();
  release({ list: [{ _id: "stale", cellStatus: "pending" }] });
  await old;
  assert.equal(overlapping.page.data.list[0]._id, "latest");
});

test("cancellation requires confirmation, blocks duplicate clicks and restores saved fields as read-only", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  let current = editDTO();
  let modal;
  const { page, calls, toasts, routes } = loadPage("schedule-form", {
    modal(value) { modal = value; },
    async call(_name, payload) {
      if (payload.action === "getMatchForEdit") return { match: current };
      assert.equal(payload.action, "cancelMatch");
      current = editDTO({ cellStatus: "cancelled", version: 6 });
      return { cellStatus: "cancelled", version: 6 };
    },
  });
  page.onLoad({ matchId: "match-1" });
  await page.onShow();
  let action = page.onCancel();
  assert.equal(page.data.confirmingCancel, true);
  await page.onCancel();
  await page.onSave();
  assert.equal(calls.length, 1);
  modal.success({ confirm: false });
  await action;
  assert.equal(calls.length, 1);
  page.onFieldInput({ currentTarget: { dataset: { field: "rival" } }, detail: { value: "未保存对手" } });
  action = page.onCancel();
  modal.success({ confirm: true });
  await action;
  assert.deepEqual(calls[1].payload, { action: "cancelMatch", matchId: "match-1", version: 5 });
  assert.equal(page.data.viewOnly, true);
  assert.equal(page.data.cancelled, true);
  assert.equal(page.data.form.rival, "对手队");
  assert.equal(page.data.canCancel, false);
  assert.equal(toasts.at(-1).title, "比赛已取消");
  await page.onSave();
  await page.onCancel();
  assert.equal(calls.length, 3);
  page.onManage();
  assert.equal(routes.at(-1).url, "/pages/schedule-list/index");
});

test("uncertain cancellation locks other actions and retries the original version without a second modal", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  let attempt = 0;
  let current = editDTO();
  const { page, calls, modals, routes } = loadPage("schedule-form", {
    confirmCancel: true,
    async call(_name, payload) {
      if (payload.action === "getMatchForEdit") return { match: current };
      attempt += 1;
      current = editDTO({ cellStatus: "cancelled", version: 6 });
      if (attempt === 1) throw { code: 500, message: "响应丢失" };
      if (attempt === 2) return null;
      return { cellStatus: "cancelled", version: 6 };
    },
  });
  page.onLoad({ matchId: "match-1" });
  await page.onShow();
  await page.onCancel();
  assert.equal(page.data.cancelRetryPending, true);
  page.onFieldInput({ currentTarget: { dataset: { field: "rival" } }, detail: { value: "不应写入" } });
  await page.onSave();
  await page.onReload();
  page.onManage();
  await page.onShow();
  assert.equal(page.data.form.rival, "对手队");
  assert.equal(routes.length, 0);
  assert.equal(calls.length, 2);
  await page.onCancel();
  assert.equal(page.data.cancelRetryPending, true);
  await page.onCancel();
  assert.equal(modals.length, 1);
  assert.deepEqual(calls[1].payload, calls[2].payload);
  assert.deepEqual(calls[1].payload, calls[3].payload);
  assert.equal(page.data.cancelled, true);
  assert.equal(page.data.cancelRetryPending, false);
});

test("cancellation conflicts require a reload and a fresh confirmation using the new version", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  let version = 5;
  let cancelled = false;
  const { page, calls, modals } = loadPage("schedule-form", {
    confirmCancel: true,
    async call(_name, payload) {
      if (payload.action === "getMatchForEdit") return { match: editDTO({ version, cellStatus: cancelled ? "cancelled" : "pending" }) };
      if (payload.version !== version) throw { code: 409, message: "请刷新" };
      cancelled = true;
      return { cellStatus: "cancelled", version: ++version };
    },
  });
  page.onLoad({ matchId: "match-1" });
  await page.onShow();
  version = 6;
  await page.onCancel();
  assert.equal(page.data.conflict, true);
  assert.equal(page.data.cancelRetryPending, false);
  await page.onCancel();
  await page.onSave();
  assert.equal(calls.length, 2);
  await page.onReload();
  await page.onCancel();
  assert.equal(calls[3].payload.version, 6);
  assert.equal(modals.length, 2);
  assert.equal(page.data.cancelled, true);
});

test("cancel availability matches the contract, including ongoing and dutyCancelled matches", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const [fields, allowed] of [
    [{ cellStatus: "dutyCancelled" }, true], [{ matchTime: NOW - 1, endTime: NOW + 1 }, true],
    [{ isTbd: true, matchTime: null, endTime: null, cellStatus: "tbd" }, true],
    [{ isArchived: true }, false], [{ cellStatus: "settle" }, false],
    [{ cellStatus: "cancelled" }, false], [{ endTime: NOW }, false],
  ]) {
    const { page, calls } = loadPage("schedule-form", { async call() { return { match: editDTO(fields) }; } });
    page.onLoad({ matchId: "match-1" });
    await page.onShow();
    assert.equal(page.data.canCancel, allowed);
    await page.onCancel();
    assert.equal(calls.length, 1);
  }
});

test("returning after an edit uses the existing management page and does not grow the page stack", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { page, routes } = loadPage("schedule-form", {
    pages: [{ route: "pages/index/index" }, { route: "pages/schedule-list/index" }, { route: "pages/schedule-form/index" }],
    async call() { return { match: editDTO() }; },
  });
  page.onLoad({ matchId: "match-1" });
  await page.onShow();
  page.onManage();
  assert.equal(routes[0].delta, 1);
  assert.equal(routes[0].url, undefined);
});

test("a successful cancellation stays read-only even when its detail refresh fails", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  let cancelled = false;
  const { page, calls } = loadPage("schedule-form", {
    confirmCancel: true,
    async call(_name, payload) {
      if (payload.action === "getMatchForEdit") {
        if (cancelled) throw { code: 500, message: "刷新失败" };
        return { match: editDTO() };
      }
      cancelled = true;
      return { cellStatus: "cancelled", version: 6 };
    },
  });
  page.onLoad({ matchId: "match-1" });
  await page.onShow();
  page.onFieldInput({ currentTarget: { dataset: { field: "rival" } }, detail: { value: "草稿" } });
  await page.onCancel();
  assert.equal(page.data.cancelled, true);
  assert.equal(page.data.viewOnly, true);
  assert.equal(page.data.form.rival, "对手队");
  assert.equal(page.data.cancelRetryPending, false);
  assert.equal(page.data.canCancel, false);
  assert.equal(page.data.errorText, "刷新失败");
  await page.onSave();
  await page.onCancel();
  assert.equal(calls.length, 3);
});
