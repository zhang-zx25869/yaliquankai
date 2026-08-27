// pages/respond/index.js
// B6 跟场响应页（用例6 ViewHistoryStats / 7 RespondSchedule / 8 GenerateHelpCard / 10 CancelMyDuty）
// ── 阶段2 任务一：数据层（含 mock）。交互逻辑在任务三补全 ──
const { call, getUser, waitForUser } = require("../../utils/call");
const { CELL_STATUS, STATUS_META, ROLE, HOURS } = require("../../utils/status");
const { MOCK_MATCHES } = require("../../utils/mock");

// mock 开关：开发期 true，阶段4 云函数就绪后改为 false 即接真实数据
const USE_MOCK = true;

Page({
  data: {
    role: ROLE.GUEST,
    roleMember: ROLE.MEMBER,
    cellStatusPending: CELL_STATUS.PENDING,
    cellStatusHelp: CELL_STATUS.HELP,
    match: null,           // 公共对象（格式化后的 match，含 timeText/demandsText/statusMeta）
    myStatus: "none",      // none | confirmed | declined
    stats: [],             // [{ nickname, count }] 本队跟场统计
    remainingCount: 0,     // 本队未表态人数（含操作者）
    canHelp: false,        // 红态下我是否为本队经理人 → 决定求助按钮显隐
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
  },

  // 每次页面显示刷新身份（静默登录可能比 onLoad 晚，照 profile 页模式兜底）
  onShow() {
    this.refreshUser();
    if (this.matchId) this.fetchData(this.matchId);
  },

  // 身份：从全局缓存拿 role（处理启动时静默登录未完成的竞态）
  refreshUser() {
    const settle = () => {
      const u = getUser();
      this.setData({ role: u.role });
    };
    waitForUser().then(settle);
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
        canHelp: raw.cellStatus === CELL_STATUS.HELP, // 求助场默认模拟本队经理人
      });
      this.syncShareAvailability(raw.cellStatus);
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
      this.syncShareAvailability(data.match && data.match.cellStatus);
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
      timeText: raw.timeText || "",
      demandsText: raw.demandsText || "",
      confirmerName: raw.confirmerNickname || "",
      statusMeta: meta, // { color, label, desc } 供 WXML 渲染色条/文案
    };
  },

  // 统一状态更新：改 cellStatus 并同步刷新顶部色条（statusMeta），保证两者永远一致
  updateCellStatus(status) {
    const meta = STATUS_META[status] || {};
    this.setData({
      "match.cellStatus": status,
      "match.statusMeta": meta,
    });
    this.syncShareAvailability(status);
    return meta;
  },

  // 黄/绿分享赛程卡片，红分享求助卡片；已完结状态隐藏分享入口。
  syncShareAvailability(status) {
    const shareable = [CELL_STATUS.PENDING, CELL_STATUS.CONFIRMED, CELL_STATUS.HELP].includes(status);
    if (shareable) {
      wx.showShareMenu({ menus: ["shareAppMessage"] });
    } else {
      wx.hideShareMenu({ menus: ["shareAppMessage"] });
    }
  },




  // —— 用例7：确认跟场 ——
  async onConfirm() {
    const m = this.data.match;
    if (!m) return;
    if (![CELL_STATUS.PENDING, CELL_STATUS.HELP, CELL_STATUS.CONFIRMED].includes(m.cellStatus)) {
      wx.showToast({ title: "当前状态无法确认跟场", icon: "none" });
      return;
    }

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
      this.updateCellStatus(CELL_STATUS.CONFIRMED);
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
    if (m.cellStatus !== CELL_STATUS.PENDING) {
      wx.showToast({ title: "仅待确认状态可以选择没空", icon: "none" });
      return;
    }

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
      this.updateCellStatus(CELL_STATUS.HELP);
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

    const within48h = m.matchTime - Date.now() < HOURS.FORCE_RED * 3600 * 1000;

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
      // mock：取消等同本人没空；临期拉红，否则回黄。
      const nextStatus = within48h ? CELL_STATUS.HELP : CELL_STATUS.PENDING;
      this.updateCellStatus(nextStatus);
      this.setData({
        "match.confirmerName": "",
        myStatus: "declined",
        canHelp: nextStatus === CELL_STATUS.HELP,
      });
      wx.showToast({
        title: nextStatus === CELL_STATUS.HELP ? "已取消，看板已拉红" : "已取消，名额已释放",
        icon: nextStatus === CELL_STATUS.HELP ? "none" : "success",
      });
      return;
    }
    try {
      await call("DutyManager", { action: "cancelMyDuty", matchId: this.matchId});
      this.fetchData(this.matchId);
    } catch (e) { /* call 已统一 toast */ }
  },

  // 分享随状态变化：红态求助卡片，黄/绿态赛程卡片，完结状态不展示分享入口。
  onShareAppMessage() {
    const m = this.data.match;
    const isHelp = m && m.cellStatus === CELL_STATUS.HELP;
    return {
      title: m
        ? isHelp
          ? `【跟场求助】${m.teamName} vs ${m.rival} ${m.timeText}，希望有空的同学补位！`
          : `【跟场确认】${m.teamName} vs ${m.rival} ${m.timeText}`
        : "雅力全开 · 赛事跟场",
      path: m
        ? isHelp
          ? `/pages/rescue/index?matchId=${m._id}`
          : `/pages/respond/index?matchId=${m._id}`
        : "/pages/index/index",
    };
  },
});
