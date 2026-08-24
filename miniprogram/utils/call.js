// utils/call.js
// 统一的云函数调用封装：所有页面一律通过 call('函数名', { action, data }) 调用云端
// 好处：统一 loading 提示、统一错误处理、以后换环境只改一处

const call = (name, data = {}, { loading = true, toast = true } = {}) => {
  return new Promise((resolve, reject) => {
    if (loading) wx.showLoading({ title: "加载中", mask: true });
    wx.cloud
      .callFunction({ name, data })
      .then((res) => {
        wx.hideLoading();
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
        wx.hideLoading();
        console.error(`[callFunction:${name}]`, err);
        if (toast) wx.showToast({ title: "网络异常，请重试", icon: "none" });
        reject(err);
      });
  });
};

// 获取全局身份缓存（app.globalData.userInfo）
// 页面用：const user = getUser(); if (!user) {...}
const getUser = () => {
  const app = getApp();
  return app.globalData.userInfo || null;
};

module.exports = { call, getUser };
