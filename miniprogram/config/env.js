// 小程序运行版本到微信云开发环境的映射。
// 定稿：develop / trial / release 三版本统一使用同一个云开发环境（单环境架构）。
// 若将来需要拆分环境，分别填入各环境 ID 并恢复 tests/env.test.js 的独立环境断言。
const ENV_IDS = Object.freeze({
  develop: "yaliquankai-d2g2kt52247d144a8",
  trial: "yaliquankai-d2g2kt52247d144a8",
  release: "yaliquankai-d2g2kt52247d144a8",
});

const SUPPORTED_VERSIONS = Object.freeze(["develop", "trial", "release"]);

const getEnvVersion = () => {
  try {
    const accountInfo = wx.getAccountInfoSync();
    const version = accountInfo.miniProgram && accountInfo.miniProgram.envVersion;
    return SUPPORTED_VERSIONS.includes(version) ? version : "develop";
  } catch (_e) {
    return "develop";
  }
};

const getCloudEnvId = (version = getEnvVersion()) => ENV_IDS[version] || "";

module.exports = Object.freeze({ ENV_IDS, getEnvVersion, getCloudEnvId });
