const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { toMatchDTO } = require("../cloudfunctions/CalendarManager/dto");
const { toMatchDTO: scheduleDTO } = require("../cloudfunctions/ScheduleManager/dto");
const FROM = Date.parse("2026-10-04T16:00:00Z");
const TO = FROM + 86400000;
const match = (fields = {}) => ({
  _id: "match-1", teamId: "team-a", teamName: "测试队", sport: "篮球", rival: "对手",
  location: "体育馆", demands: ["水"], matchTime: FROM, endTime: FROM + 7200000,
  isTbd: false, isArchived: false, cellStatus: "pending", updatedAt: 1, ...fields,
});

function loadCalendar(options = {}) {
  const queries = [];
  const condition = (predicate) => ({ predicate, and(other) { return condition((value) => predicate(value) && other.predicate(value)); } });
  const command = {
    neq: (target) => condition((value) => value !== target),
    gte: (target) => condition((value) => typeof value === "number" && value >= target),
    lt: (target) => condition((value) => typeof value === "number" && value < target),
    in: (targets) => condition((value) => targets.includes(value)),
  };
  const collections = { MatchCollection: options.matches || [], ArchiveCollection: options.archives || [] };
  const db = {
    command,
    collection(name) {
      assert.ok(Object.hasOwn(collections, name), "public reads must not query user/duty records");
      return {
        where(filter) {
          let offset = 0;
          let limit = 20;
          const order = [];
          const query = {
            orderBy(field, direction) { order.push([field, direction]); return query; },
            skip(value) { offset = value; return query; },
            limit(value) { limit = value; return query; },
            async get() {
              queries.push({ name, filter, offset, limit });
              if (options.failCollection === name) throw new Error("secret database failure");
              const rows = collections[name].filter((row) => Object.entries(filter).every(([key, value]) =>
                value && value.predicate ? value.predicate(row[key]) : row[key] === value));
              rows.sort((a, b) => {
                for (const [field, direction] of order) {
                  if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * (direction === "desc" ? -1 : 1);
                }
                return 0;
              });
              return { data: structuredClone(rows.slice(offset, offset + limit)) };
            },
          };
          return query;
        },
      };
    },
  };
  const exports = {};
  const filename = path.resolve(__dirname, "../cloudfunctions/CalendarManager/index.js");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    exports, console: { error() {} },
    require(name) {
      if (name === "./dto") return { toMatchDTO };
      assert.equal(name, "wx-server-sdk");
      return { init() {}, database: () => db, getWXContext() { throw new Error("public API must not require login"); } };
    },
  }, { filename });
  return { queries, main: async (event) => JSON.parse(JSON.stringify(await exports.main(event))) };
}

const query = { action: "getCalendar", fromTs: FROM, toTs: TO };

test("public calendar is a sorted half-open Shanghai date range, retaining cancelled and archived matches", async () => {
  const calendar = loadCalendar({ matches: [
    match({ _id: "before", matchTime: FROM - 1 }), match({ _id: "next-day", matchTime: TO }),
    match({ _id: "cancelled", matchTime: FROM + 1, cellStatus: "cancelled" }),
    match({ _id: "archived", matchTime: TO - 1, isArchived: true, cellStatus: "settle" }),
    match(), match({ _id: "tie", teamId: "team-b" }),
  ], archives: [{ _id: "archive-1", matchId: "archived", score: "2:1", result: "胜", mediaLink: "private-link" }] });
  const result = await calendar.main({ ...query, role: "guest", openid: "spoofed", teamId: "team-z" });
  assert.equal(result.code, 0);
  assert.deepEqual(result.data.matches.map((row) => row._id), ["match-1", "tie", "cancelled", "archived"]);
  assert.equal(result.data.matches[0].timeText, "10月5日 00:00");
  assert.equal(result.data.matches.at(-1).score, "2:1");
  assert.equal(result.data.matches.at(-1).hasMedia, true);
});

test("TBD list ignores the date range, excludes cancelled/archive rows and sorts stably", async () => {
  const tbd = { isTbd: true, cellStatus: "tbd", matchTime: null, endTime: null };
  const calendar = loadCalendar({ matches: [
    match({ ...tbd, _id: "b", updatedAt: 3 }), match({ ...tbd, _id: "a", updatedAt: 3 }),
    match({ ...tbd, _id: "old", updatedAt: 2 }),
    match({ ...tbd, _id: "cancel", cellStatus: "cancelled" }),
    match({ ...tbd, _id: "archived", isArchived: true }),
  ] });
  const result = await calendar.main(query);
  assert.deepEqual(result.data.matches, []);
  assert.deepEqual(result.data.tbdMatches.map((row) => row._id), ["a", "b", "old"]);
  assert.ok(result.data.tbdMatches.every((row) => row.timeText === "时间待定" && row.matchTime === null && row.endTime === null));
});

test("calendar pages past the SDK limit and batches archive joins without losing rows", async () => {
  const matches = Array.from({ length: 205 }, (_, i) => match({ _id: `normal-${i}`, matchTime: FROM + i, isArchived: true }));
  const archives = matches.map((row, i) => ({ _id: `archive-${i}`, matchId: row._id, score: "0:0", result: "平", mediaLink: "" }));
  const tbd = Array.from({ length: 105 }, (_, i) => match({ _id: `tbd-${i}`, isTbd: true, cellStatus: "tbd", matchTime: null, endTime: null }));
  const calendar = loadCalendar({ matches: [...matches, ...tbd], archives });
  const result = await calendar.main(query);
  assert.equal(result.data.matches.length, 205);
  assert.equal(result.data.tbdMatches.length, 105);
  assert.equal(new Set(result.data.matches.map((row) => row._id)).size, 205);
  assert.ok(result.data.matches.every((row) => row.score === "0:0" && row.hasMedia === false));
  assert.ok(calendar.queries.length < 15, "archive joins should be batched, not one query per match");
});

test("invalid ranges and match IDs fail before storage; missing match is 404", async () => {
  const calendar = loadCalendar();
  for (const bad of [undefined, null, "1", NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER, {}, []]) {
    assert.equal((await calendar.main({ ...query, fromTs: bad })).code, 400);
    assert.equal((await calendar.main({ ...query, toTs: bad })).code, 400);
  }
  for (const toTs of [FROM, FROM - 1]) assert.equal((await calendar.main({ ...query, toTs })).code, 400);
  for (const matchId of [undefined, null, " ", {}, 1]) assert.equal((await calendar.main({ action: "getMatchDetail", matchId })).code, 400);
  for (const event of [null, undefined, {}, { action: "getMediaLink" }]) assert.equal((await calendar.main(event)).code, 400);
  assert.equal(calendar.queries.length, 0);
  assert.equal((await calendar.main({ action: "getMatchDetail", matchId: "missing" })).code, 404);
  assert.deepEqual((await calendar.main(query)).data, { matches: [], tbdMatches: [] });
});

test("list and detail have identical public DTOs with no identities, internal state or raw media", async () => {
  const raw = match({ isArchived: true, cellStatus: "settle", confirmerNickname: "经理人",
    openid: "secret", captainOpenid: "secret", confirmerOpenid: "secret", _openid: "secret",
    version: 5, dutyRevision: 3, createRequestId: "secret", lastSaveResult: { openid: "secret" },
    score: "wrong-score", mediaLink: "secret", internal: { openid: "secret" } });
  const calendar = loadCalendar({ matches: [raw], archives: [{
    _id: "archive", matchId: raw._id, score: "3:1", result: "胜", mediaLink: "secret-media",
    submitterOpenid: "secret", openid: "secret", nested: { openid: "secret" },
  }] });
  const detail = (await calendar.main({ action: "getMatchDetail", matchId: raw._id })).data.match;
  assert.deepEqual(detail, (await calendar.main(query)).data.matches[0]);
  assert.deepEqual(Object.keys(detail).sort(), [...Object.keys(scheduleDTO(raw)), "score", "result", "hasMedia"].sort());
  assert.equal(JSON.stringify(detail).includes("secret"), false);
  assert.equal(detail.score, "3:1");
});

test("public DTO agrees with existing ScheduleManager DTO and rejects nested identity injection", () => {
  for (const raw of [match(), match({ isTbd: true }), match({ confirmerNickname: "经理人" })]) {
    assert.deepEqual(toMatchDTO(raw), scheduleDTO(raw));
  }
  for (const field of ["teamName", "sport", "rival", "location", "teamId", "cellStatus", "demands", "matchTime"]) {
    assert.throws(() => toMatchDTO(match({ [field]: { openid: "secret" } })), TypeError);
  }
  const dto = toMatchDTO(match({ isArchived: true }), { score: { openid: "secret" }, result: { openid: "secret" }, mediaLink: { openid: "secret" } });
  assert.equal(JSON.stringify(dto).includes("secret"), false);
  assert.equal(dto.hasMedia, false);
});

test("detail retains terminal matches and handles missing archives without exposing stale fields", async () => {
  const calendar = loadCalendar({ matches: [match({ isArchived: true, cellStatus: "cancelled", score: "stale", mediaLink: "secret" })] });
  const result = await calendar.main({ action: "getMatchDetail", matchId: "match-1" });
  assert.equal(result.code, 0);
  assert.equal(result.data.match.cellStatus, "cancelled");
  assert.equal(result.data.match.hasMedia, false);
  assert.equal(Object.hasOwn(result.data.match, "score"), false);
});

test("database failures and duplicate archives fail closed without leaking partial results", async () => {
  for (const failCollection of ["MatchCollection", "ArchiveCollection"]) {
    const calendar = loadCalendar({ matches: [match({ isArchived: true })], failCollection });
    for (const event of [query, { action: "getMatchDetail", matchId: "match-1" }]) {
      assert.deepEqual(await calendar.main(event), { code: 500, message: "服务器开小差了" });
    }
  }
  const calendar = loadCalendar({ matches: [match({ isArchived: true })], archives: [
    { _id: "a", matchId: "match-1" }, { _id: "b", matchId: "match-1" },
  ] });
  assert.equal((await calendar.main(query)).code, 500);
});
