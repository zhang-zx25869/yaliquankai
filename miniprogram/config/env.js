// 小程序运行版本到微信云开发环境的唯一映射。
// 体验版和正式版发布前必须填写独立环境，禁止静默回退到开发环境。
const ENV_IDS = Object.freeze({
  develop: "yaliquankai-d2g2kt52247d144a8",
  trial: "",
  release: "",
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
