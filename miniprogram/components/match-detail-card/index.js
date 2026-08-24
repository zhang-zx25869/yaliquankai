// components/match-detail-card/index.js
// B10 共用比赛详情卡片组件（用例17 ViewMatchDetailCard）
// 在 首页日历 / 队伍栏目 / 看板单元格 三处复用
// 展示：状态标签 + 对阵 + 时间地点 + 后勤需求 + 比分（已归档）
// 按角色渲染操作按钮：运营者【强制取消跟场】【手动修改跟场状态】；已确认部员【取消我的跟场】
const { CELL_STATUS, STATUS_META, ROLE } = require("../../utils/status");

Component({
  options: {
    multipleSlots: false,
  },

  properties: {
    // 比赛对象（由各页面从云端查询后传入）
    // { _id, teamName, sport, rival, time, location, demands:[], cellStatus,
    //   confirmerName, score, result, mediaLink }
    match: {
      type: Object,
      value: {},
      observer(m) {
        if (m && m.cellStatus) {
          const meta = STATUS_META[m.cellStatus] || {};
          this.setData({ statusMeta: meta });
        }
      },
    },
    // 当前用户角色（页面传入），决定是否渲染管理按钮
    role: {
      type: String,
      value: ROLE.GUEST,
    },
    // 是否显示管理/操作按钮（看板页运营者用）
    showActions: {
      type: Boolean,
      value: false,
    },
    expanded: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    statusMeta: {},
    roleAdmin: ROLE.ADMIN,
    roleMember: ROLE.MEMBER,
    cellStatusHelp: CELL_STATUS.HELP,
  },

  methods: {
    // 展开/收起（下滑展开交互由父页面控制，组件只冒泡事件）
    onToggle() {
      this.triggerEvent("toggle", { id: this.data.match._id });
    },
    // 运营者：强制取消跟场（用例14，由看板页监听处理）
    onForceCancel() {
      this.triggerEvent("forcecancel", { id: this.data.match._id });
    },
    // 运营者：手动修改跟场状态（用例15）
    onManualReset() {
      this.triggerEvent("manualreset", { id: this.data.match._id });
    },
    // 部员：取消我的跟场（用例10，由响应页/看板页监听处理）
    onCancelDuty() {
      this.triggerEvent("cancelduty", { id: this.data.match._id });
    },
    // 复制云盘链接（媒体浏览，用例18）
    onCopyLink() {
      const link = this.data.match.mediaLink;
      if (!link) return;
      wx.setClipboardData({ data: link });
    },
  },
});
