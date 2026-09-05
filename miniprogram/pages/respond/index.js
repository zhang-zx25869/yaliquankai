// pages/respond/index.js
// B6 跟场响应页（用例6 ViewHistoryStats / 7 RespondSchedule / 8 GenerateHelpCard / 10 CancelMyDuty）
// ── 阶段2 任务一：数据层（含 mock）。交互逻辑在任务三补全 ──
const { call, getUser, waitForUser } = require("../../utils/call");
const { CELL_STATUS, STATUS_META, ROLE, HOURS } = require("../../utils/status");
const { mockRecalc } = require("../../utils/recalc");
const { MOCK_MATCHES } = require("../../utils/mock");

// mock 开关：false = 走真实云函数（DutyManager 已实装部署）；联调排障可临时翻回 true 对照 mock
const USE_MOCK = false;

Page({
  data: {
    role: ROLE.GUEST,
    roleMember: ROLE.MEMBER,
    roleAdmin: ROLE.ADMIN, // admin 与 member 同权（云端 requireMember 放行 admin）
    cellStatusPending: CELL_STATUS.PENDING,
    cellStatusConfirmed: CELL_STATUS.CONFIRMED,
    cellStatusHelp: CELL_STATUS.HELP,
    cellStatusSettle: CELL_STATUS.SETTLE,
    myStatusNone: "none",        // DutyManager 返回的 myStatus 枚举（WXML 常量注入，防裸串）
    myStatusConfirmed: "confirmed",
    myStatusDeclined: "declined",
    match: null,           // 公共对象（格式化后的 match，含 timeText/demandsText/statusMeta）
    myStatus: "none",      // none | confirmed | declined
    stats: [],             // [{ nickname, count }] 本队跟场统计
    remainingCount: 0,     // 本队未表态人数（含操作者）
    canHelp: false,        // 红态 && 本队经理人 → 决定求助按钮显隐
    redTip: "",            // 红态提示条文案（JS 按场景赋值，WXML 只显示）
    needBind: false,       // 401 游客：显示「请先绑定身份」引导块（云端拒发比赛数据）
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


  // 统一数据入口：mock / 真实云端只在这一处切换
  async fetchData(matchId) {
    this.setData({ loading: true });
    if (USE_MOCK) {
      // —— mock 分支：挑一套演示数据，模拟 getRespondPage 的返回结构 ——
      const raw = MOCK_MATCHES[matchId] || MOCK_MATCHES["测试B-常规"];
      // 读时重算（接口约定定稿）：返回前先按重算规则刷新状态，
      // 兜住"48h 已到但 TimerChecker 还没巡检到"的窗口——进入页面必见正确颜色
      const recalced = mockRecalc(raw);
      raw.cellStatus = recalced;
      // 我的表态恢复（重进页面不丢）：mock 源标记
      const myStatus = raw.confirmerNickname ? "confirmed" : (raw._myDeclined ? "declined" : "none");
      // canHelp 统一定义（接口约定定稿）：红态 && 本队经理人（本页已是经理人视角）
      const canHelp = raw.cellStatus === CELL_STATUS.HELP;
      // 红态提示条文案（JS 生成，WXML 只显示 redTip）：随拉红原因区分
      const redTip = this.buildRedTip(raw);
      this.setData({
        match: this.formatMatch(raw),
        myStatus,
        stats: [
          { nickname: "经理人甲", count: 4 },
          { nickname: "经理人乙", count: 2 },
        ],
        // 未表态人数 = 总数 - 已decline人数（与云端 recalc 同源）
        remainingCount: Math.max(0, (raw._teamSize || 1) - (raw._declinedCount || 0)),
        canHelp,
        redTip,
      });
      this.setData({ loading: false });
      // 拉红文案分对象（定稿）：48h 无人表态拉红无触发者，
      // 未表态的经理人进页面 → 温和提示（触发者场景由 decline/cancel 弹窗覆盖）
      if (raw.cellStatus === CELL_STATUS.HELP && myStatus === "none") {
        wx.showModal({
          title: "本场正在求助",
          content: "本队经理人全员没空，等待大群救场。若有空请直接点击「确认跟场」；确实没空请点击「生成求助卡片」转发到体育部大群。",
          confirmText: "知道了",
          showCancel: false,
        });
      }
      this.prefetchHelpCard(raw); // 红态预取云端求助卡片（用例8）
      return;
    }
    // —— 真实分支：契约 getRespondPage（阶段4 接通后启用）——
    try {
      const data = await call("DutyManager", { action: "getRespondPage", matchId });
      const m = data.match || {};
      const myStatus = data.myStatus || "none";
      this.setData({
        match: this.formatMatch(m),
        myStatus,
        stats: data.stats || [],
        remainingCount: data.remainingCount || 0,
        canHelp: !!data.canHelp,
        redTip: this.buildRedTip(m),
      });
      // 拉红文案分对象（定稿，与 mock 分支一致）：48h 无人表态拉红无触发者，
      // 未表态的经理人进页面 → 温和提示（触发者场景由 decline/cancel 弹窗覆盖）
      if (m.cellStatus === CELL_STATUS.HELP && myStatus === "none") {
        wx.showModal({
          title: "本场正在求助",
          content: "本队经理人全员没空，等待大群救场。若有空请直接点击「确认跟场」；确实没空请点击「生成求助卡片」转发到体育部大群。",
          confirmText: "知道了",
          showCancel: false,
        });
      }
      this.prefetchHelpCard(m); // 红态预取云端求助卡片（用例8）
    } catch (e) {
      // 401 = 游客：云端按契约拒发数据，展示绑定引导块；其余错误 call 已统一 toast
      this.setData({ needBind: e && e.code === 401 });
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
      timeText: raw.timeText || this.formatTime(raw.matchTime),
      demandsText: raw.demandsText || (raw.demands || []).join("、"),
      confirmerName: raw.confirmerNickname || "",
      statusMeta: meta, // { color, label, desc } 供 WXML 渲染色条/文案
      started: raw.matchTime <= Date.now(), // 已开赛：隐藏确认/取消按钮（云端 409 双保险）
    };
  },

  // 时间戳 → 中文时间串（如 "8月26日 15:00"）
  formatTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  // 红态预取云端求助卡片（用例8 GenerateHelpCard）：
  // 云端生成 { title, path } 缓存到 this._helpCard，onShareAppMessage 红态分支同步返回，
  // 遵循「禁止在分享回调里临时 await 云函数」约定；未缓存/失败则回退本地拼装。
  async prefetchHelpCard(match) {
    this._helpCard = null;
    if (!match || match.cellStatus !== CELL_STATUS.HELP) return;
    try {
      const data = await call("DutyManager", { action: "generateHelpCard", matchId: match._id });
      this._helpCard = (data && data.title && data.path) ? data : null;
    } catch (_e) {
      this._helpCard = null;
    }
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

  // 红态提示条文案（JS 生成，WXML 只显示 redTip）：红态统一提示全员没空
  buildRedTip(raw) {
    if (raw.cellStatus !== CELL_STATUS.HELP) return "";
    return "本队经理人全员没空，若有空可直接确认补位";
  },




  // —— 用例7：确认跟场 ——
  async onConfirm() {
    const m = this.data.match;
    if (!m) return;

    // 已开赛本地早退（云端 409 双保险，防长驻页面按钮残影误点）
    if (m.started) {
      wx.showToast({ title: "比赛已开始，无法确认跟场", icon: "none" });
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
      const raw = MOCK_MATCHES[this.matchId] || MOCK_MATCHES["测试B-常规"];
      const me = (getUser() || {}).nickname || "我";
      // 绿态且跟场人不是我 → 已有人跟场，拒绝（先到先得）
      if (raw.cellStatus === CELL_STATUS.CONFIRMED && raw.confirmerNickname && raw.confirmerNickname !== me) {
        this.setData({ loading: false });
        wx.showToast({ title: "本场已有人跟场", icon: "none" });
        return;
      }
      // mock 落库：记 confirmer；若我此前 decline 过则撤销（幂等：仅 declined 时减计数）
      raw.confirmerNickname = me;
      const wasDeclined = raw._myDeclined || false;
      if (wasDeclined) {
        raw._declinedCount = Math.max(0, (raw._declinedCount || 0) - 1);
        raw._myDeclined = false;
      }
      const status = mockRecalc(raw);
      raw.cellStatus = status;
      const cameFromHelp = this.data.match && this.data.match.cellStatus === CELL_STATUS.HELP;
      this.updateCellStatus(status);
      this.setData({
        "match.confirmerName": me,
        myStatus: "confirmed",
        redTip: "",
      });
      wx.showToast({
        title: cameFromHelp ? "已确认补位，感谢救场！" : "已确认跟场",
        icon: "success",
      });
      return;
    }
    try {
      await call("DutyManager", { action: "confirmDuty", matchId: this.matchId });
      this.fetchData(this.matchId); // 重新拉取刷新
    } catch (_e) { /* call 已统一 toast */ }
  },

  // —— 用例7：没空 ——
  // 说明：黄态表态必然发生在 48h 线之前（临期无人确认已被拉红），
  // 所以这里不需要临期安全锁；decline 后是否拉红由重算结果告知。
  async onDecline() {
    const m = this.data.match;
    if (!m) return;

    // 已开赛本地早退（云端 409 双保险）
    if (m.started) {
      wx.showToast({ title: "比赛已开始，无法表态", icon: "none" });
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
      const raw = MOCK_MATCHES[this.matchId] || MOCK_MATCHES["测试B-常规"];
      // mock 落库：decline 计数 +1（幂等：仅首次表态没空才计数），走重算器
      if (!raw._myDeclined) {
        raw._declinedCount = (raw._declinedCount || 0) + 1;
        raw._myDeclined = true;
      }
      const status = mockRecalc(raw);
      raw.cellStatus = status;
      const total = raw._teamSize || 1;
      const remaining = Math.max(0, total - (raw._declinedCount || 0));
      const helpUnlocked = status === CELL_STATUS.HELP;
      this.updateCellStatus(status);
      this.setData({
        myStatus: "declined",
        remainingCount: remaining,
        canHelp: helpUnlocked,
        redTip: this.buildRedTip(raw), // ① 修复：decline 后红态提示条同步刷新
      });
      if (helpUnlocked) {
        wx.showModal({
          title: "本队经理人都没空",
          content: "请点击【生成求助卡片】转发到体育部大群，并私聊部长报备。",
          confirmText: "知道了",
          showCancel: false,
        });
      } else {
        wx.showToast({
          title: `已记录没空，本队还有 ${remaining} 人未表态`,
          icon: "none",
        });
      }
      return;
    }
    try {
      const data = await call("DutyManager", { action: "declineDuty", matchId: this.matchId });
      this.fetchData(this.matchId); // 云端已重算，重新拉取即正确状态（求助区随红态出现）
      // 拉红强引导（与 mock 分支一致）：我是最后表态没空者 = 第一责任人，必须转发求助卡片
      if (data && data.cellStatus === CELL_STATUS.HELP) {
        wx.showModal({
          title: "本队经理人全员没空",
          content: "请点击【生成求助卡片】转发到体育部大群，并私聊部长报备。",
          confirmText: "知道了",
          showCancel: false,
        });
      } else if (data) {
        // 未拉红：云端已返回未表态人数（remainingCount），如实相告
        wx.showToast({
          title: `已记录没空，本队还有 ${data.remainingCount} 人未表态`,
          icon: "none",
        });
      }
    } catch (_e) { /* call 已统一 toast */ }
  },

  // mock：取消确认 ≡ 本人最新表态变为「没空」（接口约定·取消语义）
  // 撤 confirmer + decline 计数 +1（置本人 declined 标记），再走重算器得出颜色
  _mockCancel(raw) {
    raw.confirmerNickname = "";
    raw._declinedCount = (raw._declinedCount || 0) + 1;
    raw._myDeclined = true;
    const status = mockRecalc(raw);
    raw.cellStatus = status;
    return status;
  },

  // —— 用例10：取消我的跟场 ——
  // 颜色不写死：云端按「取消≡没空」语义走重算（见接口约定 recalcCellStatus）。
  // 安全锁只对"临期撤确认"有意义（绿态存在时间可长可短，可能已跨过48h线）：
  // 临期取消 → 无人确认且<48h → 重算必为红，必须提前讲清后果。
  async onCancelDuty() {
    const m = this.data.match;
    if (!m) return;

    // 已开赛本地早退（云端 409 双保险）
    if (m.started) {
      wx.showToast({ title: "比赛已开始，无法取消", icon: "none" });
      return;
    }

    const within48h = m.matchTime - Date.now() < HOURS.FORCE_RED * 3600 * 1000;

    const { confirm } = await wx.showModal({
      title: within48h ? "距开赛不足48小时！" : "取消我的跟场",
      content: within48h
        ? "取消后本场将需要他人补位，需要马上把求助卡片转发到体育部大群，并私聊部长报备。确定取消吗？"
        : "确定取消本次跟场吗？名额将释放给其他部员。",
      confirmText: "仍要取消",
      cancelText: "再想想",
    });
    if (!confirm) return;

    if (USE_MOCK) {
      const raw = MOCK_MATCHES[this.matchId] || MOCK_MATCHES["测试B-常规"];
      const status = this._mockCancel(raw);
      const helpUnlocked = status === CELL_STATUS.HELP;
      this.updateCellStatus(status);
      this.setData({
        "match.confirmerName": "",
        myStatus: "none",
        canHelp: helpUnlocked,
        redTip: this.buildRedTip(raw), // ② 修复：取消后红态提示条同步刷新
      });
      if (helpUnlocked) {
        wx.showModal({
          title: "本场需要补位",
          content: "请点击【生成求助卡片】转发到体育部大群，并私聊部长报备。",
          confirmText: "知道了",
          showCancel: false,
        });
      } else {
        wx.showToast({ title: "已取消，名额已释放", icon: "success" });
      }
      return;
    }   
    try {
      const data = await call("DutyManager", { action: "cancelMyDuty", matchId: this.matchId });
      this.fetchData(this.matchId); // 云端已重算，重新拉取即正确状态（求助区随红态出现）
      // 取消得红强引导：本页已就是响应页，不跳转，弹窗指引用户立即转发求助卡片
      if (data && data.canHelp) {
        wx.showModal({
          title: "本场需要补位",
          content: "请点击本页【生成求助卡片并转发】把求助卡发到体育部大群，并私聊部长报备。",
          confirmText: "知道了",
          showCancel: false,
        });
      }
    } catch (_e) { /* call 已统一 toast */ }
  },

  // —— 用例4/8：分享随状态（接口约定第七节定稿）——
  // 红态 → 求助卡片（rescue 路径）；黄/绿态 → 赛程卡片（respond 路径）；
  // 已完结（settle 及之后）不提供分享。
  onShareAppMessage() {
    const m = this.data.match;
    if (!m) {
      return { title: "雅力全开 · 赛事跟场", path: "/pages/index/index" };
    }
    if (m.cellStatus === CELL_STATUS.HELP) {
      // 红态求助卡片：仅用云端 generateHelpCard 预取的缓存（本地拼装已删除）；
      // 缓存未就绪/云端失败时落到下方首页兜底，不发送错误卡片。
      if (this._helpCard) {
        return this._helpCard;
      }
      return { title: "雅力全开 · 赛事跟场", path: "/pages/index/index" };
    }
    if (m.cellStatus === CELL_STATUS.PENDING || m.cellStatus === CELL_STATUS.CONFIRMED) {
      return {
        title: `【跟场确认】${m.teamName} vs ${m.rival} ${m.timeText}`,
        path: `/pages/respond/index?matchId=${m._id}`,
      };
    }
    // settle / 归档等已完结：兜底指向首页（前端无法彻底禁掉右上角菜单，给个合理落点）
    return { title: "雅力全开 · 赛事跟场", path: "/pages/index/index" };
  },
});
