// pages/rescue/index.js
// B7 救场接单页（用例9 GroupRescue）
// 部员点击大群里的【求助卡片】直达本页 → 看比赛信息 + 求助横幅（固定文案） → 点「我来救场」接单 → 单元格红变绿
// 只能通过求助卡片/看板进入；游客无权限（role 校验）；仅 help 状态可救场
const { call, getUser, waitForUser } = require("../../utils/call");
const { CELL_STATUS, STATUS_META, ROLE, HOURS } = require("../../utils/status");
const { mockRecalc } = require("../../utils/recalc");
const { MOCK_MATCHES } = require("../../utils/mock"); // mock 数据统一抽到 utils/mock.js 共用

// mock 开关：false = 走真实云函数（DutyManager 已实装部署）；联调排障可临时翻回 true 对照 mock
const USE_MOCK = false;

Page({
  data: {
    role: ROLE.GUEST,
    roleMember: ROLE.MEMBER,
    roleAdmin: ROLE.ADMIN, // admin 与 member 同权（云端 requireMember 放行 admin）
    cellStatusHelp: CELL_STATUS.HELP,
    cellStatusConfirmed: CELL_STATUS.CONFIRMED,
    match: null,           // 公共对象（格式化后的 match，含 timeText/demandsText/statusMeta）
    myStatus: "none",      // none | confirmed（救场成功后置 confirmed，用于渲染成功态）
    bannerTitle: "",       // 顶部横幅标题（JS 按 cellStatus 赋值：求助/已有人跟场）
    bannerReason: "",      // 顶部横幅描述（同上）
    needBind: false,       // 401 游客：显示「请先绑定身份」引导块（云端拒发比赛数据）
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
    this._skipNextShow = true; // 首帧 onShow 跳过，避免与 onLoad 双请求
    this.fetchData(matchId);
  },

  // 每次页面显示：刷新身份 + 重新拉取数据（从其他页面回来状态不过期，A2）
  onShow() {
    this.refreshUser();
    if (this._skipNextShow) {
      this._skipNextShow = false; // 仅首帧跳过一次
      return;
    }
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

  // 401 游客引导：跳「我的」页绑定身份（Tab 页用 switchTab）
  onGoBind() {
    wx.switchTab({ url: "/pages/profile/index" });
  },

  async fetchData(matchId) {
    this.setData({ loading: true });
    if (USE_MOCK) {
      // —— mock 分支：默认用求助场（help 态），模拟 getRescuePage 的返回结构 ——
      const raw = MOCK_MATCHES[matchId] || MOCK_MATCHES["测试B-求助"];
      // 读时重算（接口约定定稿）：返回前先按重算规则刷新状态
      const recalced = mockRecalc(raw);
      raw.cellStatus = recalced;
      const myStatus = this._mockMyStatus(raw) || "none";
      const banner = this.buildBanner(raw);
      this.setData({
        match: this.formatMatch(raw),
        myStatus,
        bannerTitle: banner.title,
        bannerReason: banner.reason,
      });
      this.setData({ loading: false });
      return;
    }
    // —— 真实分支：契约 getRescuePage，返回 { match, myStatus } ——
    try {
      const data = await call("DutyManager", { action: "getRescuePage", matchId });
      const banner = this.buildBanner(data.match || {});
      this.setData({
        match: this.formatMatch(data.match),
        myStatus: data.myStatus || "none",
        bannerTitle: banner.title,
        bannerReason: banner.reason,
      });
    } catch (e) {
      // 401 = 游客：云端按契约拒发数据，展示绑定引导块；其余错误 call 已统一 toast
      this.setData({ needBind: e && e.code === 401 });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 顶部横幅文案：JS 按 cellStatus 生成（WXML 只显示 bannerTitle/bannerReason）
  // 红态 → 红色求助；已被响应页抢先确认（绿）→ 友好「已有人跟场」
  buildBanner(raw) {
    if (raw.cellStatus === CELL_STATUS.HELP) {
      return {
        title: "⚠️ 本场跟场急需支援",
        reason: "本队经理人全员没空，等待大群救场",
      };
    }
    if (raw.cellStatus === CELL_STATUS.CONFIRMED) {
      return {
        title: "✅ 本场已有人跟场",
        reason: `${raw.confirmerNickname || "已有部员"} 已确认，感谢关注！`,
      };
    }
    return { title: "", reason: "" };
  },

  // mock：模拟"我是该场跟场人"的持久化判断
  // 规则同真实云端：cellStatus=confirmed 且 confirmerOpenid 是我 → myStatus=confirmed
  _mockMyStatus(raw) {
    if (raw.cellStatus !== CELL_STATUS.CONFIRMED) return "none";
    const me = getUser() || {};
    return raw.confirmerNickname === (me.nickname || "我") ? "confirmed" : "none";
  },

  formatMatch(raw) {
    if (!raw) return null;
    const meta = STATUS_META[raw.cellStatus] || {};
    return {
      ...raw,
      timeText: raw.timeText || this.formatTime(raw.matchTime),
      demandsText: raw.demandsText || (raw.demands || []).join("、"),
      confirmerName: raw.confirmerNickname || "",
      statusMeta: meta, // { color, label, desc } 供 WXML 渲染色条/文案
      started: raw.matchTime <= Date.now(), // 已开赛：禁救场/禁取消（云端 409 双保险）
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
    if (m.cellStatus !== CELL_STATUS.HELP) {
      wx.showToast({ title: "该场不在求助状态，无法救场", icon: "none" });
      return;
    }

    // 已开赛本地早退（云端 409 双保险，防长驻页面按钮残影误点）
    if (m.started) {
      wx.showToast({ title: "比赛已开始，无法救场", icon: "none" });
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
      // mock 落库：记 confirmer（rescue 确认），重算 → 必绿
      const myName = (getUser() || {}).nickname || "我";
      const raw = MOCK_MATCHES[this.matchId] || MOCK_MATCHES["测试B-求助"];
      raw.confirmerNickname = myName;
      const status = mockRecalc(raw);
      raw.cellStatus = status;
      this.updateCellStatus(status);
      this.setData({
        "match.confirmerName": myName,
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

  // mock 重算器：与 respond 页和云端 recalcCellStatus 同规则（共用 utils/recalc.js 的 mockRecalc）

  // —— 用例10（救场版）：取消我的救场 ——
  // 取消语义与跟场一致：≡ 本人最新表态变为「没空」→ 撤确认 + decline +1 → 统一重算。
  // 救场场景下其余经理人早已全员 decline，重算必然得红（规则自然推出，非写死）。
  // 临期（<48h）时额外加安全锁强提醒。
  async onCancelRescue() {
    const m = this.data.match;
    if (!m || this.data.myStatus !== "confirmed") return;

    // 已开赛本地早退（云端 409 双保险，settle 前的救场取消瞎点兜底）
    if (m.started) {
      wx.showToast({ title: "比赛已开始，无法取消", icon: "none" });
      return;
    }

    const within48h = m.matchTime - Date.now() < HOURS.FORCE_RED * 3600 * 1000;
    const { confirm } = await wx.showModal({
      title: within48h ? "距开赛不足48小时！" : "取消救场",
      content: within48h
        ? "取消后比赛将需要他人补位，请马上把本页转发到体育部大群找人接替，并私聊部长报备。确定取消吗？"
        : "确定取消救场吗？需要重新转发求助卡片到体育部大群找人接替。",
      confirmText: "仍要取消",
      cancelText: "再想想",
    });
    if (!confirm) return;

    if (USE_MOCK) {
      const raw = MOCK_MATCHES[this.matchId] || MOCK_MATCHES["测试B-求助"];
      // 取消 ≡ 没空：撤确认、decline+1、重算（此场景重算必为 help）
      raw.confirmerNickname = "";
      raw._declinedCount = (raw._declinedCount || 0) + 1;
      const status = mockRecalc(raw);
      raw.cellStatus = status;
      const banner = this.buildBanner(raw);
      this.updateCellStatus(status);
      this.setData({
        "match.confirmerName": "",
        myStatus: "none",
        bannerTitle: banner.title,   // ⑥ 修复：取消后横幅切回红色求助
        bannerReason: banner.reason,
      });
      wx.showModal({
        title: "已回到求助状态",
        content: "请点击右上角「···」把本页转发到体育部大群找人接替，并私聊部长报备。",
        confirmText: "知道了",
        showCancel: false,
      });
      return;
    }
    try {
      await call("DutyManager", { action: "cancelMyDuty", matchId: this.matchId });
      await this.fetchData(this.matchId); // 先刷新（横幅切回红态），再弹指引
      wx.showModal({
        title: "本场已回到求助状态",
        content: "点击右上角「···」把本页转发到体育部大群找人接替，并私聊部长报备。",
        confirmText: "知道了",
        showCancel: false,
      });
    } catch (e) { /* call 已统一 toast */ }
  },

  // —— 分享随状态（接口约定第七节）：红态 → 求助卡片（承接救场者取消后的重新转发）；其余兜底 ——
  onShareAppMessage() {
    const m = this.data.match;
    if (m && m.cellStatus === CELL_STATUS.HELP) {
      return {
        title: `【跟场求助】${m.teamName} vs ${m.rival} ${m.timeText}，希望有空的同学补位！`,
        path: `/pages/rescue/index?matchId=${m._id}`,
      };
    }
    return { title: "雅力全开 · 赛事跟场", path: "/pages/index/index" };
},

});