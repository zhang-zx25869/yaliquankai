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

test("trial and release fail closed instead of falling back to develop", () => {
  const trial = loadEnvConfig("trial");
  assert.equal(trial.getCloudEnvId(), "");

  const release = loadEnvConfig("release");
  assert.equal(release.getCloudEnvId(), "");
});

test("unknown runtime versions are treated as develop", () => {
  const config = loadEnvConfig("unknown");
  assert.equal(config.getEnvVersion(), "develop");
  assert.equal(config.getCloudEnvId(), "yaliquankai-d2g2kt52247d144a8");
});
