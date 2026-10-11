// B3 代表队栏目（用例19）—— 收尾阶段
// 两级视图：队伍列表（公开，游客可看）→ 选队后展示「未开始赛程 + 历史赛况」两区；
// 点卡片展开调 CalendarManager.getMatchDetail 取最新详情；本队队长显示赛程管理入口。

const { call, getUser, waitForUser } = require("../../utils/call");
const { ROLE } = require("../../utils/status");

Page({
  data: {
    // 队伍列表视图
    teams: [],
    listLoading: true,
    listError: "",
    // 选队视图
    teamId: "",
    teamName: "",
    sport: "",
    upcoming: [],
    archived: [],
    matchLoading: false,
    matchError: "",
    // 详情展开（页面自己维护，组件只冒泡不保存）
    expandedId: "",
    detail: null,
    detailLoading: false,
    detailError: "",
    // 队长本队管理入口（用例19 第5步）
    showManage: false,
  },

  onLoad() {
    this._listSeq = 0;
    this._matchSeq = 0;
    this._detailSeq = 0;
    this._identitySeq = 0;
  },

  onShow() {
    this._active = true;
    this.refreshIdentity();
    if (!this.data.teamId) return this.loadTeams();
    return Promise.all([this.loadTeams(), this.loadMatches(this.data.teamId)]);
  },

  onHide() { this.invalidate(); },
  onUnload() { this.invalidate(); },

  invalidate() {
    this._active = false;
    this._listSeq += 1;
    this._matchSeq += 1;
    this._detailSeq += 1;
    this._identitySeq += 1;
    this.resetDetail();
    wx.stopPullDownRefresh();
  },

  resetDetail() {
    this._detailSeq += 1;
    this.setData({ expandedId: "", detail: null, detailLoading: false, detailError: "" });
  },

  // 身份竞态兜底：公开浏览不等登录；身份就绪后判断是否显示本队管理入口（用例19 第5步）。
  refreshIdentity() {
    const seq = this._identitySeq;
    return waitForUser().then(() => {
      if (!this._active || seq !== this._identitySeq) return;
      const user = getUser();
      const showManage = user.role === ROLE.CAPTAIN
        && Boolean(user.teamId)
        && (!this.data.teamId || user.teamId === this.data.teamId);
      this.setData({ showManage });
    }).catch(() => { /* 保持公开视图 */ });
  },

  // —— 队伍列表（用例19 第1步）——
  async loadTeams() {
    const seq = this._listSeq = (this._listSeq || 0) + 1;
    this.setData({ listLoading: true, listError: "" });
    try {
      const result = await call("TeamManager", { action: "getTeamList" }, { loading: false, toast: false });
      if (!this._active || seq !== this._listSeq) return;
      if (!result || !Array.isArray(result.teams)) throw new Error("队伍数据异常，请重试");
      this.setData({ teams: result.teams });
    } catch (error) {
      if (this._active && seq === this._listSeq) {
        this.setData({ teams: [], listError: error.message || "队伍加载失败，请重试" });
      }
    } finally {
      if (this._active && seq === this._listSeq) {
        this.setData({ listLoading: false });
        wx.stopPullDownRefresh();
      }
    }
  },

  // —— 选队：拉取该队赛程与历史（用例19 第2-5步）——
  onSelectTeam(event) {
    const { id, name, sport } = event.currentTarget.dataset;
    if (!id) return;
    this.resetDetail();
    this.setData({
      teamId: id, teamName: name || "", sport: sport || "",
      upcoming: [], archived: [], matchError: "",
    });
    this.refreshIdentity(); // 切队后重新判断管理入口（仅本队队长显示）
    return this.loadMatches(id);
  },

  onBackToTeams() {
    this.invalidateMatchesView();
    this.setData({ teamId: "", teamName: "", sport: "", upcoming: [], archived: [], matchError: "" });
    this.refreshIdentity();
    return this.loadTeams();
  },

  invalidateMatchesView() {
    this._matchSeq += 1;
    this.resetDetail();
    wx.stopPullDownRefresh();
  },

  async loadMatches(teamId) {
    const seq = this._matchSeq = (this._matchSeq || 0) + 1;
    this.setData({ matchLoading: true, matchError: "" });
    try {
      const result = await call("TeamManager", { action: "getTeamMatches", teamId }, { loading: false, toast: false });
      if (!this._active || seq !== this._matchSeq || teamId !== this.data.teamId) return;
      if (!result || !Array.isArray(result.upcoming) || !Array.isArray(result.archived)) {
        throw new Error("赛程数据异常，请重试");
      }
      this.setData({ upcoming: result.upcoming, archived: result.archived });
    } catch (error) {
      if (this._active && seq === this._matchSeq && teamId === this.data.teamId) {
        this.setData({ upcoming: [], archived: [], matchError: error.message || "赛程加载失败，请重试" });
      }
    } finally {
      if (this._active && seq === this._matchSeq && teamId === this.data.teamId) {
        this.setData({ matchLoading: false });
        wx.stopPullDownRefresh();
      }
    }
  },

  onRetryMatches() { return this.data.teamId && this.loadMatches(this.data.teamId); },

  // —— 详情展开：读最新详情（对齐首页 loadDetail 模式）——
  onToggleMatch(event) {
    const id = event.detail.id;
    const pool = [...this.data.upcoming, ...this.data.archived];
    if (!pool.some((match) => match._id === id)) return;
    if (this.data.expandedId === id) { this.resetDetail(); return; }
    this.resetDetail();
    this.setData({ expandedId: id });
    return this.loadDetail();
  },

  async loadDetail() {
    const matchId = this.data.expandedId;
    if (!matchId) return;
    const seq = this._detailSeq = (this._detailSeq || 0) + 1;
    this.setData({ detail: null, detailLoading: true, detailError: "" });
    try {
      const result = await call("CalendarManager", { action: "getMatchDetail", matchId }, { loading: false, toast: false });
      if (!this._active || seq !== this._detailSeq) return;
      if (!result || !result.match || result.match._id !== matchId) throw new Error("比赛详情异常，请重试");
      this.setData({ detail: result.match });
    } catch (error) {
      if (this._active && seq === this._detailSeq) {
        this.setData({
          detailError: error.code === 404 ? "比赛已不存在，请刷新赛程" : error.message || "详情加载失败，请重试",
        });
      }
    } finally {
      if (this._active && seq === this._detailSeq) this.setData({ detailLoading: false });
    }
  },

  onRetryDetail() { return this.loadDetail(); },

  // —— 队长本队管理入口（用例19 第5步）——
  onManage() {
    const user = getUser();
    if (user.role !== ROLE.CAPTAIN || !user.teamId || user.teamId !== this.data.teamId) return;
    wx.navigateTo({ url: "/pages/schedule-list/index" });
  },

  onPullDownRefresh() {
    if (!this.data.teamId) return this.loadTeams();
    return Promise.all([this.loadTeams(), this.loadMatches(this.data.teamId)]);
  },
});
