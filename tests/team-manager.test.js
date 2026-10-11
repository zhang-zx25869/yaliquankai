const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 加载真实云函数源码，注入内存数据库（与 schedule-flow 夹具同思路的轻量版）。
const indexSrc = fs.readFileSync(
  path.join(__dirname, "../cloudfunctions/TeamManager/index.js"), "utf8");
const dtoSrc = fs.readFileSync(
  path.join(__dirname, "../cloudfunctions/TeamManager/dto.js"), "utf8");

function createDb(rows) {
  const condition = (test) => ({
    test,
    and(other) { return condition((value) => test(value) && other.test(value)); },
  });
  return {
    command: {
      in: (targets) => condition((value) => targets.includes(value)),
    },
    collection(name) {
      assert.ok(Object.hasOwn(rows, name), `未知集合：${name}`);
      return {
        where(filter) {
          let offset = 0, size = 20;
          const order = [];
          const filtered = () => rows[name].filter((row) => Object.entries(filter).every(([key, value]) =>
            value && value.test ? value.test(row[key]) : row[key] === value));
          const query = {
            limit(value) { size = value; return query; },
            skip(value) { offset = value; return query; },
            orderBy(field, direction) { order.push([field, direction]); return query; },
            async get() {
              const result = filtered().sort((a, b) => {
                for (const [field, direction] of order) {
                  if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * (direction === "desc" ? -1 : 1);
                }
                return 0;
              });
              return { data: structuredClone(result.slice(offset, offset + size)) };
            },
          };
          return query;
        },
      };
    },
  };
}

function loadFunction(rows, event) {
  const module_ = { exports: {} };
  const sandbox = {
    console,
    module: module_,
    exports: module_.exports,
    require: (name) => {
      if (name === "wx-server-sdk") {
        return {
          init() {},
          DYNAMIC_CURRENT_ENV: Symbol("env"),
          database: () => createDb(rows),
        };
      }
      if (name === "./dto") {
        const dtoContext = vm.createContext({ module: { exports: {} }, exports: {} });
        vm.runInContext(dtoSrc, dtoContext);
        return dtoContext.module.exports;
      }
      throw new Error(`意外依赖：${name}`);
    },
  };
  vm.runInNewContext(indexSrc, sandbox);
  return module_.exports.main(event);
}

function seedRows() {
  const now = Date.now();
  return {
    TeamCollection: [
      { _id: "team-b", teamName: "测试B-足球", sport: "足球", enabled: true, sortOrder: 2 },
      { _id: "team-a", teamName: "测试A-排球", sport: "排球", enabled: true, sortOrder: 1 },
      { _id: "team-off", teamName: "停用队", sport: "篮球", enabled: false, sortOrder: 0 },
    ],
    MatchCollection: [
      { _id: "m-arch-old", teamId: "team-a", teamName: "测试A-排球", sport: "排球", rival: "旧对手",
        matchTime: now - 14 * 864e5, endTime: now - 14 * 864e5 + 72e5, location: "东操",
        demands: ["饮用水"], isTbd: false, cellStatus: "settle", isArchived: true,
        confirmerNickname: "部员甲", createdAt: now, updatedAt: now },
      { _id: "m-arch-new", teamId: "team-a", teamName: "测试A-排球", sport: "排球", rival: "新对手",
        matchTime: now - 7 * 864e5, endTime: now - 7 * 864e5 + 72e5, location: "东操",
        demands: [], isTbd: false, cellStatus: "settle", isArchived: true,
        confirmerNickname: "部员乙", createdAt: now, updatedAt: now },
      { _id: "m-far", teamId: "team-a", teamName: "测试A-排球", sport: "排球", rival: "远期对手",
        matchTime: now + 14 * 864e5, endTime: now + 14 * 864e5 + 72e5, location: "综体",
        demands: ["摄影"], isTbd: false, cellStatus: "pending", isArchived: false,
        createdAt: now, updatedAt: now },
      { _id: "m-near", teamId: "team-a", teamName: "测试A-排球", sport: "排球", rival: "临期对手",
        matchTime: now + 3 * 864e5, endTime: now + 3 * 864e5 + 72e5, location: "综体",
        demands: [], isTbd: false, cellStatus: "help", isArchived: false,
        confirmerNickname: "部员丙", createdAt: now, updatedAt: now },
      { _id: "m-tbd", teamId: "team-a", teamName: "测试A-排球", sport: "排球", rival: "待定对手",
        matchTime: null, endTime: null, location: "待定", demands: [], isTbd: true,
        cellStatus: "tbd", isArchived: false, createdAt: now, updatedAt: now },
      { _id: "m-cancelled", teamId: "team-a", teamName: "测试A-排球", sport: "排球", rival: "取消对手",
        matchTime: now + 20 * 864e5, endTime: now + 20 * 864e5 + 72e5, location: "东操",
        demands: [], isTbd: false, cellStatus: "cancelled", isArchived: false,
        createdAt: now, updatedAt: now },
      { _id: "m-other", teamId: "team-b", teamName: "测试B-足球", sport: "足球", rival: "别队对手",
        matchTime: now + 864e5, endTime: now + 864e5 + 54e5, location: "西操",
        demands: [], isTbd: false, cellStatus: "pending", isArchived: false,
        createdAt: now, updatedAt: now },
    ],
    ArchiveCollection: [
      { _id: "arch-1", matchId: "m-arch-new", score: "3:1", result: "胜", mediaLink: "https://cloud.example/s/xyz" },
      { _id: "arch-2", matchId: "m-arch-old", score: "2:2", result: "平", mediaLink: "   " },
    ],
  };
}

test("getTeamList returns only enabled teams sorted by sortOrder with whitelisted fields", async () => {
  const result = await loadFunction(seedRows(), { action: "getTeamList" });
  assert.equal(result.code, 0);
  // structuredClone 后对象键序一致，但稳妥起见逐字段断言而非整对象比较。
  assert.deepEqual(result.data.teams.map((t) => [t.teamId, t.teamName, t.sport]), [
    ["team-a", "测试A-排球", "排球"],
    ["team-b", "测试B-足球", "足球"],
  ]);
});

test("getTeamMatches splits upcoming and archived with TBD last and archives merged", async () => {
  const rows = seedRows();
  const result = await loadFunction(rows, { action: "getTeamMatches", teamId: "team-a" });
  assert.equal(result.code, 0);
  const { upcoming, archived } = result.data;

  assert.deepEqual(upcoming.map((m) => m._id).join(","), "m-near,m-far,m-cancelled,m-tbd");
  assert.deepEqual(archived.map((m) => m._id).join(","), "m-arch-new,m-arch-old");

  const merged = archived.find((m) => m._id === "m-arch-new");
  assert.equal(merged.score, "3:1");
  assert.equal(merged.result, "胜");
  assert.equal(merged.hasMedia, true);

  const noMedia = archived.find((m) => m._id === "m-arch-old");
  assert.equal(noMedia.score, "2:2");
  assert.equal(noMedia.hasMedia, false);
});

test("public DTOs never leak openid, confirmerOpenid or mediaLink", async () => {
  const rows = seedRows();
  rows.MatchCollection = rows.MatchCollection.map((m) => ({ ...m, captainOpenid: "openid-x", confirmerOpenid: "openid-y" }));
  const list = await loadFunction(rows, { action: "getTeamList" });
  const matches = await loadFunction(rows, { action: "getTeamMatches", teamId: "team-a" });
  const all = [...matches.data.upcoming, ...matches.data.archived];
  for (const dto of all) {
    assert.ok(!("captainOpenid" in dto) && !("confirmerOpenid" in dto) && !("mediaLink" in dto));
    assert.ok(!JSON.stringify(dto).includes("openid-"));
  }
  for (const team of list.data.teams) assert.deepEqual(Object.keys(team).sort(), ["sport", "teamId", "teamName"]);
});

test("invalid teamId and unknown actions fail closed with 400", async () => {
  const rows = seedRows();
  assert.equal((await loadFunction(rows, { action: "getTeamMatches" })).code, 400);
  assert.equal((await loadFunction(rows, { action: "getTeamMatches", teamId: "   " })).code, 400);
  assert.equal((await loadFunction(rows, { action: "nope" })).code, 400);
  assert.equal((await loadFunction(rows, {})).code, 400);
});

test("duplicate archive records surface as a 500 instead of picking one arbitrarily", async () => {
  const rows = seedRows();
  rows.ArchiveCollection.push({ _id: "arch-dup", matchId: "m-arch-new", score: "9:9", result: "胜" });
  // main 顶层 catch 将内部数据异常转为 500，不向调用方泄漏错误细节。
  const result = await loadFunction(rows, { action: "getTeamMatches", teamId: "team-a" });
  assert.equal(result.code, 500);
  assert.equal(result.message, "服务器开小差了");
});

test("team listing degrades to an empty roster when TeamCollection is unreadable", async () => {
  const rows = seedRows();
  const result = await loadFunction(rows, { action: "getTeamList" });
  assert.equal(result.code, 0);
  assert.ok(Array.isArray(result.data.teams));
  // 集合不存在/不可读（undefined）时按空名册降级，不抛 500。
  rows.TeamCollection = undefined;
  const degraded = await loadFunction(rows, { action: "getTeamList" });
  assert.equal(degraded.code, 0);
  assert.equal(degraded.data.teams.length, 0);
});

test("pagination reads beyond the first 100 matches", async () => {
  const rows = seedRows();
  const now = Date.now();
  rows.MatchCollection = Array.from({ length: 150 }, (_, i) => ({
    _id: `bulk-${String(i).padStart(3, "0")}`, teamId: "team-a", teamName: "测试A-排球", sport: "排球",
    rival: `对手${i}`, matchTime: now + i * 6e4, endTime: now + i * 6e4 + 36e5, location: "场地",
    demands: [], isTbd: false, cellStatus: "pending", isArchived: false, createdAt: now, updatedAt: now,
  }));
  const result = await loadFunction(rows, { action: "getTeamMatches", teamId: "team-a" });
  assert.equal(result.code, 0);
  assert.equal(result.data.upcoming.length, 150);
  assert.equal(result.data.upcoming[0]._id, "bulk-000");
  assert.equal(result.data.upcoming[149]._id, "bulk-149");
});
