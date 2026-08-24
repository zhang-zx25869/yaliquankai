// pages/profile/index.js
// B5 我的页（用例1 OpenIDLogin 展示 / 用例2 BindIdentity）
const { call } = require("../../utils/call");
const { ROLE, ROLE_META } = require("../../utils/status");

Page({
  data: {
    userInfo: { role: ROLE.GUEST },
    roleLabel: "游客",
    roleDesc: "仅可浏览公开信息",
    codeInput: "",   // 激活码输入框
    binding: false,
  },

  onShow() {
    this.refreshUser();
  },

  // 从全局缓存刷新身份显示
  refreshUser() {
    const app = getApp();
    const settle = () => {
      const u = app.globalData.userInfo || { role: ROLE.GUEST };
      const meta = ROLE_META[u.role] || ROLE_META[ROLE.GUEST];
      this.setData({ userInfo: u, roleLabel: meta.label, roleDesc: meta.desc });
    };
    // 若启动时静默登录还没返回，等它完成
    if (app.silentLogin && !app.globalData.userInfo) {
      app.silentLogin().then(settle);
    } else {
      settle();
    }
  },

  onCodeInput(e) {
    this.setData({ codeInput: e.detail.value });
  },

  // 用例2：一次性激活码绑定
  async onBind() {
    const code = this.data.codeInput.trim();
    if (!code) {
      wx.showToast({ title: "请输入激活码", icon: "none" });
      return;
    }
    this.setData({ binding: true });
    try {
      const user = await call("AuthManager", { action: "bindIdentity", code });
      getApp().globalData.userInfo = user; // 更新全局身份缓存
      this.setData({ codeInput: "" });
      const meta = ROLE_META[user.role] || {};
      wx.showModal({
        title: "绑定成功",
        content: `当前身份：${meta.label || user.role}`,
        showCancel: false,
      });
      this.refreshUser();
    } catch (e) {
      // 错误提示已由 call 统一 toast
    } finally {
      this.setData({ binding: false });
    }
  },
});
