// pages/profile/index.js
// B5 我的页（用例1 OpenIDLogin 展示 / 用例2 BindIdentity）
const { call, getUser, waitForUser, setUser } = require("../../utils/call");
const { ROLE, ROLE_META, HOURS, CELL_STATUS } = require("../../utils/status");

Page({
  data: {
    userInfo: { role: ROLE.GUEST },
    roleGuest: ROLE.GUEST,   // WXML 常量注入（禁止裸字符串，接口约定第九节）
    roleMember: ROLE.MEMBER,
    roleAdmin: ROLE.ADMIN,
    roleLabel: "游客",
    roleDesc: "仅可浏览公开信息",
    codeInput: "",   // 激活码输入框
    binding: false,
    myDuties: [],    // 我的跟场列表（member/admin 可见）
    loadingDuties: false,
  },

  onShow() {
    this.refreshUser();
  },

  // 从全局缓存刷新身份显示
  refreshUser() {
    const settle = () => {
      const u = getUser();
      const meta = ROLE_META[u.role] || ROLE_META[ROLE.GUEST];
      this.setData({ userInfo: u, roleLabel: meta.label, roleDesc: meta.desc });
      if(u.role === ROLE.MEMBER || u.role === ROLE.ADMIN) {
        this.loadMyDuties();
      } else {
        this.setData({ myDuties: [] });
      }
    };
    waitForUser().then(settle);
  },

  // —— B5b 我的跟场（用例10a）：当前我跟场的、未完结未归档比赛 ——
  async loadMyDuties() {
    this.setData({ loadingDuties: true });
    try {
      const res = await call("DutyManager", { action:"getMyDuties" });
      this.setData({ myDuties: (res.list || []).map((raw) => this.formatMatch(raw)) });
    } catch (e) {
      // 错误提示已由 call 统一 toast；列表保持原样，下次 onShow 重试
    } finally {
      this.setData({ loadingDuties: false });
    }
  },

  // 原始 DTO → 组件展示对象（与 respond 页同款映射，组件零改动）
  // 取消按钮条件：仅绿态且未开赛（settle 待结算、已开赛的跟场均不可取消，云端 409 双保险）
  formatMatch(raw) {
    return {
      ...raw,
      confirmerName: raw.confirmerNickname || "",
      myConfirmed: raw.cellStatus === CELL_STATUS.CONFIRMED && raw.matchTime > Date.now(),
    };
  },

  // 取消我的跟场（用例10，事件来自 match-detail-card 的 cancelduty）
  async onCancelDuty(e) {
    const id = e.detail.id;
    const m = this.data.myDuties.find((x) => x._id ===id);
    if(!m) return;

    // 已开赛/settle 本地早退（云端 409 双保险，防列表数据滞后误点）；
    // myConfirmed 在 formatMatch 已含"绿态且未开赛"条件，这里只拦数据滞后的兜底
    if (m.matchTime <= Date.now()) {
      wx.showToast({ title: "比赛已开始，无法取消", icon: "none" });
      return;
    }

    // 48h 安全锁：临期取消大概率导致无人救场，强提醒
    const within48h = m.matchTime - Date.now() < HOURS.FORCE_RED * 3600 * 1000;
    const content = within48h
    ? "距开赛不足 48 小时，取消后需要大群救场，确定取消吗？"  
    : "确定取消本场跟场吗？名额将释放给其他经理人。";

    const { confirm } = await wx.showModal({
      title: "取消跟场",
      content,
      confirmText: "仍要取消",
      confirmColor: "#7a1733",
    });
    if (!confirm) return;

    try {
      const res = await call("DutyManager", { action: "cancelMyDuty", matchId: id });
      await this.loadMyDuties(); // 重拉列表（该场已不属于我，自动消失）
      // 取消得红：强引导跳该场响应页——红态求助区（用例8）可直接生成求助卡片转发
      if (res.canHelp) {
        const nav = await wx.showModal({
          title: "本场需要补位",
          content: "取消后本场已进入求助状态，请立即转发求助卡片到体育部大群，并私聊部长报备。",
          confirmText: "去转发",
          cancelText: "稍后处理",
          confirmColor: "#7a1733",
        });
        if (nav.confirm) {
          wx.navigateTo({ url: `/pages/respond/index?matchId=${id}` });
        } else {
          wx.showToast({ title: "已取消跟场", icon: "none" });
        }
      } else {
        // 回黄场景：名额已释放，正常提示
        wx.showToast({ title: "已取消跟场", icon: "success" });
      }
    } catch (e) {
      // 404 无确认记录 / 409 终态等，toast 已由 call 统一处理
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
      setUser(user);
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
