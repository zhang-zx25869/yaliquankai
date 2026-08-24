// app.js
// 全局入口：云环境初始化 + 免密静默登录（用例1）
const { ROLE } = require("./utils/status");

App({
  globalData: {
    env: "yaliquankai-d2g2kt52247d144a8",
    userInfo: null, // { role, nickname, teamId }，游客为 { role: 'guest' }
  },

  onLaunch: function () {
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
      return;
    }
    wx.cloud.init({
      env: this.globalData.env,
      traceUser: true,
    });
    this.silentLogin();
  },

  // 免密自动登录：openid 静默校验，结果缓存到 globalData
  silentLogin() {
    return wx.cloud
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
      });
  },
});
