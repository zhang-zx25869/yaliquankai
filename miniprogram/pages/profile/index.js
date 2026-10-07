const { call, getUser, waitForUser, setUser } = require("../../utils/call");
const { ROLE, ROLE_META, CELL_STATUS } = require("../../utils/status");
const { formatMatch, activeMatch, identityKey, isMember, confirmModal } = require("../../utils/duty-page");
const { createRequestId } = require("../../utils/schedule-form");

Page({
  data: {
    userInfo: { role: ROLE.GUEST }, roleGuest: ROLE.GUEST, roleMember: ROLE.MEMBER, roleAdmin: ROLE.ADMIN,
    roleLabel: "游客", roleDesc: "仅可浏览公开信息", codeInput: "", binding: false,
    myDuties: [], loadingDuties: false, dutyError: "", expandedId: "",
    busy: false, retryPending: false, actionError: "",
  },
  onLoad() { this._seq = 0; },
  onShow() {
    this._active = true;
    this.setData({ busy: Boolean(this._busy), retryPending: Boolean(this._pending), actionError: this._actionError || "" });
    return this.refreshUser();
  },
  onHide() { this.invalidate(); },
  onUnload() { this.invalidate(); },
  invalidate() { this._active = false; this._seq = (this._seq || 0) + 1; wx.stopPullDownRefresh(); },
  async refreshUser() {
    const seq = this._seq = (this._seq || 0) + 1;
    this.setData({ myDuties: [], expandedId: "", loadingDuties: true, dutyError: "" });
    let identity;
    const current = () => this._active && seq === this._seq && (!identity || identity === identityKey());
    try {
      await waitForUser();
      if (!current()) return;
      identity = identityKey();
      const user = getUser(), meta = ROLE_META[user.role] || ROLE_META[ROLE.GUEST];
      this.setData({ userInfo: user, roleLabel: meta.label, roleDesc: meta.desc });
      if (this._pending && this._pending.identity !== identity) {
        this._pending = null; this._actionError = ""; this.setData({ retryPending: false, actionError: "" });
      }
      if (!isMember()) return;
      const result = await call("DutyManager", { action: "getMyDuties" }, { loading: false, toast: false });
      if (!current()) return;
      if (!result || !Array.isArray(result.list)) throw new Error("跟场列表异常，请重试");
      this.setData({ myDuties: result.list.map(formatMatch) });
    } catch (error) {
      if (current()) this.setData({ dutyError: error.message || "跟场列表加载失败，请重试" });
    } finally {
      if (this._active && seq === this._seq) { this.setData({ loadingDuties: false }); wx.stopPullDownRefresh(); }
    }
  },
  loadMyDuties() { return this.refreshUser(); },
  onPullDownRefresh() { return this.refreshUser(); },
  onToggleDuty(event) {
    const id = event.detail.id;
    if (this.data.myDuties.some((match) => match._id === id)) this.setData({ expandedId: this.data.expandedId === id ? "" : id });
  },
  onRetryAction() { return this._pending ? this.onCancelDuty({ detail: { id: this._pending.payload.matchId } }, true) : undefined; },
  async onCancelDuty(event, retry = false) {
    if (!this._active || this._busy || !isMember() || (this._pending && !retry)) return;
    const identity = identityKey(), seq = this._seq, id = event.detail.id;
    const visible = () => this._active && seq === this._seq && identity === identityKey();
      const sameIdentity = () => this._active && identity === identityKey();
    if (retry && this._pending?.identity !== identity) return;
    const match = this.data.myDuties.find((row) => row._id === id);
    if (!retry && (!activeMatch(match) || match.cellStatus !== CELL_STATUS.CONFIRMED)) return;
    this._busy = true; this._actionError = "";
    this.setData({ busy: true, actionError: "" });
    let result;
    try {
      if (!retry) {
        const { confirm } = await wx.showModal(confirmModal(match, "cancelMyDuty"));
        if (!confirm || !visible() || !activeMatch(match)) return;
        this._pending = { identity, payload: { action: "cancelMyDuty", matchId: id, requestId: createRequestId(), dutyToken: match.dutyToken }, teamId: match.teamId };
      }
      const pending = this._pending;
      result = await call("DutyManager", pending.payload, { loading: false, toast: false });
      if (!result || !Object.values(CELL_STATUS).includes(result.cellStatus)) throw new Error("取消结果暂未确认，请重试");
      this._pending = null;
      if (sameIdentity()) {
        wx.showToast({ title: "已取消跟场", icon: "success" });
        if (result.cellStatus === CELL_STATUS.HELP) {
          // 本队经理人去响应页承接求助；跨队救场者回救场页，不能冒用本队分享权限。
          const page = result.canHelp ? "respond" : "rescue";
          wx.navigateTo({ url: `/pages/${page}/index?matchId=${encodeURIComponent(id)}` });
        }
      }
    } catch (error) {
      if ([400, 401, 403, 404, 409].includes(error.code)) this._pending = null;
      this._actionError = identity === identityKey() ? error.message || "网络异常，请重试同一次取消" : "";
    } finally {
      this._busy = false;
      if (identity !== identityKey()) { this._pending = null; this._actionError = ""; }
      if (this._active) {
        this.setData({ busy: false, retryPending: Boolean(this._pending), actionError: this._actionError });
        await this.refreshUser();
      }
    }
  },
  onCodeInput(event) { if (!this.data.binding) this.setData({ codeInput: event.detail.value }); },
  async onBind() {
    if (this.data.binding || !this._active) return;
    const code = this.data.codeInput.trim();
    if (!code) { wx.showToast({ title: "请输入激活码", icon: "none" }); return; }
    this.setData({ binding: true });
    try {
      const user = await call("AuthManager", { action: "bindIdentity", code });
      setUser(user);
      if (this._active) {
        this.setData({ codeInput: "" });
        wx.showModal({ title: "绑定成功", content: `当前身份：${(ROLE_META[user.role] || {}).label || user.role}`, showCancel: false });
        await this.refreshUser();
      }
    } catch (_error) { /* call 已提示 */ }
    finally { this.setData({ binding: false }); }
  },
});
