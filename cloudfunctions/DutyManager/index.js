// cloudfunctions/DutyManager/index.js
// 控制类：跟场任务（对应用例6/7/8/9/10）—— B同学跟场线
//
// action: getRespondPage   —— 响应页聚合数据（比赛信息 + 我的表态 + 本队统计）
// action: getRescuePage    —— 救场页聚合数据（比赛信息 + 我的表态）
// action: getTeamStats     —— 本队经理人历史跟场次数统计
// action: confirmDuty      —— 确认跟场：写留痕 + 单元格置绿
// action: declineDuty      —— 没空：单经理人置红 / 多经理人全员没空才置红
// action: rescueDuty       —— 大群救场接单：红色 → 绿色
// action: cancelMyDuty     —— 取消我的跟场：释放名额回黄色（<48h 安全锁）
// action: generateHelpCard —— 生成求助卡片（红态，云端格式化 title/path）

const cloud = require("wx-server-sdk");           //引入官方SDK，封装微信云函数能力的工具箱
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });   //动态识别，连接云环境
const db = cloud.database();                      //数据库
const _ = db.command;                             //查询指令集

// 单元格状态（MatchCollection.cellStatus 字段取值）
const CELL_STATUS = Object.freeze({
  PENDING: "pending",         // 黄色：待确认
  CONFIRMED: "confirmed",     // 绿色：已确认
  HELP: "help",               // 红色：求助中
  SETTLE: "settle",           // 橙色：待结算
  TBD: "tbd",                 // 灰色：时间待定挂起
  CANCELLED: "cancelled",     // 已取消
  DUTY_CANCELLED: "dutyCancelled", // 无需跟场（运营者强制取消）
});

// 用户角色（UserCollection.role 字段取值）
const ROLE = Object.freeze({
  GUEST: "guest",
  CAPTAIN: "captain",
  MEMBER: "member",
  ADMIN: "admin",
});

// 跟场记录类型（DutyRecordCollection.type 字段取值）
const DUTY_TYPE = Object.freeze({
  CONFIRM: "confirm",   // 确认跟场
  DECLINE: "decline",   // 没空
  RESCUE: "rescue",     // 救场接单
  ASSIGN: "assign",     // 运营者指派
});

// 关键时间阈值（小时）
const HOURS = Object.freeze({
  FORCE_RED: 48, // 赛前 48h 无人确认强制拉红；临期修改/取消的安全锁阈值
});

// ── 数据一致性说明（接口约定 8.1 的实现取舍）────────────────────────────
// 契约要求「留痕 + 状态变更同一事务」，但云数据库事务不支持 where()/count()，
// 而统一重算器 recalcCellStatus 依赖 count 聚合（decline 人数 / 本队经理人总数），
// 无法整体放入事务。因此本实现用「条件更新 + 唯一索引 upsert」做近似保证：
//  · 抢占名额/撤确认：where(...).update() 条件更新，.updated=0 即被抢先 → 409/404；
//  · 表态留痕：matchId+openid 联合唯一索引 + upsert 收敛为一条，天然幂等；
//  · 颜色裁决：recalcCellStatus 以库内实时 confirmerOpenid 为准（见下），
//    配合读时重算（getRespondPage/getRescuePage）兜底自愈，窗口期可忽略。
// 此取舍在群内已同步，契约以本文档 + 接口约定.md 备注为准。

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
      case "rescueDuty":
        return await rescueDuty(OPENID, event);
      case "cancelMyDuty":
        return await cancelMyDuty(OPENID, event);
      case "generateHelpCard":
        return await generateHelpCard(OPENID, event);
      case "getMyDuties":
        return await getMyDuties(OPENID, event);
      default:
        return fail(400, "未知操作");
    }
  } catch (e) {
    console.error("[DutyManager]", e);
    return fail(500, "服务器开小差了");
  }
};


// ─────────────────────────────────────────────
// 通用工具函数：身份校验 / 脱敏 DTO / 时间格式化
// ─────────────────────────────────────────────

// 按 OPENID 查 UserCollection 拿身份；查不到视为游客。
// 身份一律以云端查询为准，绝不信任前端传入的 role/teamId（接口约定 8.1）
async function getUserByOpenid(openid){
  if(!openid) return null;
  const res = await db.collection("UserCollection").where({openid}).limit(1).get();
  return res.data[0] || null;
}

// 部员身份守卫：未绑定 → 401；非部员/运营者 → 403
function requireMember(user) {
  if(!user) return fail(401, "请先绑定身份");
  if(user.role !== ROLE.MEMBER && user.role !== ROLE.ADMIN) {
    return fail(403, "仅部员可执行此操作");
  }
  return null;
}

// 跟场操作守卫：member 需本队且 teamId 与比赛一致；admin（运营者）全场景放行，
// 可对任意队比赛确认/没空/取消（admin 同时是部员，兜底跟场）。
// 救场线（rescueDuty/getRescuePage）用 requireMember（不限本队），admin 已天然放行。
function requireTeamManager(user, match) {
  const guard = requireMember(user);
  if(guard) return guard;
  if(user.role === ROLE.ADMIN) return null; // admin 不受本队限制
  if(!match || match.teamId !== user.teamId) {
    return fail(403, "仅本队经理人可操作本场跟场");
  }
  return null;
}

// 时间戳 → 中文时间串（如 "8月26日 15:00"）；timeText 由云端统一格式化，前端不重复实现
function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Match 记录 → 脱敏 MatchDTO：
// 剔除 captainOpenid / confirmerOpenid 等所有 openid 字段（接口约定 8.1）
function toDTO(match) {
  if (!match) return null;
  const {
    _id, teamId, teamName, sport, rival,
    matchTime, endTime, location, demands,
    isTbd, cellStatus, confirmerNickname, confirmerType,
    isArchived,
  } = match;
  return {
    _id, teamId, teamName, sport, rival,
    matchTime, endTime, location,
    demandsText: (demands || []).join("、"),
    isTbd: !!isTbd,
    cellStatus,
    confirmerNickname: confirmerNickname || "",
    confirmerType: confirmerType || "",
    timeText: formatTime(matchTime),
    isArchived: !!isArchived,
  };
}

// 查单场比赛；不存在 → 404
async function getMatchById(matchId) {
  if(!matchId) return { error: fail(400, "缺少比赛参数")};
  const res = await db.collection("MatchCollection").doc(matchId).get().catch(() => null);
  if (!res || !res.data) return { error: fail(404, "比赛不存在") };
  return { match: res.data };
}

// 统计本队经理人总数（重算器用）：UserCollection 中 teamId 匹配且 role=member
async function countTeamManager(teamId) {
  if (!teamId) return 0;
  const res = await db.collection("UserCollection")
  .where({ teamId, role: ROLE.MEMBER })
  .count();
  return res.total || 0;
}

// 查本人对某场比赛的表态类型（myStatus 用）：none | confirmed | declined
// 幂等由写入侧保证：一人一场至多一条有效表态记录（upsert 覆盖），直接查即可
async function getMyLatestType(matchId, openid) {
  if(!matchId || !openid) return "none";
  const res = await db.collection("DutyRecordCollection")
  .where({ matchId, openid })
  .orderBy("updatedAt", "desc")
  .limit(1)
  .get();
  const rec = res.data[0];
  if(!rec) return "none";
  if (rec.type === DUTY_TYPE.CONFIRM || rec.type === DUTY_TYPE.RESCUE) return "confirmed";
  if (rec.type === DUTY_TYPE.DECLINE) return "declined";
  return "none";
}

// 统计本场已表态「没空」的人数
// 幂等由写入侧保证：一人一场至多一条有效表态记录（upsert），直接计数即可
async function countDeclinedUsers(matchId) {
  const res = await db.collection("DutyRecordCollection")
  .where({ matchId, type: DUTY_TYPE.DECLINE })
  .count();
  return res.total || 0;
}



// —— 用例7：响应页聚合查询（比赛信息 + 我的表态 + 本队统计一次拿全）——
// event: { matchId }
// 返回 data: { match, myStatus: 'none'|'confirmed'|'declined',
//              stats: [{nickname, count}], remainingCount, canHelp }
async function getRespondPage(openid, event) {
  const user = await getUserByOpenid(openid);
  if (!user) return fail(401, "您现在是游客，请先绑定身份");
  
  const { matchId } = event;
  const { match, error } = await getMatchById(matchId);
  if(error) return error;

  const teamGuard = requireTeamManager(user, match);
  if(teamGuard) return teamGuard;

  // 读时重算（接口约定定稿）：挂起/终态不参与重算，其余先刷新再返回
  if(!isTerminalStatus(match.cellStatus)) {
    match.cellStatus = await recalcCellStatus(match);
  }

  const myStatus = await getMyLatestType(matchId, openid);
  const stats = await buildTeamStats(match.teamId);
  const total = await countTeamManager(match.teamId);
  const declined = await countDeclinedUsers(matchId);

  return ok({
    match: toDTO(match),
    myStatus,
    stats,
    remainingCount: Math.max(0, total - declined),
    canHelp: match.cellStatus === CELL_STATUS.HELP,
  })
}

// —— 用例9：救场页聚合查询（比赛信息 + 我的表态）——
// event: { matchId }
// 返回 data: { match, myStatus }
async function getRescuePage(openid, event) {
  const user = await getUserByOpenid(openid);
  const guard = requireMember(user);
  if (guard) return guard;
  
  const { matchId } = event;
  const { match, error } = await getMatchById(matchId);
  if(error) return error;

  if (!isTerminalStatus(match.cellStatus)) {
    match.cellStatus = await recalcCellStatus(match);
  }

  const myStatus = await getMyLatestType(matchId, openid);
  return ok({ match: toDTO(match), myStatus });
}

// —— 用例6：本队经理人历史跟场次数统计 ——
// event: 无（teamId 取调用者本人队伍，忽略前端传参——契约：仅本队经理人可查）
// 返回 data: { stats: [{ nickname, count }] }  // count 只计 confirm/rescue/assign
async function getTeamStats(openid, _event) {
  const user = await getUserByOpenid(openid);
  const guard = requireMember(user);
  if (guard) return guard;

  const teamId = user.teamId;
  if (!teamId) return fail(400, "缺少队伍参数");

  const stats = await buildTeamStats(teamId);
  return ok({ stats });
}


// ── 读接口共用辅助 ─────────────────────────────

// 挂起/终态集合：不参与重算（tbd/cancelled/dutyCancelled/settle 保持原样返回）
function isTerminalStatus(status) {
  return [
    CELL_STATUS.TBD, CELL_STATUS.CANCELLED,
    CELL_STATUS.DUTY_CANCELLED, CELL_STATUS.SETTLE,
  ].includes(status);
}

// 聚合本队历史有效跟场次数（confirm/rescue/assign 各计 1 次）：
// DutyRecordCollection 按 openid 去重计数（一人一场至多一条有效记录，写入侧 upsert 保证）
async function buildTeamStats(teamId) {
  if(!teamId) return [];

  // 本队全部经理人名单
  const users = await db.collection("UserCollection")
  .where({ teamId, role: ROLE.MEMBER })
  .limit(100)
  .get();
  if(!users.data.length) return [];

  // 本队所有比赛的跟场留痕（有效类型）。
  // limit(1000)：单次取全本队留痕——每队赛季场次 × 经理人数远小于 1000，够用；
  // 未来若超出需改游标分页聚合，当前规模不做
  const records = await db.collection("DutyRecordCollection")
  .where({ teamId, type: _.in([DUTY_TYPE.CONFIRM, DUTY_TYPE.RESCUE, DUTY_TYPE.ASSIGN])})
  .limit(1000)
  .get();

  // 按 openid 计数，映射回昵称
  const countMap = {};
  records.data.forEach((r) => {
    countMap[r.openid] = (countMap[r.openid] || 0) + 1;
  })

  return users.data.map((u) => ({
    nickname: u.nickname,
    count: countMap[u.openid] || 0,
  }));
}



// —— 用例7：确认跟场 ——
// event: { matchId }
// 返回 data: { cellStatus: 'confirmed' }  // 写 DutyRecord(confirm) + 置绿 + 记录confirmer
// 守卫：本队经理人；黄态/红态均可（红态确认即回补）；绿态仅 confirmer 本人幂等重入，他人 409
async function confirmDuty(openid, event) {
  const user = await getUserByOpenid(openid);
  if(!user) return fail(401, "您现在是游客，请先绑定身份");

  const { match, error } = await getMatchById(event.matchId);
  if(error) return error;

  const teamGuard = requireTeamManager(user, match);
  if(teamGuard) return teamGuard;

   // 挂起/终态一律不允许表态（tbd/cancelled/dutyCancelled/settle）
   if(isTerminalStatus(match.cellStatus)) {
    return fail(409, "该场比赛当前状态无法确认跟场");
   }

   // 比赛已开赛/已结束：跟场已进入执行或结算阶段，任何表态写入都无意义
   //（覆盖 confirm/decline/rescue/cancel 四动作的统一状态机约束）
   if (match.matchTime && match.matchTime <= Date.now()) {
    return fail(409, "比赛已开始，无法确认跟场");
   }

   // 绿态：已有人跟场。confirmer 本人重复点击 → 幂等成功；其他人 → 先到先得，409
   if(match.cellStatus === CELL_STATUS.CONFIRMED && match.confirmerOpenid) {
    if(match.confirmerOpenid === openid){
      return ok({ cellStatus: CELL_STATUS.CONFIRMED })
    }
    return fail(409, "本场已有人跟场");
   }

   // 条件更新抢占名额（与 rescueDuty 同模式）：只允许从 pending/help 态迁入。
   // 前置绿态检查与本次 update 之间存在竞态窗口（另一经理人可能已抢先确认），
   // 无条件 doc().update 会覆盖他人快照；条件更新 .updated=0 即说明已被抢先。
   const upd = await db.collection("MatchCollection")
   .where({ _id: match._id, cellStatus: _.in([CELL_STATUS.PENDING, CELL_STATUS.HELP]) })
   .update({
     data: {
       confirmerOpenid: openid,
       confirmerNickname: user.nickname,
       confirmerType: DUTY_TYPE.CONFIRM,
       updatedAt: Date.now(),
     },
   });

   if(!upd.stats || upd.stats.updated === 0) {
     // 已被抢先：重读一次区分「本人幂等重入」与「他人 409」
     const reread = await db.collection("MatchCollection").doc(match._id).get().catch(() => null);
     const cur = reread && reread.data;
     if(cur && cur.confirmerOpenid === openid && cur.cellStatus === CELL_STATUS.CONFIRMED) {
       return ok({ cellStatus: CELL_STATUS.CONFIRMED }); // 并发重试：本人记录已写入
     }
     return fail(409, "本场已有人跟场");
   }

   // 写留痕（upsert：一人一场至多一条记录），然后统一重算
   await upsertDutyRecord(match, user, DUTY_TYPE.CONFIRM);

   const cellStatus = await recalcCellStatus({
    ...match, confirmerOpenid: openid,
  });
  return ok({ cellStatus });
}

// —— 用例7：没空（表态池变动后统一走 recalcCellStatus 重算颜色）——
// event: { matchId }
// 返回 data: { cellStatus, remainingCount, canHelp }
// 守卫：本队经理人；仅黄态可点（红态没空无信息增量，前端已隐藏按钮）
async function declineDuty(openid, event) {
  const user = await getUserByOpenid(openid);
  if (!user) return fail(401, "您现在是游客，请先绑定身份");

  const { match, error } = await getMatchById(event.matchId);
  if (error) return error;

  const teamGuard = requireTeamManager(user, match);
  if (teamGuard) return teamGuard;

  if (isTerminalStatus(match.cellStatus)) {
    return fail(409, "该场比赛当前状态无法表态");
  }
  if (match.cellStatus !== CELL_STATUS.PENDING) {
    return fail(409, "仅待确认状态可表态没空");
  }

  // 比赛已开赛/已结束：黄态说明无人确认，此时表态无意义（统一已开赛硬禁）
  if (match.matchTime && match.matchTime <= Date.now()) {
    return fail(409, "比赛已开始，无法表态");
  }

  // 幂等：本人已是 declined 则直接返回当前池状态，不重复写
  const myType = await getMyLatestType(match._id, openid);
  if(myType !== "declined") {
    await upsertDutyRecord(match, user, DUTY_TYPE.DECLINE);
  }

  const cellStatus = await recalcCellStatus(match);
  const total = await countTeamManager(match.teamId);
  const declined = await countDeclinedUsers(match._id);

  return ok({
    cellStatus,
    remainingCount: Math.max(0, total - declined),
    canHelp: cellStatus === CELL_STATUS.HELP,
  })
}

// —— 用例9：大群救场接单（仅红色可接，红 → 绿，跟场人更新为救场者）——
// event: { matchId }
// 返回 data: { cellStatus: 'confirmed' }
// 双通道并发：与响应页确认先到先得。以「条件更新」保证只有一个救场人能从 help 迁移到 confirmed
async function rescueDuty(openid, event) {
  const user = await getUserByOpenid(openid);
  const guard = requireMember(user);
  if (guard) return guard;

  const { match, error } = await getMatchById(event.matchId);
  if (error) return error;

  if (isTerminalStatus(match.cellStatus)) {
    return fail(409, "该场比赛当前状态无法救场");
  }

  // 比赛已开赛/已结束：救场已无意义（人到了也接不上），与 cancelMyDuty 同规则硬禁
  if (match.matchTime && match.matchTime <= Date.now()) {
    return fail(409, "比赛已开始，无法救场");
  }

  await recalcCellStatus(match); // 刷新库内颜色

  const upd = await db.collection("MatchCollection")
  .where({ _id: match._id, cellStatus: CELL_STATUS.HELP })
  .update({
    data: {
      confirmerOpenid: openid,
      confirmerNickname: user.nickname,
      confirmerType: DUTY_TYPE.RESCUE,
      updatedAt: Date.now(),
    },
  });

  if(!upd.stats || upd.stats.updated === 0) {
  return fail(409, "本场已有人跟场"); // 已被响应页/其他部员抢先
  }

  await upsertDutyRecord(match, user, DUTY_TYPE.RESCUE);
  // 刷新库内颜色（返回值不用于本 action 出参，rescue 恒置绿）
  await recalcCellStatus({
    ...match, confirmerOpenid: openid,
  });

  return ok({ cellStatus: CELL_STATUS.CONFIRMED });
}

// —— 用例10：取消我的跟场/救场 ——
// 取消语义（接口约定定稿）：取消 ≡ 本人最新表态变为「没空」。
// 撤 confirmerOpenid + decline 留痕 → 统一走 recalcCellStatus 重算：
//   其他人已全员decline → 红；临期(<48h)无人确认 → 红；否则黄。
// 返回 data: { cellStatus, canHelp }
async function cancelMyDuty(openid, event) {
  const user = await getUserByOpenid(openid);
  if (!user) return fail(401, "您现在是游客，请先绑定身份");

  const { match, error } = await getMatchById(event.matchId);
  if (error) return error;

  if (isTerminalStatus(match.cellStatus)) {
    return fail(409, "该场比赛当前状态无法取消");
  }

  // 比赛已开赛/已结束：跟场已完成或正在进行，取消会导致终局比赛被误拉红求助
  if (match.matchTime && match.matchTime <= Date.now()) {
    return fail(409, "比赛已开始，无法取消跟场");
  }

  // 只有当前跟场人能取消（404 无确认记录语义）——预检；并发下以条件更新结果为准
  if (match.confirmerOpenid !== openid) {
    return fail(404, "你尚未确认本场跟场");
  }

  // 条件更新撤确认（与 confirmDuty/rescueDuty 同模式）：仅当库里 confirmer 仍是我时生效，
  // 消除预检与写入之间「他人已重新确认 / 本人重复取消」的竞态窗口
  const upd = await db.collection("MatchCollection")
  .where({ _id: match._id, confirmerOpenid: openid })
  .update({
    data: {
      confirmerOpenid: _.remove(),
      confirmerNickname: _.remove(),
      confirmerType: _.remove(),
      updatedAt: Date.now(),
    },
  });
  if(!upd.stats || upd.stats.updated === 0) {
    return fail(404, "你尚未确认本场跟场"); // 已被并发取消或他人已接管
  }

  // 取消 ≡ 没空：撤确认成功后再写 decline 留痕（upsert 覆盖本人原 confirm/rescue 记录）
  await upsertDutyRecord(match, user, DUTY_TYPE.DECLINE);

  const cellStatus = await recalcCellStatus({
    ...match, confirmerOpenid: "", // 按撤确认后的快照重算，不写死颜色
  });

  return ok({
    cellStatus,
    canHelp: cellStatus === CELL_STATUS.HELP,
  });
}

// —— 用例8：生成求助卡片（云端格式化返回 title/path）——
// 红态下本队经理人（member 需本队，admin 全场景）调用；前端 onShareAppMessage 同步返回缓存。
// 返回 data: { title, path } —— title 含「跟场求助」+ 对阵 + 时间；path 指向救场页。
async function generateHelpCard(openid, event) {
  const user = await getUserByOpenid(openid);
  if (!user) return fail(401, "请先绑定身份");

  const { match, error } = await getMatchById(event.matchId);
  if (error) return error;

  // 权限：member 需本队，admin 全场景
  const guard = requireTeamManager(user, match);
  if (guard) return guard;

  // 仅求助（红）态可生成求助卡片
  if (match.cellStatus !== CELL_STATUS.HELP) {
    return fail(409, "当前状态无需生成求助卡片");
  }

  const title = `【跟场求助】${match.teamName} vs ${match.rival} ${formatTime(match.matchTime)}，希望有空的同学补位！`;
  const path = `/pages/rescue/index?matchId=${match._id}`;
  return ok({ title, path });
}

// —— 用例10a：我的跟场列表 ——
// event: 无（openid 自动注入）
// 返回 data: { list: [MatchDTO] }  // 我当前跟场的、未完结未归档的比赛（confirmed 或 settle），
//                                   // 按 matchTime 正序（最近要跟的排最前）
async function getMyDuties(openid, _event) {
  const user = await getUserByOpenid(openid);
  const guard = requireMember(user);
  if (guard) return guard;

  // 直查 MatchCollection.confirmerOpenid——它是"当前跟场人"的唯一权威来源：
  const res = await db.collection("MatchCollection")
  .where({
    confirmerOpenid: openid,
    cellStatus: _.in([CELL_STATUS.CONFIRMED, CELL_STATUS.SETTLE]),
    isArchived: _.or([_.eq(false), _.exists(false)]),
  })
  .orderBy("matchTime", "asc")
  .limit(100)
  .get();

  return ok({ list: res.data.map(toDTO) });
}

// —— 统一重算器（接口约定第八节·定稿）：所有表态变动的唯一颜色裁决器 ——
// confirmDuty / declineDuty / cancelMyDuty / rescueDuty / TimerChecker / saveMatch 后调用
// 规则（与前端 utils/recalc.js 的 mockRecalc 同规则，改动须两端同步）：
//   if (confirmerOpenid)            return 'confirmed'   // 有人确认 → 绿
//   if (decline数 >= 本队经理人总数) return 'help'        // 全员没空 → 红
//   if (距开赛 < 48h)               return 'help'        // 临期无人确认 → 红
//   return 'pending'                                     // 其余 → 黄
// tbd / cancelled / dutyCancelled / settle 为挂起或终态，不参与重算（调用方保证不进本函数）
async function recalcCellStatus(match) {
  const now = Date.now();

  // 以库内实时 confirmerOpenid 为准，不信任调用方传入的 match 快照：
  // 写路径（confirm/rescue/cancel）传入的快照可能已过时，若直接用其重算并 writeRecalced，
  // 极端并发下会覆盖他人刚抢注的 confirmed（如 cancel 撤确认后他人恰好接单）。
  // 重读一次取真实 confirmer，颜色裁决与库内实际一致；读时重算路径同样受益。
  const fresh = await getMatchById(match._id);
  const confirmerOpenid = (fresh.match && fresh.match.confirmerOpenid)
    || (match.confirmerOpenid || ""); // 兜底：重读失败时退回调用方值（正常不会发生）

  // 规则1：有人确认 → 绿
  if (confirmerOpenid) {
    await writeRecalced(match._id, CELL_STATUS.CONFIRMED)
    return CELL_STATUS.CONFIRMED;
  }

  const declined = await countDeclinedUsers(match._id);
  const total = await countTeamManager(match.teamId);

  // 规则2：全员没空 → 红
  if(total > 0 && declined >= total) {
    await writeRecalced(match._id, CELL_STATUS.HELP);
    return CELL_STATUS.HELP;
  }

  // 规则3：临期无人确认 → 红
  if(match.matchTime - now < HOURS.FORCE_RED * 3600 * 1000) {
    await writeRecalced(match._id, CELL_STATUS.HELP);
    return CELL_STATUS.HELP;
  }

  // 其余 → 黄
  await writeRecalced(match._id, CELL_STATUS.PENDING);
  return CELL_STATUS.PENDING;
}

// 重算结果写回 MatchCollection：更新 cellStatus + updatedAt
// （读时重算与写后重算共用，保证库内状态与裁决结果一致）
async function writeRecalced(matchId, cellStatus) {
  await db.collection("MatchCollection").doc(matchId).update({
    data: { cellStatus, updatedAt: Date.now() },
  })
}

// 表态留痕（upsert）：一人一场至多一条有效记录——
// 前提：DutyRecordCollection 已建 matchId+openid 联合唯一索引（控制台索引管理，勾选"唯一"）
// 收敛写法：先条件更新（多数路径，天然幂等）；0 条说明无记录 → 新增；
// 新增撞唯一索引（并发双写）→ 降级再覆盖一次，最终仍收敛为一条。
// 读侧 getMyLatestType / countDeclinedUsers 的直查直计均依赖此约束。
async function upsertDutyRecord(match, user, type) {
  const coll = db.collection("DutyRecordCollection");
  const where = { matchId: match._id, openid: user.openid };
  const patch = { type, updatedAt: Date.now() };

  // ① 存在即改，消掉"先查后写"的竞态窗口
  const upd = await coll.where(where).update({ data: patch });
  if (upd.stats && upd.stats.updated > 0) return;

  // ② 无记录 → 新增；并发抢先插入撞唯一索引 → 再覆盖一次兜底
  try {
    await coll.add({
      data: {
        matchId: match._id,
        matchTime: match.matchTime,
        teamId: match.teamId,
        openid: user.openid,
        nickname: user.nickname,
        type,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
  } catch (e) {
    console.warn("[upsertDutyRecord] add 冲突，降级为更新", e);
    const retry = await coll.where(where).update({ data: patch });
    if (!retry.stats || retry.stats.updated === 0) {
      throw e; // 记录确实不存在 → add 是真故障，抛给外层返回 500，用户重试，绝不静默丢
    }
  }
}

