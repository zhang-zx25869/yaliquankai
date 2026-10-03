const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const NOW = Date.parse("2026-10-03T12:00:00+08:00");
const fixture = (overrides = {}) => ({
  _id: "match-1", teamId: "team-a", cellStatus: "pending", isTbd: false,
  matchTime: NOW + 72 * 3600000, endTime: NOW + 74 * 3600000,
  confirmerOpenid: "", version: 2, dutyRevision: 2, updatedAt: 1, ...overrides,
});

function loadDuty(options = {}) {
  const state = { match: fixture(options.match), records: options.records || [] };
  const user = { _id: "user-1", openid: "manager-1", nickname: "甲", teamId: "team-a", role: "member" };
  const db = {
    command: { exists: (value) => ({ exists: value }) },
    collection(name) {
      return {
        doc() {
          return { async get() {
            if (options.beforeRead) options.beforeRead(state);
            return { data: structuredClone(state.match) };
          } };
        },
        where(query) {
          const matches = (record) => Object.entries(query).every(([key, value]) =>
            value && typeof value === "object" && Object.hasOwn(value, "exists")
              ? Object.hasOwn(record, key) === value.exists : record[key] === value);
          const rows = () => (name === "UserCollection" ? [user] : state.records).filter(matches);
          const reference = {
            limit() { return reference; }, orderBy() { return reference; },
            async get() { return { data: structuredClone(rows()) }; },
            async count() { return { total: rows().length }; },
            async update({ data }) {
              assert.equal(name, "MatchCollection");
              if (options.beforeUpdate) options.beforeUpdate(state);
              if (!matches(state.match)) return { stats: { updated: 0 } };
              Object.assign(state.match, structuredClone(data));
              return { stats: { updated: 1 } };
            },
          };
          return reference;
        },
      };
    },
  };
  const exported = {};
  const filename = path.resolve(__dirname, "../cloudfunctions/DutyManager/index.js");
  vm.runInNewContext(fs.readFileSync(filename, "utf8") + "\nexports.testRecalc = recalcCellStatus;", {
    exports: exported, Date, console: { log() {}, error() {} },
    require() { return { init() {}, database: () => db, getWXContext: () => ({ OPENID: "manager-1" }) }; },
  }, { filename });
  return { state, main: exported.main, recalc: exported.testRecalc };
}

test("old confirmation, rescue and assignment history cannot revive cleared confirmation", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const type of ["confirm", "rescue", "assign"]) {
    const duty = loadDuty({ records: [{ matchId: "match-1", openid: "manager-1", type }] });
    const result = await duty.main({ action: "getRescuePage", matchId: "match-1" });
    assert.equal(result.code, 0);
    assert.equal(result.data.myStatus, "none");
    assert.equal(result.data.match.cellStatus, "pending");
    assert.equal(duty.state.records[0].type, type);
  }
});

test("current confirmation comes from the snapshot even when history has not been written yet", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const duty = loadDuty({ match: { confirmerOpenid: "manager-1", confirmerType: "assign" } });
  const result = await duty.main({ action: "getRescuePage", matchId: "match-1" });
  assert.equal(result.data.myStatus, "confirmed");
  assert.equal(result.data.match.cellStatus, "confirmed");
});

test("recalculation ignores stale confirmer and time values supplied before a schedule edit", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const duty = loadDuty();
  const status = await duty.recalc(fixture({ confirmerOpenid: "old-manager", matchTime: NOW + 1000 }));
  assert.equal(status, "pending");
  assert.equal(duty.state.match.confirmerOpenid, "");
});

test("a concurrent edit to TBD or a terminal state cannot be overwritten by duty recalculation", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const cellStatus of ["tbd", "cancelled", "dutyCancelled", "settle"]) {
    const duty = loadDuty({ beforeUpdate(state) {
      Object.assign(state.match, { version: 3, dutyRevision: 3, cellStatus, updatedAt: 2, confirmerOpenid: "" });
    } });
    assert.equal(await duty.recalc(fixture()), cellStatus);
    assert.equal(duty.state.match.cellStatus, cellStatus);
  }
  const duty = loadDuty({ match: { cellStatus: "tbd", isTbd: true, matchTime: null } });
  assert.equal(await duty.recalc(fixture({ confirmerOpenid: "old-manager" })), "tbd");
});

test("a concurrent confirmation survives a pending recalculation", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const duty = loadDuty({ beforeUpdate(state) {
    Object.assign(state.match, { confirmerOpenid: "manager-2", cellStatus: "confirmed", updatedAt: 2 });
  } });
  assert.equal(await duty.recalc(fixture()), "confirmed");
  assert.equal(duty.state.match.confirmerOpenid, "manager-2");
});

test("decline history still participates in the existing all-declined rule", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const duty = loadDuty({ records: [{ matchId: "match-1", openid: "manager-1", type: "decline" }] });
  const result = await duty.main({ action: "getRescuePage", matchId: "match-1" });
  assert.equal(result.data.myStatus, "declined");
  assert.equal(result.data.match.cellStatus, "help");
});

test("repeated decline still recognizes its existing record after the snapshot-based status change", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const duty = loadDuty({ records: [{ matchId: "match-1", openid: "manager-1", type: "decline" }] });
  const result = await duty.main({ action: "declineDuty", matchId: "match-1" });
  assert.equal(result.code, 0);
  assert.equal(result.data.cellStatus, "help");
  assert.equal(duty.state.records.length, 1);
});
