const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const {
  formatMatchTime,
  toScheduleSummaryDTO,
  toScheduleEditDTO,
  toMatchDTO,
} = require("../cloudfunctions/ScheduleManager/dto");

const fixture = (overrides = {}) => ({
  _id: "match-1",
  teamId: "team-a",
  teamName: "测试队",
  sport: "排球",
  rival: "对手队",
  matchTime: Date.parse("2026-12-28T07:30:00.000Z"),
  endTime: Date.parse("2026-12-28T09:30:00.000Z"),
  location: "综合体育馆",
  demands: ["水", "录像"],
  isTbd: false,
  cellStatus: "confirmed",
  isArchived: false,
  version: 3,
  updatedAt: 123456789,
  ...overrides,
});

const summaryFields = [
  "_id", "teamName", "sport", "rival", "timeText", "location",
  "isTbd", "cellStatus", "updatedAt", "version",
];
const editFields = [
  "_id", "teamId", "teamName", "sport", "rival", "matchTime", "endTime",
  "location", "demands", "isTbd", "cellStatus", "version",
];
const publicFields = [
  "_id", "teamId", "teamName", "sport", "rival", "matchTime", "endTime",
  "location", "demands", "isTbd", "cellStatus", "isArchived", "timeText", "demandsText",
];
const pick = (source, keys) => Object.fromEntries(keys.map((key) => [key, source[key]]));

test("ScheduleSummaryDTO contains exactly the captain list contract fields", () => {
  const raw = fixture();
  assert.deepEqual(toScheduleSummaryDTO(raw), pick({ ...raw, timeText: "12月28日 15:30" }, summaryFields));
});

test("ScheduleEditDTO preserves the raw form values and version with an independent demands array", () => {
  const raw = fixture();
  const dto = toScheduleEditDTO(raw);
  assert.deepEqual(dto, pick(raw, editFields));
  assert.notEqual(dto.demands, raw.demands);
  dto.demands.push("毛巾");
  assert.deepEqual(raw.demands, ["水", "录像"]);
});

test("MatchDTO exposes only public match data and server-formatted text", () => {
  const raw = fixture();
  const dto = toMatchDTO(raw);
  assert.deepEqual(dto, pick({ ...raw, timeText: "12月28日 15:30", demandsText: "水、录像" }, publicFields));
  assert.notEqual(dto.demands, raw.demands);
  dto.demands.push("毛巾");
  assert.deepEqual(raw.demands, ["水", "录像"]);
});

test("only the public DTO optionally includes confirmerNickname", () => {
  const raw = fixture({ confirmerNickname: "小王" });
  assert.equal(toMatchDTO(raw).confirmerNickname, "小王");
  assert.equal(Object.hasOwn(toMatchDTO(fixture()), "confirmerNickname"), false);
  assert.equal(Object.hasOwn(toScheduleSummaryDTO(raw), "confirmerNickname"), false);
  assert.equal(Object.hasOwn(toScheduleEditDTO(raw), "confirmerNickname"), false);
});

test("all DTOs discard identity fields, internal metadata and unexpected nested objects", () => {
  const raw = fixture({
    openid: "secret-self",
    _openid: "secret-owner",
    captainOpenid: "secret-captain",
    confirmerOpenid: "secret-confirmer",
    submitterOpenid: "secret-submitter",
    confirmerType: "assign",
    dutyRevision: 42,
    lastRequestId: "request-1",
    createRequestId: "request-0",
    createdAt: 123,
    internal: { openid: "secret-nested" },
    archive: { submitterOpenid: "secret-archive", mediaLink: "private-media" },
  });
  for (const [convert, fields] of [
    [toScheduleSummaryDTO, summaryFields],
    [toScheduleEditDTO, editFields],
    [toMatchDTO, publicFields],
  ]) {
    const dto = convert(raw);
    assert.deepEqual(Object.keys(dto).sort(), [...fields].sort());
    assert.equal(JSON.stringify(dto).includes("secret-"), false);
    assert.equal(JSON.stringify(dto).includes("private-media"), false);
  }
});

test("DTO conversion does not modify even frozen input records", () => {
  const raw = Object.freeze(fixture({ demands: Object.freeze(["水", "录像"]) }));
  const before = structuredClone(raw);
  for (const convert of [toScheduleSummaryDTO, toScheduleEditDTO, toMatchDTO]) {
    convert(raw);
    assert.deepEqual(raw, before);
  }
});

test("TBD normalizes both timestamps to null and uses the agreed display label", () => {
  const raw = fixture({ isTbd: true, cellStatus: "tbd" });
  for (const convert of [toScheduleEditDTO, toMatchDTO]) {
    const dto = convert(raw);
    assert.equal(dto.matchTime, null);
    assert.equal(dto.endTime, null);
  }
  for (const convert of [toScheduleSummaryDTO, toMatchDTO]) {
    assert.equal(convert(raw).timeText, "时间待定");
    assert.equal(convert(fixture({ isTbd: true, matchTime: null, endTime: null })).timeText, "时间待定");
  }
  assert.equal(formatMatchTime(null, true), "时间待定");
  assert.equal(raw.matchTime, fixture().matchTime);
});

test("empty demands produce an empty display value without changing the array", () => {
  const dto = toMatchDTO(fixture({ demands: [] }));
  assert.deepEqual(dto.demands, []);
  assert.equal(dto.demandsText, "");
});

test("malformed demands cannot carry nested identity data through public or edit DTOs", () => {
  for (const demands of [[{ openid: "secret-nested" }], ["水", 1], { openid: "secret-object" }, "水"]) {
    for (const convert of [toScheduleEditDTO, toMatchDTO]) {
      assert.throws(() => convert(fixture({ demands })), TypeError);
    }
  }
});

test("formatMatchTime uses Shanghai dates at midnight and across year boundaries", () => {
  const examples = [
    ["2026-09-23T15:59:00.000Z", "9月23日 23:59"],
    ["2026-09-23T16:00:00.000Z", "9月24日 00:00"],
    ["2026-12-31T16:00:00.000Z", "1月1日 00:00"],
    ["2026-01-01T00:05:00.000Z", "1月1日 08:05"],
  ];
  for (const [iso, expected] of examples) assert.equal(formatMatchTime(Date.parse(iso)), expected);
});

test("formatMatchTime rejects invalid non-TBD millisecond timestamps", () => {
  for (const value of [undefined, null, "1798443000000", "invalid", NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER, {}, new Date()]) {
    assert.throws(() => formatMatchTime(value), TypeError);
  }
});

test("time formatting is independent of the server's local time zone", () => {
  const dtoPath = path.resolve(__dirname, "../cloudfunctions/ScheduleManager/dto.js");
  const script = `const dto = require(${JSON.stringify(dtoPath)}); process.stdout.write(dto.formatMatchTime(Date.parse("2026-12-31T16:00:00.000Z")));`;
  for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
    const output = execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8", env: { ...process.env, TZ: tz },
    });
    assert.equal(output, "1月1日 00:00", tz);
  }
});
