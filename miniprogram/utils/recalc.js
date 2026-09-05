// utils/recalc.js
// 统一重算器（接口约定第八节定稿 recalcCellStatus 的前端 mock 版）
// 所有表态变动（确认/没空/取消/救场/读时兜底）后都调它，杜绝前端写死颜色。
// 云函数实装的 recalcCellStatus 必须与本函数同规则（值以接口约定为准）。
const { CELL_STATUS, HOURS } = require("./status");

/**
 * 输入表态池原始对象（mock 数据），输出应得单元格状态。
 * 规则（与云端一致）：
 *  - 有人确认（confirmerNickname 非空）→ confirmed
 *  - 全员没空（_declinedCount >= _teamSize）→ help
 *  - 距开赛 <48h 且无人确认 → help
 *  - 其余 → pending
 * tbd / cancelled / dutyCancelled / settle 为挂起或终态，不参与重算（调用方保证不进本函数）。
 */
function mockRecalc(raw) {
  if (raw.confirmerNickname) return CELL_STATUS.CONFIRMED;      // 有人确认 → 绿
  const declined = raw._declinedCount || 0;                     // 已表态没空人数
  const total = raw._teamSize || 1;                             // 本队经理人总数
  if (declined >= total) return CELL_STATUS.HELP;               // 全员没空 → 红
  if (raw.matchTime - Date.now() < HOURS.FORCE_RED * 3600 * 1000)
    return CELL_STATUS.HELP;                                    // 临期无人确认 → 红
  return CELL_STATUS.PENDING;                                   // 其余 → 黄
}

module.exports = { mockRecalc };
