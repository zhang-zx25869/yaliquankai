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
  const context = {
    Date,
    Page(value) { definition = value; },
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
      navigateTo(value) { routes.push(value); },
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
  return { page, calls, toasts, routes, setUser(value) { user = value; } };
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

test("read-only detail uses getMatchForEdit and cannot accidentally create a new match", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { page, calls } = loadPage("schedule-form", {
    async call() {
      return { match: {
        _id: "match-1", sport: "篮球", rival: "对手队", location: "体育馆", demands: [],
        isTbd: true, matchTime: null, endTime: null, cellStatus: "tbd", version: 1,
      } };
    },
  });
  page.onLoad({ matchId: "match-1" });
  await page.onShow();
  assert.equal(calls[0].payload.action, "getMatchForEdit");
  assert.equal(page.data.form.isTbd, true);
  assert.equal(page.data.statusLabel, "时间待定");
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
