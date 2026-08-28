// app.js
// 全局入口：云环境初始化 + 免密静默登录（用例1）
const { ROLE } = require("./utils/status");
const envConfig = require("./config/env");

const envVersion = envConfig.getEnvVersion();
const cloudEnvId = envConfig.getCloudEnvId(envVersion);

App({
  globalData: {
    env: cloudEnvId,
    envVersion,
    cloudState: "unconfigured",
    userInfo: null, // { role, nickname, teamId }，游客为 { role: 'guest' }
  },

  onLaunch: function () {
    if (!wx.cloud) {
      this.globalData.cloudState = "unsupported";
      this.globalData.userInfo = { role: ROLE.GUEST };
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
      return;
    }

    if (!this.globalData.env) {
      this.globalData.cloudState = "unconfigured";
      this.globalData.userInfo = { role: ROLE.GUEST };
      console.warn(`[cloud] ${this.globalData.envVersion} 版本尚未配置云环境`);
      return;
    }

    wx.cloud.init({
      env: this.globalData.env,
      traceUser: true,
    });
    this.globalData.cloudState = "ready";
    this.silentLogin();
  },

  // 免密自动登录：openid 静默校验，结果缓存到 globalData
  silentLogin() {
    if (this.globalData.userInfo) {
      return Promise.resolve(this.globalData.userInfo);
    }

    if (this.globalData.cloudState !== "ready") {
      this.globalData.userInfo = { role: ROLE.GUEST };
      return Promise.resolve(this.globalData.userInfo);
    }

    if (this._loginPromise) return this._loginPromise;

    this._loginPromise = wx.cloud
      .callFunction({ name: "AuthManager", data: { action: "autoLogin" } })
      .then((res) => {
        const r = res.result || {};
        if (r.code === 0) {
          this.globalData.userInfo = r.data;
        } else {
          this.globalData.userInfo = { role: ROLE.GUEST };
        }
        return this.globalData.userInfo;
      })
      .catch((err) => {
        console.error("[silentLogin]", err);
        this.globalData.userInfo = { role: ROLE.GUEST };
        return this.globalData.userInfo;
      })
      .then((user) => {
        this._loginPromise = null;
        return user;
      });

    return this._loginPromise;
  },
});
