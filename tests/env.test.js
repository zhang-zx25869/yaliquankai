const assert = require("node:assert/strict");
const test = require("node:test");

const envModulePath = require.resolve("../miniprogram/config/env");

const loadEnvConfig = (envVersion) => {
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
  };
  delete require.cache[envModulePath];
  return require(envModulePath);
};

test.afterEach(() => {
  delete global.wx;
  delete require.cache[envModulePath];
});

test("develop uses the configured cloud environment", () => {
  const config = loadEnvConfig("develop");
  assert.equal(config.getEnvVersion(), "develop");
  assert.equal(config.getCloudEnvId(), "yaliquankai-d2g2kt52247d144a8");
});

test("all runtime versions share the single cloud environment", () => {
  // 定稿：三版本统一使用同一个云开发环境（单环境架构）
  const trial = loadEnvConfig("trial");
  assert.equal(trial.getCloudEnvId(), "yaliquankai-d2g2kt52247d144a8");

  const release = loadEnvConfig("release");
  assert.equal(release.getCloudEnvId(), "yaliquankai-d2g2kt52247d144a8");
});

test("unknown runtime versions are treated as develop", () => {
  const config = loadEnvConfig("unknown");
  assert.equal(config.getEnvVersion(), "develop");
  assert.equal(config.getCloudEnvId(), "yaliquankai-d2g2kt52247d144a8");
});
