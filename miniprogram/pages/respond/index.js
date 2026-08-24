// pages/respond/index.js
// B6 跟场响应页（用例6 ViewHistoryStats / 7 RespondSchedule / 8 GenerateHelpCard / 10 CancelMyDuty）
// ── 阶段2 任务一：数据层（含 mock）。交互逻辑在任务三补全 ──
const { call, getUser } = require("../../utils/call");
const { STATUS_META, ROLE } = require("../../utils/status");
const { MOCK_MATCHES } = require("../../utils/mock");

// mock 开关：开发期 true，阶段4 云函数就绪后改为 false 即接真实数据
const USE_MOCK = true;

Page({
  data: {
    role: ROLE.GUEST,
    match: null,           // 公共对象（格式化后的 match，含 timeText/demandsText/statusMeta）
    myStatus: "none",      // none | confirmed | declined
    stats: [],             // [{ nickname, count }] 本队跟场统计
    remainingCount: 0,     // 本队未表态人数（含操作者）
    canHelp: false,        // 我是否为拉红责任人 → 决定求助按钮显隐
    loading: true,
  },

  // 从分享卡片/跳转进入：options.matchId 即要响应的比赛
  onLoad(options) {
    const matchId = options.matchId;
    if (!matchId) {
      this.setData({ loading: false });
      wx.showToast({ title: "缺少比赛参数", icon: "none" });
      return;
    }
    this.matchId = matchId;
    this.fetchData(matchId);
  },

  // 每次页面显示刷新身份（静默登录可能比 onLoad 晚，照 profile 页模式兜底）
  onShow() {
    this.refreshUser();
  },

  // 身份：从全局缓存拿 role（处理启动时静默登录未完成的竞态）
  refreshUser() {
    const app = getApp();
    const settle = () => {
      const u = getUser() || { role: ROLE.GUEST };
      this.setData({ role: u.role });
    };
    if (app.silentLogin && !app.globalData.userInfo) {
      app.silentLogin().then(settle);
    } else {
      settle();
    }
  },

  // 统一数据入口：mock / 真实云端只在这一处切换
  async fetchData(matchId) {
    this.setData({ loading: true });
    if (USE_MOCK) {
      // —— mock 分支：挑一套演示数据，模拟 getRespondPage 的返回结构 ——
      const raw = MOCK_MATCHES[matchId] || MOCK_MATCHES["测试B-常规"];
      this.setData({
        match: this.formatMatch(raw),
        myStatus: "none",
        stats: [
          { nickname: "经理人甲", count: 4 },
          { nickname: "经理人乙", count: 2 },
        ],
        remainingCount: raw.remainingCount || 1,
        canHelp: raw.cellStatus === "help", // 求助场默认我是责任人，方便测求助按钮
      });
      this.setData({ loading: false });
      return;
    }
    // —— 真实分支：契约 getRespondPage（阶段4 接通后启用）——
    try {
      const data = await call("DutyManager", { action: "getRespondPage", matchId });
      this.setData({
        match: this.formatMatch(data.match),
        myStatus: data.myStatus || "none",
        stats: data.stats || [],
        remainingCount: data.remainingCount || 0,
        canHelp: !!data.canHelp,
      });
    } catch (e) {
      // 错误提示 call 已统一 toast
    } finally {
      this.setData({ loading: false });
    }
  },

  // 原始比赛对象 → 页面展示对象（WXML 不能调 JS 函数，必须先在这里格式化好）
  formatMatch(raw) {
    if (!raw) return null;
    const meta = STATUS_META[raw.cellStatus] || {};
    return {
      ...raw,
      timeText: this.formatTime(raw.matchTime),
      demandsText: (raw.demands || []).join("、"),
      confirmerName: raw.confirmerNickname || "",
      statusMeta: meta, // { color, label, desc } 供 WXML 渲染色条/文案
    };
  },

  // 时间戳 → 中文时间串（如 "8月26日 15:00"）
  formatTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  // 统一状态更新：改 cellStatus 并同步刷新顶部色条（statusMeta），保证两者永远一致
  updateCellStatus(status) {
    const meta = STATUS_META[status] || {};
    this.setData({
      "match.cellStatus": status,
      "match.statusMeta": meta,
    });
    return meta;
  },




  // —— 用例7：确认跟场 ——
  async onConfirm() {
    const m = this.data.match;
    if (!m) return;

    // 二次确认
    const { confirm } = await wx.showModal({
      title: "确认跟场",
      content: `确认参与 ${m.teamName} vs ${m.rival} 的跟场吗？`,
      confirmText: "确认",
      cancelText: "再想想",
    });
    if (!confirm) return;

    if (USE_MOCK) {
      // mock：直接置绿（顶部色条由 updateCellStatus 同步刷新）
      this.updateCellStatus("confirmed");
      this.setData({
        "match.confirmerName": (getUser() || {}).nickname || "我",
        myStatus: "confirmed",
      });
      wx.showToast({ title: "已确认，看板已变绿", icon: "success" });
      return;
    }
    try {
      await call("DutyManager", { action: "confirmDuty", matchId: this.matchId });
      this.fetchData(this.matchId); // 重新拉取刷新
    } catch (e) { /* call 已统一 toast */ }
  },

  // —— 用例7：没空（mock 演示分流：还有人未表态保持黄；否则拉红解锁求助）——
  async onDecline() {
    const m = this.data.match;
    if (!m) return;

    const { confirm } = await wx.showModal({
      title: "暂时没空",
      content: `确定本场跟场没空吗？`,
      confirmText: "没空",
      cancelText: "再想想",
    });
    if (!confirm) return;

    if (USE_MOCK) {
      // 模拟多人分流：remainingCount > 0 表示还有人未表态 → 保持黄
      const remaining = this.data.remainingCount;
      if (this.data.remainingCount > 1) {
        const left = remaining - 1;
        this.setData({ myStatus: "declined", remainingCount: left });
        wx.showToast({
          title: `已记录没空，本队还有 ${left} 人未表态`,
          icon: "none",
        });
        return;
      }
      // remaining <= 1: 我是最后一人 → 拉红 + 解锁求助按钮
      this.updateCellStatus("help");
      this.setData({
        myStatus: "declined",
        canHelp: true,
      });
      wx.showToast({ title: "全员没空，看板已拉红", icon: "none" });
      return;
    }
    try {
      const data = await call("DutyManager", { action: "declineDuty", matchId: this.matchId });
      this.fetchData(this.matchId);
    } catch (e) { /* call 已统一 toast */ }
  },

  // —— 用例10：取消我的跟场（<48h 弹安全锁强提醒）——
  async onCancelDuty() {
    const m = this.data.match;
    if (!m) return;

    const within48h = m.matchTime - Date.now() < 48 * 3600 * 1000;

    // 二次确认（临期时文案升级为强提醒）
    const first = await wx.showModal({
      title: "取消我的跟场",
      content: within48h
        ? "距比赛开始不足48小时，取消后请务必确认有其他部员救场，并私聊部长报备！"
        : "确定取消本次跟场吗？名额将释放给其他部员。",
      confirmText: "仍要取消",
      cancelText: "再想想",
    });
    if (!first.confirm) return;

    if (USE_MOCK) {
      // mock：回退黄色待确认，释放名额
      this.updateCellStatus("pending");
      this.setData({
        "match.confirmerName": "",
        myStatus: "none",
      });
      wx.showToast({ title: "已取消，名额已释放", icon: "success" });
      return;
    }
    try {
      await call("DutyManager", { action: "cancelMyDuty", matchId: this.matchId});
      this.fetchData(this.matchId);
    } catch (e) { /* call 已统一 toast */ }
  },

  // —— 用例8：分享求助卡片（open-type=share 自动触发，返回标题与直达路径）——
  onShareAppMessage() {
    const m = this.data.match;
    return {
      title: m
        ? `【跟场求助】${m.teamName} vs ${m.rival} ${m.timeText}，希望有空的同学补位！`
        : "雅力全开 · 跟场求助",
      path: m ? `/pages/rescue/index?matchId=${m._id}` : "/pages/index/index",
    };
  },
});
