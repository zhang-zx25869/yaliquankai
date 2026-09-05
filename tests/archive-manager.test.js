const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const archiveModulePath = path.resolve(
  __dirname,
  "../cloudfunctions/ArchiveManager/index.js",
);
const statusPath = path.resolve(__dirname, "../miniprogram/utils/status.js");

function loadArchiveManager() {
  const originalLoad = Module._load;
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database: () => ({ command: {} }), // 纯函数测试不触库，仅满足顶层初始化
    getWXContext: () => ({ OPENID: "openid-a" }),
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "wx-server-sdk") return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[archiveModulePath];
  try {
    return require(archiveModulePath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[archiveModulePath];
  }
}

test("ArchiveManager constants are frozen and match the frontend status contract", () => {
  const { CELL_STATUS, ROLE } = loadArchiveManager().__test__;
  const status = require(statusPath);

  assert.equal(Object.isFrozen(CELL_STATUS), true);
  assert.equal(Object.isFrozen(ROLE), true);
  assert.deepEqual(CELL_STATUS, status.CELL_STATUS);
  assert.deepEqual(ROLE, status.ROLE);
});

test("normalizeArchiveInput trims strings and coerces non-strings to empty", () => {
  const { normalizeArchiveInput } = loadArchiveManager().__test__;

  const normal = normalizeArchiveInput({
    score: " 3:1 ",
    result: " 胜 ",
    mediaLink: " https://cloud.tsinghua.edu.cn/d/xxx ",
  });
  assert.equal(normal.score, "3:1");
  assert.equal(normal.result, "胜");
  assert.equal("https://cloud.tsinghua.edu.cn/d/xxx", normal.mediaLink);
  assert.equal(normal.missing, false);

  // 非字符串（数字/null/undefined）→ 空串；必填缺失即 missing
  const coerced = normalizeArchiveInput({ score: 42, result: null, mediaLink: undefined });
  assert.equal(coerced.score, "");
  assert.equal(coerced.result, "");
  assert.equal(coerced.mediaLink, "");
  assert.equal(coerced.missing, true);
});

test("normalizeArchiveInput flags each missing required field", () => {
  const { normalizeArchiveInput } = loadArchiveManager().__test__;

  assert.equal(normalizeArchiveInput({ score: "", result: "胜" }).missing, true);
  assert.equal(normalizeArchiveInput({ score: "3:1", result: "  " }).missing, true);
  assert.equal(normalizeArchiveInput({ score: "3:1", result: "胜" }).missing, false);
  assert.equal(normalizeArchiveInput({ score: "3:1", result: "胜", mediaLink: "" }).missing, false);
});
