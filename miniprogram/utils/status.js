// utils/status.js
// 小程序端状态机定义；云函数中的同名常量必须遵守接口约定文档。
// 单元格状态（MatchCollection.cellStatus 字段的取值）

const CELL_STATUS = Object.freeze({
  PENDING: "pending",     // 黄色：待确认（队长已发布，经理人尚未确认）
  CONFIRMED: "confirmed", // 绿色：已确认（至少 1 位经理人/救场部员确认）
  HELP: "help",           // 红色：求助中（全员没空 / 赛前48h无人确认 / 临期改期）
  SETTLE: "settle",       // 橙色：待结算（到达预定结束时间，等待归档）
  TBD: "tbd",             // 灰色：时间待定挂起（暂停倒计时与拉红）
  CANCELLED: "cancelled", // 已取消（队长彻底取消比赛）
  DUTY_CANCELLED: "dutyCancelled", // 跟场已取消（运营者强制取消跟场，警报解除）
});

// 状态 → 显示配置（颜色、文字、说明）
const STATUS_META = Object.freeze({
  [CELL_STATUS.PENDING]: Object.freeze({ color: "#F5A623", label: "待确认", desc: "等待经理人确认跟场" }),
  [CELL_STATUS.CONFIRMED]: Object.freeze({ color: "#33C275", label: "已确认", desc: "跟场部员已确认到场" }),
  [CELL_STATUS.HELP]: Object.freeze({ color: "#E64340", label: "求助中", desc: "需转发求助卡片至大群" }),
  [CELL_STATUS.SETTLE]: Object.freeze({ color: "#FF8C00", label: "待结算", desc: "比赛结束，等待提交赛果" }),
  [CELL_STATUS.TBD]: Object.freeze({ color: "#999999", label: "时间待定", desc: "等待组委会确定时间" }),
  [CELL_STATUS.CANCELLED]: Object.freeze({ color: "#CCCCCC", label: "已取消", desc: "比赛已取消" }),
  [CELL_STATUS.DUTY_CANCELLED]: Object.freeze({ color: "#BBBBBB", label: "无需跟场", desc: "运营者已取消本场跟场" }),
});

// 用户角色（UserCollection.role 字段的取值）
const ROLE = Object.freeze({
  GUEST: "guest",     // 游客/普通同学（未绑定）
  CAPTAIN: "captain", // 代表队队长
  MEMBER: "member",   // 体育部部员/经理人
  ADMIN: "admin",     // 运营者/部长
});

const ROLE_META = Object.freeze({
  [ROLE.GUEST]: Object.freeze({ label: "游客", desc: "仅可浏览公开信息" }),
  [ROLE.CAPTAIN]: Object.freeze({ label: "队长", desc: "可管理本队赛程" }),
  [ROLE.MEMBER]: Object.freeze({ label: "部员", desc: "可响应跟场任务" }),
  [ROLE.ADMIN]: Object.freeze({ label: "运营者", desc: "全局管理与裁决" }),
});

// 跟场记录类型（DutyRecordCollection.type 字段的取值）
const DUTY_TYPE = Object.freeze({
  CONFIRM: "confirm",   // 确认跟场
  DECLINE: "decline",   // 没空
  RESCUE: "rescue",     // 救场接单
  CANCEL: "cancel",     // 取消我的跟场
  ASSIGN: "assign",     // 运营者指派
});

// 关键时间阈值（小时）
const HOURS = Object.freeze({
  FORCE_RED: 48, // 赛前 48h 无人确认强制拉红；临期修改/取消的安全锁阈值
});

module.exports = Object.freeze({
  CELL_STATUS,
  STATUS_META,
  ROLE,
  ROLE_META,
  DUTY_TYPE,
  HOURS,
});
