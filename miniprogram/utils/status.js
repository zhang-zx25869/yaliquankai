// utils/status.js
// 全局状态机定义：前端展示与云函数逻辑共用同一套状态常量
// 单元格状态（MatchCollection.cellStatus 字段的取值）

const CELL_STATUS = {
  PENDING: "pending",     // 黄色：待确认（队长已发布，经理人尚未确认）
  CONFIRMED: "confirmed", // 绿色：已确认（至少 1 位经理人/救场部员确认）
  HELP: "help",           // 红色：求助中（全员没空 / 赛前48h无人确认 / 临期改期）
  SETTLE: "settle",       // 橙色：待结算（到达预定结束时间，等待归档）
  TBD: "tbd",             // 灰色：时间待定挂起（暂停倒计时与拉红）
  CANCELLED: "cancelled", // 已取消（队长彻底取消比赛）
  DUTY_CANCELLED: "dutyCancelled", // 跟场已取消（运营者强制取消跟场，警报解除）
};

// 状态 → 显示配置（颜色、文字、说明）
const STATUS_META = {
  [CELL_STATUS.PENDING]: { color: "#F5A623", label: "待确认", desc: "等待经理人确认跟场" },
  [CELL_STATUS.CONFIRMED]: { color: "#33C275", label: "已确认", desc: "跟场部员已确认到场" },
  [CELL_STATUS.HELP]:    { color: "#E64340", label: "求助中", desc: "需转发求助卡片至大群" },
  [CELL_STATUS.SETTLE]:  { color: "#FF8C00", label: "待结算", desc: "比赛结束，等待提交赛果" },
  [CELL_STATUS.TBD]:     { color: "#999999", label: "时间待定", desc: "等待组委会确定时间" },
  [CELL_STATUS.CANCELLED]: { color: "#CCCCCC", label: "已取消", desc: "比赛已取消" },
  [CELL_STATUS.DUTY_CANCELLED]: { color: "#BBBBBB", label: "无需跟场", desc: "运营者已取消本场跟场" },
};

// 用户角色（UserCollection.role 字段的取值）
const ROLE = {
  GUEST: "guest",     // 游客/普通同学（未绑定）
  CAPTAIN: "captain", // 代表队队长
  MEMBER: "member",   // 体育部部员/经理人
  ADMIN: "admin",     // 运营者/部长
};

const ROLE_META = {
  [ROLE.GUEST]:  { label: "游客", desc: "仅可浏览公开信息" },
  [ROLE.CAPTAIN]:{ label: "队长", desc: "可管理本队赛程" },
  [ROLE.MEMBER]: { label: "部员", desc: "可响应跟场任务" },
  [ROLE.ADMIN]:  { label: "运营者", desc: "全局管理与裁决" },
};

// 跟场记录类型（DutyRecordCollection.type 字段的取值）
const DUTY_TYPE = {
  CONFIRM: "confirm",   // 确认跟场
  DECLINE: "decline",   // 没空
  RESCUE: "rescue",     // 救场接单
  CANCEL: "cancel",     // 取消我的跟场
  ASSIGN: "assign",     // 运营者指派
};

// 关键时间阈值（小时）
const HOURS = {
  FORCE_RED: 48, // 赛前 48h 无人确认强制拉红；临期修改/取消的安全锁阈值
};

module.exports = {
  CELL_STATUS,
  STATUS_META,
  ROLE,
  ROLE_META,
  DUTY_TYPE,
  HOURS,
};
