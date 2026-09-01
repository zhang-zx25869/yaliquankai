// cloudfunctions/TimerChecker/index.js
// 控制类：定时巡检（需求文档用例7/11）—— C同学看板线
//
// 每小时由定时触发器唤起（config.json：7 段式 cron，整点执行），无 action、无身份校验：
//   ① 距开赛 <48h 且仍为黄（pending）→ 强制置红（help）
//   ② 到达预定结束时间（endTime，settle 判据）→ 置橙（settle）
//
// 契约要点（接口约定 8.3 + 需求文档 L106）：
//   · 云函数之间互不调用，本函数直接查库，拉红/转橙规则与 DutyManager.recalcCellStatus 同规则；
//   · isTbd=true 的比赛 matchTime/endTime 存 null，TimerChecker 跳过（null 不会被 _.lt/_.lte 命中）；
//   · tbd/cancelled/dutyCancelled/settle 为挂起或终态，不参与巡检（cellStatus 条件天然排除）；
//   · 读时重算（getRespondPage/getRescuePage/getDashboard）兜底两次巡检之间的延迟窗口。

const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 单元格状态（与 miniprogram/utils/status.js 同值；接口约定第四节为最终契约）
const CELL_STATUS = Object.freeze({
  PENDING: "pending",         // 黄色：待确认
  CONFIRMED: "confirmed",     // 绿色：已确认
  HELP: "help",               // 红色：求助中
  SETTLE: "settle",           // 橙色：待结算
  TBD: "tbd",                 // 灰色：时间待定挂起
  CANCELLED: "cancelled",     // 已取消
  DUTY_CANCELLED: "dutyCancelled", // 无需跟场（运营者强制取消）
});

// 关键时间阈值（小时）
const HOURS = Object.freeze({
  FORCE_RED: 48, // 赛前 48h 无人确认强制拉红（与 DutyManager.recalcCellStatus 规则3 同源）
});

const notArchived = () => _.or([_.eq(false), _.exists(false)]); // 老数据可能没有 isArchived 字段

// 纯函数（供单测）：黄态且无跟场人且临期（<48h）→ 应拉红。
// 开区间契约「恰好 48 小时仍为黄色」（接口约定 8.1）；已开赛（差值为负）同样视为临期，
// 维持红色直到 endTime 转橙。matchTime 为 null（TBD）不拉红。
function isOverdueForHelp(match, now) {
  return match.cellStatus === CELL_STATUS.PENDING
    && !match.confirmerOpenid
    && !!match.matchTime
    && match.matchTime - now < HOURS.FORCE_RED * 3600 * 1000;
}

// 纯函数（供单测）：进行中比赛（黄/绿/红）到达预定结束时间 → 应转橙。
// settle 判据是 endTime（需求文档用例11 第1步「到达预定结束时间的瞬间」），恰好到点即转。
function isEndedForSettle(match, now) {
  return [CELL_STATUS.PENDING, CELL_STATUS.CONFIRMED, CELL_STATUS.HELP]
    .includes(match.cellStatus)
    && !!match.endTime
    && match.endTime <= now;
}

exports.main = async () => {
  // 定时触发无 OPENID，不做任何身份校验；触发参数仅用于日志
  const now = Date.now();
  console.log("[TimerChecker] 巡检开始", new Date(now).toLocaleString("zh-CN"));

  // 扫描量仅用于日志观测，不参与写入
  let scanned = 0;
  try {
    const cnt = await db.collection("MatchCollection")
      .where({
        cellStatus: _.in([CELL_STATUS.PENDING, CELL_STATUS.CONFIRMED, CELL_STATUS.HELP]),
        isArchived: notArchived(),
      })
      .count();
    scanned = cnt.total || 0;
  } catch (e) {
    console.warn("[TimerChecker] 扫描计数失败", e);
  }

  // ① 先转橙再拉红：到点比赛先落 settle，自然退出下方拉红条件，两步不会互相覆盖
  let toSettle = 0;
  try {
    const upd = await db.collection("MatchCollection")
      .where({
        cellStatus: _.in([CELL_STATUS.PENDING, CELL_STATUS.CONFIRMED, CELL_STATUS.HELP]),
        endTime: _.lte(now), // null（TBD）不会被 _.lte 命中
        isArchived: notArchived(),
      })
      .update({ data: { cellStatus: CELL_STATUS.SETTLE, updatedAt: now } });
    toSettle = (upd.stats && upd.stats.updated) || 0;
  } catch (e) {
    console.warn("[TimerChecker] 转橙批量更新失败", e);
  }

  let toHelp = 0;
  try {
    const upd = await db.collection("MatchCollection")
      .where({
        cellStatus: CELL_STATUS.PENDING,
        confirmerOpenid: _.or([_.exists(false), _.eq("")]), // 无跟场人（含老数据空串）
        matchTime: _.lt(now + HOURS.FORCE_RED * 3600 * 1000), // null（TBD）不会被 _.lt 命中
        isArchived: notArchived(),
      })
      .update({ data: { cellStatus: CELL_STATUS.HELP, updatedAt: now } });
    toHelp = (upd.stats && upd.stats.updated) || 0;
  } catch (e) {
    console.warn("[TimerChecker] 拉红批量更新失败", e);
  }

  const stats = { scanned, toSettle, toHelp };
  console.log("[TimerChecker] 巡检完成", JSON.stringify(stats));
  return stats;
};

// 仅供本地单元测试核对契约；对象均冻结，业务代码不得在运行时修改。
exports.__test__ = Object.freeze({
  CELL_STATUS, HOURS,
  isOverdueForHelp, isEndedForSettle,
});
