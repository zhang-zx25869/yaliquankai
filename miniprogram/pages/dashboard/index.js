// miniprogram/pages/dashboard/index.js
// B4 四色看板页（用例13/14/15）—— C同学看板线
// 行 = 体育代表队，列 = 按时间排列的场次（TBD 挂最后一列）；
// 点橙格直达归档页，其他单元格展开 match-detail-card；
// 运营者可强制取消跟场 / 手动修改跟场状态。

const { call, getUser, waitForUser } = require("../../utils/call");
const { CELL_STATUS, STATUS_META, ROLE, HOURS } = require("../../utils/status");

// 状态/角色常量注入 data，WXML 中禁止裸字符串（接口约定第九节）
const LEGEND = [
  CELL_STATUS.PENDING, CELL_STATUS.CONFIRMED,
  CELL_STATUS.HELP, CELL_STATUS.SETTLE, CELL_STATUS.TBD,
].map((key) => ({ key, ...STATUS_META[key] }));

Page({
  data: {
    role: ROLE.GUEST,
    roleAdmin: ROLE.ADMIN,
    cellStatusPending: CELL_STATUS.PENDING,
    cellStatusConfirmed: CELL_STATUS.CONFIRMED,
    cellStatusCancelled: CELL_STATUS.CANCELLED,

    legend: LEGEND,
    loading: true,
    needBind: false,
    canManage: false,

    // 二维看板：列（横轴时间）× 行（纵轴队伍）；boardStyle 动态拼 grid 列宽
    columns: [],
    rows: [],
    boardStyle: "",

    // 展开详情（页面自己维护，组件只冒泡不保存）
    expandedId: "",
    expandedMatch: null,

    // 手动修改跟场状态面板（用例15）
    resetPanel: {
      show: false,
      matchId: "",
      rival: "",
      target: CELL_STATUS.PENDING,
      nickname: "",
    },
  },

  onShow() {
    this.refreshUser();
  },

  // 身份竞态兜底：登录未完成时等待，完成后按角色决定是否拉看板
  refreshUser() {
    const applyUser = () => {
      const u = getUser();
      this.setData({ role: u.role });
      if (u.role === ROLE.GUEST) {
        this.setData({ needBind: true, loading: false });
      } else {
        this.setData({ needBind: false });
        this.loadDashboard();
      }
    };
    waitForUser().then(applyUser);
  },

  onGoBind() {
    wx.switchTab({ url: "/pages/profile/index" });
  },

  noop() {},

  async loadDashboard() {
    this.setData({ loading: true });
    try {
      const data = await call("DashboardManager", { action: "getDashboard" });
      this.applyBoard(data);
    } catch (e) {
      // 401 = 会话过期退回游客：显示绑定引导；其余错误 call 已统一 toast
      if (e && e.code === 401) this.setData({ needBind: true });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 云端行主序（teams）→ 前端矩阵（列按 matchTime 全局对齐）
  applyBoard(data) {
    const columns = this.buildColumns(data.teams || []);
    const rows = this.buildRows(data.teams || [], columns);
    this.setData({
      canManage: !!data.canManage,
      columns,
      rows,
      boardStyle: `display: grid; grid-template-columns: 150rpx repeat(${columns.length}, 180rpx); gap: 8rpx;`,
    });
  },

  // 横轴列 = 全部非 TBD 场次的 matchTime 去重升序；列头用云端 timeText；
  // TBD（无时间）单独一列固定在最后，列头写死「时间待定」（云端 TBD 的 timeText 为空串）
  buildColumns(teams) {
    const seen = new Map(); // matchTime → timeText
    teams.forEach((t) => {
      (t.matches || []).forEach((m) => {
        if (m.matchTime && !seen.has(m.matchTime)) {
          seen.set(m.matchTime, m.timeText || this.formatTime(m.matchTime));
        }
      });
    });
    const columns = Array.from(seen.keys())
      .sort((a, b) => a - b)
      .map((ts) => ({ key: `t${ts}`, label: seen.get(ts), isTbd: false }));
    columns.push({ key: "tbd", label: "时间待定", isTbd: true });
    return columns;
  },

  // 逐行铺格：同队同列撞场时保留首条、extra 计数；
  // 同时建立 _matchById 索引（展开卡片 / 跳归档用）
  buildRows(teams, columns) {
    this._matchById = {};
    const cellMap = new Map(); // "teamId__colKey" → [formattedMatch]
    teams.forEach((team) => {
      (team.matches || []).forEach((m) => {
        const formatted = this.formatMatch(m);
        const colKey = m.isTbd || !m.matchTime ? "tbd" : `t${m.matchTime}`;
        const k = `${team.teamId}__${colKey}`;
        if (!cellMap.has(k)) cellMap.set(k, []);
        cellMap.get(k).push(formatted);
        this._matchById[formatted._id] = formatted;
      });
    });
    return teams.map((team) => ({
      teamId: team.teamId,
      teamName: team.teamName,
      cells: columns.map((col) => {
        const list = cellMap.get(`${team.teamId}__${col.key}`) || [];
        return { key: col.key, match: list[0] || null, extra: Math.max(0, list.length - 1) };
      }),
    }));
  },

  // MatchDTO → 展示对象：组件读 confirmerName（云端字段是 confirmerNickname，必须映射）
  // 状态色/文案统一取 STATUS_META，禁止在 WXML 里硬编码
  formatMatch(raw) {
    return {
      ...raw,
      confirmerName: raw.confirmerNickname || "",
      statusMeta: STATUS_META[raw.cellStatus] || {},
    };
  },

  formatTime(ts) {
    const d = new Date(ts);
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  // 点单元格：橙色 → 直达归档页（路由约定）；其他 → 展开/收起详情卡片
  onCellTap(e) {
    const id = e.currentTarget.dataset.id;
    const m = this._matchById && this._matchById[id];
    if (!m) return;
    if (m.cellStatus === CELL_STATUS.SETTLE) {
      wx.navigateTo({ url: `/pages/archive/index?matchId=${id}` });
      return;
    }
    if (this.data.expandedId === id) {
      this.collapseCard();
      return;
    }
    this.setData({ expandedId: id, expandedMatch: m });
  },

  collapseCard() {
    this.setData({ expandedId: "", expandedMatch: null });
  },

  // 卡片头部点击 = 收起（展开态由页面控制）
  onToggle() {
    this.collapseCard();
  },

  // ── 运营者：强制取消跟场（用例14）──
  onForceCancel(e) {
    this.doForceCancel(e.detail.id);
  },

  onForceCancelById(e) {
    this.doForceCancel(e.currentTarget.dataset.id);
  },

  async doForceCancel(matchId) {
    if (!matchId) return;
    const { confirm } = await wx.showModal({
      title: "强制取消跟场",
      content: "确定终止本场的跟场与求助吗？单元格将置灰，不再触发报警。",
      confirmText: "确定取消",
      cancelText: "再想想",
    });
    if (!confirm) return;
    try {
      await call("DashboardManager", { action: "forceCancelDuty", matchId });
      wx.showToast({ title: "已取消本场跟场", icon: "success" });
      if (this.data.expandedId === matchId) this.collapseCard();
      this.loadDashboard(); // 写完重拉，不手写状态迁移
    } catch (_e) {
      /* call 已统一 toast */
    }
  },

  // ── 运营者：手动修改跟场状态（用例15）──
  onManualReset(e) {
    this.openResetPanel(e.detail.id);
  },

  onManualResetById(e) {
    this.openResetPanel(e.currentTarget.dataset.id);
  },

  openResetPanel(matchId) {
    const m = this._matchById && this._matchById[matchId];
    if (!m) return;
    this.setData({
      resetPanel: {
        show: true,
        matchId,
        rival: `${m.teamName} vs ${m.rival}`,
        target: CELL_STATUS.PENDING,
        nickname: "",
      },
    });
  },

  onResetTargetChange(e) {
    this.setData({ "resetPanel.target": e.detail.value });
  },

  onNicknameInput(e) {
    this.setData({ "resetPanel.nickname": e.detail.value });
  },

  onResetCancel() {
    this.setData({ "resetPanel.show": false });
  },

  async onResetSubmit() {
    const p = this.data.resetPanel;
    if (!p.matchId) return;
    if (p.target === CELL_STATUS.CONFIRMED && !p.nickname.trim()) {
      wx.showToast({ title: "请填写指派部员昵称", icon: "none" });
      return;
    }

    // 临期提示：重置为黄会被巡检/读时兜底立即拉红（状态机的正确行为，提前说明避免误解）
    if (p.target === CELL_STATUS.PENDING) {
      const m = this._matchById[p.matchId];
      if (m && m.matchTime && m.matchTime - Date.now() < HOURS.FORCE_RED * 3600 * 1000) {
        const { confirm } = await wx.showModal({
          title: "临期提示",
          content: "距开赛不足48小时，重置为黄色后会被自动拉红，确定继续吗？",
          confirmText: "继续重置",
          cancelText: "再想想",
        });
        if (!confirm) return;
      }
    }

    const payload = { action: "manualResetStatus", matchId: p.matchId, target: p.target };
    if (p.target === CELL_STATUS.CONFIRMED) {
      payload.assignNickname = p.nickname.trim(); // 前端拿不到 openid，云端按昵称解析
    }

    try {
      await call("DashboardManager", payload);
      this.setData({ "resetPanel.show": false });
      wx.showToast({ title: "已更新跟场状态", icon: "success" });
      this.collapseCard();
      this.loadDashboard();
    } catch (_e) {
      /* call 已统一 toast */
    }
  },
});
