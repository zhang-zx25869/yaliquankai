// pages/rescue/index.js
// B7 救场接单页（用例9 GroupRescue）
// 部员点击大群里的【求助卡片】直达本页 → 看比赛信息 + 求助原因 → 点「我来救场」接单 → 单元格红变绿
// 只能通过求助卡片/看板进入；游客无权限（role 校验）；仅 help 状态可救场
const { call, getUser } = require("../../utils/call");
const { STATUS_META, ROLE } = require("../../utils/status");
const { MOCK_MATCHES } = require("../../utils/mock"); // mock 数据统一抽到 utils/mock.js 共用

// mock 开关：开发期 true，阶段4 云函数就绪后改为 false 即接真实数据
const USE_MOCK = true;

Page({
  data: {
    role: ROLE.GUEST,
    match: null,           // 公共对象（格式化后的 match，含 timeText/demandsText/statusMeta）
    myStatus: "none",      // none | confirmed（救场成功后置 confirmed，用于渲染成功态）
    helpReason: "",        // 求助原因（mock/云端返回，展示在红色警示条）
    loading: true,
  },
  // 从求助卡片进入：options.matchId 即要救场的比赛
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

  async fetchData(matchId) {
    this.setData({ loading: true });
    if (USE_MOCK) {
      // —— mock 分支：默认用求助场（help 态），模拟 getRescuePage 的返回结构 ——
      const raw = MOCK_MATCHES[matchId] || MOCK_MATCHES["测试B-求助"];
      this.setData({
        match: this.formatMatch(raw),
        myStatus: "none",
        helpReason: raw.helpReason || "",
      });
      this.setData({ loading: false });
      return;
    }
    // —— 真实分支：契约 getRescuePage，返回 { match, helpReason }（阶段4 接通后启用）——
    try {
      const data = await call("DutyManager", { action: "getRescuePage", matchId });
      this.setData({
        match: this.formatMatch(data.match),
        myStatus: data.myStatus || "none",
        helpReason: data.helpReason || "",
      });
    } catch (e) {
      // 错误提示 call 已统一 toast
    } finally {
      this.setData({ loading: false });
    }
  },

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



  // —— 用例9：救场接单（仅 help 态可接；红 → 绿，跟场人更新为救场者）——
  async onRescue() {
    const m = this.data.match;
    if (!m) return;

    // 仅红色求助中的比赛可救场
    if (m.cellStatus !== "help") {
      wx.showToast({ title: "该场不在求助状态，无法救场", icon: "none" });
      return;
    }

    // 二次确认
    const { confirm } = await wx.showModal({
      title: "确认救场",
      content: `确定接手 ${m.teamName} vs ${m.rival} 的救场吗？`,
      confirmText: "我来救场",
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
      wx.showToast({ title: "救场成功，体育部不会忘记你做的一切！", icon: "success" });
      return;
    }
    try {
      await call("DutyManager", { action: "rescueDuty", matchId: this.matchId });
      this.fetchData(this.matchId); // 重新拉取刷新
    } catch (e) { /* call 已统一 toast */ }
  },


});
