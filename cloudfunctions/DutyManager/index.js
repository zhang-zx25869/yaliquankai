// cloudfunctions/DutyManager/index.js
// 控制类：跟场任务（对应用例6/7/8/9/10）—— B同学跟场线
// ── 契约空壳：所有 action 均返回 501 开发中，业务逻辑待实装 ──
//
// action: getRespondPage   —— 响应页聚合数据（比赛信息 + 我的表态 + 本队统计）
// action: getRescuePage    —— 救场页聚合数据（比赛信息 + 求助原因）
// action: getTeamStats     —— 本队经理人历史跟场次数统计
// action: confirmDuty      —— 确认跟场：写留痕 + 单元格置绿
// action: declineDuty      —— 没空：单经理人置红 / 多经理人全员没空才置红
// action: generateHelpCard —— 生成求助卡片（仅红色状态可调）
// action: rescueDuty       —— 大群救场接单：红色 → 绿色
// action: cancelMyDuty     —— 取消我的跟场：释放名额回黄色（<48h 安全锁）

const cloud = require("wx-server-sdk");           //引入官方SDK，封装微信云函数能力的工具箱
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });   //动态识别，连接云环境
const db = cloud.database();                      //数据库
const _ = db.command;                             //查询指令集

// 统一返回格式：{ code: 0, data } 成功；{ code: 非0, message } 失败
const ok = (data) => ({ code: 0, data });
const fail = (code, message) => ({ code, message });
/*等价于传统写法：
function ok(data) {
  return { code: 0, data: data };
}
function fail(code, message) {
  return { code: code, message: message };
}
*/

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext(); // 微信自动注入操作者对应编号
  const { action } = event;

  console.log("[DutyManager]", action, event);

  try {
    switch (action) {
      case "getRespondPage":
        return await getRespondPage(OPENID, event);
      case "getRescuePage":
        return await getRescuePage(OPENID, event);
      case "getTeamStats":
        return await getTeamStats(OPENID, event);
      case "confirmDuty":
        return await confirmDuty(OPENID, event);
      case "declineDuty":
        return await declineDuty(OPENID, event);
      case "generateHelpCard":
        return await generateHelpCard(OPENID, event);
      case "rescueDuty":
        return await rescueDuty(OPENID, event);
      case "cancelMyDuty":
        return await cancelMyDuty(OPENID, event);
      default:
        return fail(400, "未知操作");
    }
  } catch (e) {
    console.error("[DutyManager]", e);
    return fail(500, "服务器开小差了");
  }
};

// ─────────────────────────────────────────────
// 以下为空壳函数，每个函数头部注释即接口契约（已群里同步，改动需告知队友）
// ─────────────────────────────────────────────

// —— 用例7：响应页聚合查询（比赛信息 + 我的表态 + 本队统计一次拿全）——
// event: { matchId }
// 返回 data: { match, myStatus: 'none'|'confirmed'|'declined',
//              stats: [{nickname, count}], remainingCount, canHelp }
async function getRespondPage(openid, event) {
  return fail(501, "开发中");
}

// —— 用例9：救场页聚合查询（比赛信息 + 求助原因）——
// event: { matchId }
// 返回 data: { match, helpReason }
async function getRescuePage(openid, event) {
  return fail(501, "开发中");
}

// —— 用例6：本队经理人历史跟场次数统计 ——
// event: { teamId }
// 返回 data: { stats: [{ nickname, count }] }  // count 只计 confirm/rescue/assign
async function getTeamStats(openid, event) {
  return fail(501, "开发中");
}

// —— 用例7：确认跟场 ——
// event: { matchId }
// 返回 data: { cellStatus: 'confirmed' }  // 写 DutyRecord(confirm) + 置绿 + 记录confirmer
async function confirmDuty(openid, event) {
  return fail(501, "开发中");
}

// —— 用例7：没空（多人表态分流：单人队直接红；多人队最后一人没空才红）——
// event: { matchId }
// 返回 data: { cellStatus, canHelp, remainingCount }
async function declineDuty(openid, event) {
  return fail(501, "开发中");
}

// —— 用例8：生成求助卡片（纯读不落库，仅 cellStatus=help 可调）——
// event: { matchId }
// 返回 data: { title, path, desc }  // path = /pages/rescue/index?matchId=xxx
async function generateHelpCard(openid, event) {
  return fail(501, "开发中");
}

// —— 用例9：大群救场接单（仅红色可接，红 → 绿，跟场人更新为救场者）——
// event: { matchId }
// 返回 data: { cellStatus: 'confirmed' }
async function rescueDuty(openid, event) {
  return fail(501, "开发中");
}

// —— 用例10：取消我的跟场 ——
// 正常取消：写 DutyRecord(cancel) + 清 confirmer + 回 pending
// 返回 data: { cellStatus: 'pending' }
async function cancelMyDuty(openid, event) {
  return fail(501, "开发中");
}
