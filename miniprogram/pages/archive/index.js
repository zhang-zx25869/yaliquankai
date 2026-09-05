// miniprogram/pages/archive/index.js
// B8 赛后归档页（用例11/12）—— C同学看板线
// 从看板橙色单元格进入（路由约定携带 matchId）：
// 比分 / 胜负结果必填 + 云盘链接选填 → ArchiveManager.submitArchive 销号归档

const { call, getUser, waitForUser } = require("../../utils/call");
const { CELL_STATUS, STATUS_META, ROLE } = require("../../utils/status");

Page({
  data: {
    role: ROLE.GUEST,
    roleAdmin: ROLE.ADMIN,
    cellStatusSettle: CELL_STATUS.SETTLE,

    loading: true,
    needBind: false, // 401：游客 → 绑定引导
    noPerm: false,   // 403：非本队成员经分享路径直达
    match: null,

    score: "",
    result: "",
    mediaLink: "",
    submitting: false,
    canSubmitHint: true, // UI 提示位：非跟场人仅提示，最终以云端 openid 校验为准
  },

  onLoad(options) {
    const matchId = options.matchId;
    if (!matchId) {
      this.setData({ loading: false });
      wx.showToast({ title: "缺少比赛参数", icon: "none" });
      return;
    }
    this.matchId = matchId;
    this._skipNextShow = true; // 首帧 onShow 跳过，避免与 onLoad 双请求
    this.fetchHeader(matchId);
  },

  onShow() {
    this.refreshUser();
    if (this._skipNextShow) {
      this._skipNextShow = false;
      return;
    }
    if (this.matchId) this.fetchHeader(this.matchId);
  },

  // 身份竞态兜底：登录未完成时等待，游客显示绑定引导
  refreshUser() {
    const applyUser = () => {
      const u = getUser();
      this.setData({ role: u.role });
      if (u.role === ROLE.GUEST) this.setData({ needBind: true, loading: false });
    };
    waitForUser().then(applyUser);
  },

  onGoBind() {
    wx.switchTab({ url: "/pages/profile/index" });
  },

  // 比赛信息头复用 DutyManager.getRespondPage（settle 是终态，读时重算不会改动它），
  // 不新增 action（接口约定：新增 action 须先在第八节登记）
  async fetchHeader(matchId) {
    this.setData({ loading: true });
    try {
      const data = await call("DutyManager", { action: "getRespondPage", matchId });
      const u = getUser();
      const m = this.formatMatch(data.match);
      this.setData({
        match: m,
        noPerm: false,
        // 跟场人本人或运营者可提交（按昵称预判，云端以 openid 实名校验）
        canSubmitHint: u.role === ROLE.ADMIN
          || (!!m.confirmerName && m.confirmerName === u.nickname),
      });
    } catch (e) {
      if (e && e.code === 401) this.setData({ needBind: true });
      else if (e && e.code === 403) this.setData({ noPerm: true });
      /* 其余错误 call 已统一 toast */
    } finally {
      this.setData({ loading: false });
    }
  },

  // MatchDTO → 展示对象（组件/信息区读 confirmerName，云端字段是 confirmerNickname）
  formatMatch(raw) {
    if (!raw) return null;
    const meta = STATUS_META[raw.cellStatus] || {};
    return {
      ...raw,
      confirmerName: raw.confirmerNickname || "",
      statusMeta: meta,
      demandsText: raw.demandsText || (raw.demands || []).join("、"),
    };
  },

  onScoreInput(e) {
    this.setData({ score: e.detail.value });
  },

  onResultInput(e) {
    this.setData({ result: e.detail.value });
  },

  onLinkInput(e) {
    this.setData({ mediaLink: e.detail.value });
  },

  // 提交归档（用例11/12）：本地先拦必填（文案与云端一致）；
  // 云端 400/403/409 由 call 统一 toast，页面停留供修改重试
  async onSubmit() {
    if (this.data.submitting) return;
    const score = this.data.score.trim();
    const result = this.data.result.trim();
    const mediaLink = this.data.mediaLink.trim();
    if (!score || !result) {
      wx.showToast({ title: "必填项未填写，无法提交", icon: "none" });
      return;
    }

    this.setData({ submitting: true });
    try {
      const res = await call("ArchiveManager", {
        action: "submitArchive",
        matchId: this.matchId,
        score,
        result,
        mediaLink,
      });
      console.log("[archive] 归档成功 archiveId:", res.archiveId);
      wx.showModal({
        title: "提交成功",
        content: "比赛已归档，看板单元格已销号",
        showCancel: false,
        success: () => {
          // 返回看板（tab 页 onShow 自动重拉），橙色格子随之消失；
          // 分享路径直达时无页可回，退回看板 tab
          wx.navigateBack({
            fail: () => wx.switchTab({ url: "/pages/dashboard/index" }),
          });
        },
      });
    } catch (_e) {
      /* call 已统一 toast */
    } finally {
      this.setData({ submitting: false });
    }
  },
});
