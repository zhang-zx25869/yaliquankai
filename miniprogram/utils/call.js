// utils/call.js
// 统一的云函数调用封装：所有页面一律通过 call('函数名', { action, data }) 调用云端
// 好处：统一 loading 提示、统一错误处理、以后换环境只改一处
const { ROLE } = require("./status");

const cloudUnavailable = (toast) => {
  const app = getApp();
  const state = app.globalData.cloudState;
  const message = state === "unsupported"
    ? "当前微信基础库不支持云能力"
    : "当前运行版本尚未配置云环境";
  if (toast) wx.showToast({ title: message, icon: "none" });
  return Promise.reject({ code: 503, message, cloudState: state });
};

const call = (name, data = {}, { loading = true, toast = true } = {}) => {
  const app = getApp();
  if (!wx.cloud || app.globalData.cloudState !== "ready") {
    return cloudUnavailable(toast);
  }

  return new Promise((resolve, reject) => {
    if (loading) wx.showLoading({ title: "加载中", mask: true });
    wx.cloud
      .callFunction({ name, data })
      .then((res) => {
        if (loading) wx.hideLoading();
        const r = res.result || {};
        if (r.code === 0) {
          resolve(r.data); // 成功：直接返回 data 字段
        } else {
          // 业务失败：云端返回 { code, message }
          if (toast) wx.showToast({ title: r.message || "操作失败", icon: "none" });
          reject(r);
        }
      })
      .catch((err) => {
        if (loading) wx.hideLoading();
        console.error(`[callFunction:${name}]`, err);
        if (toast) wx.showToast({ title: "网络异常，请重试", icon: "none" });
        reject(err);
      });
  });
};

// 获取身份缓存；登录尚未完成时返回 guest，需等待时使用 waitForUser()。
const getUser = () => {
  const app = getApp();
  return app.globalData.userInfo || { role: ROLE.GUEST };
};

const waitForUser = () => {
  const app = getApp();
  return app.silentLogin
    ? app.silentLogin()
    : Promise.resolve(getUser());
};

const setUser = (user) => {
  const app = getApp();
  app.globalData.userInfo = user || { role: ROLE.GUEST };
  return app.globalData.userInfo;
};

module.exports = { call, getUser, waitForUser, setUser };
