// cloudfunctions/DashboardManager/index.js
// 控制类：看板与运营者裁决（对应用例13/14/15）—— C同学看板线
//
// action: getDashboard        —— 四色看板聚合：全部未销号比赛按「行=队伍 × 列=时间」组装，
//                                运营者附带 canManage 标记（用例13）
// action: forceCancelDuty     —— 强制取消跟场：终止跟场/求助，置灰 dutyCancelled（用例14）
// action: manualResetStatus   —— 手动修改跟场状态：重置为黄 / 指派跟场人置绿（用例15）

const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 单元格状态（与 miniprogram/utils/status.js 同值；接口约定第四节为最终契约。
// 云函数部署包不能引用小程序目录，须在函数入口声明同值的冻结常量）
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
  FORCE_RED: 48, // 赛前 48h 无人确认强制拉红（与 DutyManager.recalcCellStatus 同规则）
});

// 进行中的跟场状态：强制取消 / 手动重置允许操作的来源集合
const ACTIVE_DUTY = Object.freeze([
  CELL_STATUS.PENDING, CELL_STATUS.CONFIRMED, CELL_STATUS.HELP,
]);

// 统一返回格式：{ code: 0, data } 成功；{ code: 非0, message } 失败
const ok = (data) => ({ code: 0, data });
const fail = (code, message) => ({ code, message });

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext(); // 微信自动注入操作者对应编号
  const { action } = event;

  console.log("[DashboardManager]", action, event);

  try {
    switch (action) {
      case "getDashboard":
        return await getDashboard(OPENID);
      case "forceCancelDuty":
        return await forceCancelDuty(OPENID, event);
      case "manualResetStatus":
        return await manualResetStatus(OPENID, event);
      default:
        return fail(400, "未知操作");
    }
  } catch (e) {
    console.error("[DashboardManager]", e);
    return fail(500, "服务器开小差了");
  }
};


// ─────────────────────────────────────────────
// 通用工具函数：身份校验 / 脱敏 DTO / 时间格式化
// （与 DutyManager 同名函数保持一致，改动须两处同步）
// ─────────────────────────────────────────────

// 按 OPENID 查 UserCollection 拿身份；查不到视为游客。
// 身份一律以云端查询为准，绝不信任前端传入的 role/teamId（接口约定 8.2）
async function getUserByOpenid(openid) {
  if (!openid) return null;
  const res = await db.collection("UserCollection").where({ openid }).limit(1).get();
  return res.data[0] || null;
}

// 时间戳 → 中文时间串（如 "8月26日 15:00"）；timeText 由云端统一格式化，前端不重复实现
function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Match 记录 → 脱敏 MatchDTO：
// 剔除 captainOpenid / confirmerOpenid 等所有 openid 字段（接口约定 8.2）
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
  if (!matchId) return { error: fail(400, "缺少比赛参数") };
  const res = await db.collection("MatchCollection").doc(matchId).get().catch(() => null);
  if (!res || !res.data) return { error: fail(404, "比赛不存在") };
  return { match: res.data };
}


// ─────────────────────────────────────────────
// C 线守卫
// ─────────────────────────────────────────────

// 看板对所有已绑定身份开放（队长/部员/运营者，需求文档用例13），仅拒游客。
// 注意不能复用 DutyManager 的 requireMember——那会把队长判 403。
function requireBoundUser(user) {
  if (!user) return fail(401, "请先绑定身份");
  return null;
}

// 运营者守卫：裁决类操作仅 admin（用例14/15）
function requireAdmin(user) {
  if (!user) return fail(401, "请先绑定身份");
  if (user.role !== ROLE.ADMIN) return fail(403, "仅运营者可执行此操作");
  return null;
}


// ─────────────────────────────────────────────
// 看板数据装载 + 读时兜底
// ─────────────────────────────────────────────

// 纵轴队伍名册：TeamCollection enabled 项按 sortOrder 升序。
// 集合尚无数据/不存在时不阻塞看板，返回空名册（有比赛的队仍会以兜底行出现）
async function loadTeams() {
  try {
    const res = await db.collection("TeamCollection")
      .where({ enabled: true })
      .orderBy("sortOrder", "asc")
      .limit(100) // 服务端 get 默认仅返回 100 条，显式放宽
      .get();
    return res.data || [];
  } catch (e) {
    console.warn("[DashboardManager] TeamCollection 读取失败，按空名册处理", e);
    return [];
  }
}

// 全部未销号比赛（getDashboard 的数据源，对应用例13 的 queryActiveMatches）
async function loadActiveMatches() {
  const res = await db.collection("MatchCollection")
    .where({
      isArchived: _.or([_.eq(false), _.exists(false)]), // 字段可能不存在，兼容写法
    })
    .limit(1000) // 服务端 get 默认仅返回 100 条，显式放宽（看板为全量聚合）
    .get();
  return res.data || [];
}

// 读时兜底裁决（纯函数，供单测；与 TimerChecker.isEndedForSettle / isOverdueForHelp 同规则）：
//   ① 已到预定结束时间（endTime，settle 判据）→ 橙，pending/confirmed/help 均适用
//   ② 黄态且无人确认且临期（<48h）→ 红（与 recalcCellStatus 规则3 一致）
// 其余情况返回 null 表示维持现状；tbd/cancelled/dutyCancelled/settle 不参与（调用方 where 已过滤）
function decideFallbackStatus(match, now) {
  const inProgress = [CELL_STATUS.PENDING, CELL_STATUS.CONFIRMED, CELL_STATUS.HELP]
    .includes(match.cellStatus);
  if (inProgress && match.endTime && match.endTime <= now) {
    return CELL_STATUS.SETTLE;
  }
  if (
    match.cellStatus === CELL_STATUS.PENDING
    && !match.confirmerOpenid
    && match.matchTime
    && match.matchTime - now < HOURS.FORCE_RED * 3600 * 1000
  ) {
    return CELL_STATUS.HELP;
  }
  return null;
}

// 读时兜底（消除 TimerChecker 每小时巡检之间的最多 1 小时状态延迟窗口，接口约定 8.3）：
// 两条批量条件更新（不逐场 count，保证看板聚合性能）；where 自带状态条件，不会误伤终态。
// 先转橙再拉红：已到 endTime 的场先落 settle，自然退出拉红条件（decideFallbackStatus 同序）。
async function applyReadFallback(now) {
  try {
    await db.collection("MatchCollection")
      .where({
        cellStatus: _.in([CELL_STATUS.PENDING, CELL_STATUS.CONFIRMED, CELL_STATUS.HELP]),
        endTime: _.lte(now),
        isArchived: _.or([_.eq(false), _.exists(false)]),
      })
      .update({ data: { cellStatus: CELL_STATUS.SETTLE, updatedAt: now } });
  } catch (e) {
    console.warn("[DashboardManager] 读时兜底转橙失败", e);
  }
  try {
    await db.collection("MatchCollection")
      .where({
        cellStatus: CELL_STATUS.PENDING,
        confirmerOpenid: _.or([_.exists(false), _.eq("")]), // 无跟场人（含老数据空串）
        matchTime: _.lt(now + HOURS.FORCE_RED * 3600 * 1000), // null（TBD）不会被 _.lt 命中
        isArchived: _.or([_.eq(false), _.exists(false)]),
      })
      .update({ data: { cellStatus: CELL_STATUS.HELP, updatedAt: now } });
  } catch (e) {
    console.warn("[DashboardManager] 读时兜底拉红失败", e);
  }
}


// ─────────────────────────────────────────────
// action：getDashboard（用例13）
// ─────────────────────────────────────────────

// 出参：{ canManage, teams: [{ teamId, teamName, matches: [MatchDTO] }] }
// 行 = 体育代表队（名册在前，按 sortOrder；有比赛但不在名册的兜底行排最后），
// 行内场次按开赛时间升序（TBD 无时间，挂最后）。canManage 供前端渲染裁决按钮。
async function getDashboard(openid) {
  const user = await getUserByOpenid(openid);
  const guard = requireBoundUser(user);
  if (guard) return guard;

  const now = Date.now();
  await applyReadFallback(now);

  const teams = await loadTeams();
  const matches = await loadActiveMatches();

  // 行主序组装：名册顺序为骨架，逐场归行
  const rows = teams.map((t) => ({
    teamId: t._id,
    teamName: t.teamName || "未命名队伍",
    matches: [],
  }));
  const rowIndex = new Map(rows.map((r, i) => [r.teamId, i]));
  for (const m of matches) {
    let idx = rowIndex.get(m.teamId);
    if (idx === undefined) {
      idx = rows.length;
      rowIndex.set(m.teamId, idx);
      rows.push({ teamId: m.teamId, teamName: m.teamName || "未命名队伍", matches: [] });
    }
    rows[idx].matches.push(m);
  }

  // 行内排序 + 脱敏；无比赛的名册行保留（看板纵轴稳定，显示队伍名）
  for (const row of rows) {
    row.matches.sort((a, b) => (a.matchTime || Infinity) - (b.matchTime || Infinity));
    row.matches = row.matches.map(toDTO);
  }

  return ok({
    canManage: user.role === ROLE.ADMIN,
    teams: rows,
  });
}


// ─────────────────────────────────────────────
// action：forceCancelDuty（用例14）
// ─────────────────────────────────────────────

// 运营者对红/黄/绿态比赛强制取消跟场：置灰 dutyCancelled，
// 解除红色警报、退出 48h 巡检与求助流程；既有 DutyRecord 仅作审计留痕，不删不改。
async function forceCancelDuty(openid, event) {
  const user = await getUserByOpenid(openid);
  const guard = requireAdmin(user);
  if (guard) return guard;

  const { matchId } = event;
  const { match, error } = await getMatchById(matchId);
  if (error) return error;
  if (match.isArchived) return fail(409, "该场比赛已归档");
  if (!ACTIVE_DUTY.includes(match.cellStatus)) {
    return fail(409, "当前状态无需取消跟场");
  }

  // 条件更新防并发：状态已被抢先流转（如到点转橙）时 updated=0 → 重读区分提示
  const upd = await db.collection("MatchCollection")
    .where({ _id: matchId, cellStatus: _.in(ACTIVE_DUTY) })
    .update({
      data: {
        cellStatus: CELL_STATUS.DUTY_CANCELLED,
        confirmerOpenid: _.remove(),   // 清空当前跟场人快照
        confirmerNickname: _.remove(),
        confirmerType: _.remove(),
        updatedAt: Date.now(),
      },
    });
  if (!upd.stats || upd.stats.updated === 0) {
    return fail(409, "比赛状态已变化，请刷新后重试");
  }

  console.log("[DashboardManager] forceCancelDuty 留痕保留",
    matchId, "原状态:", match.cellStatus, "原跟场人:", match.confirmerNickname || "无");
  return ok({ cellStatus: CELL_STATUS.DUTY_CANCELLED });
}


// ─────────────────────────────────────────────
// action：manualResetStatus（用例15）
// ─────────────────────────────────────────────

// 运营者手动修改跟场状态，两个分支：
//   target=pending   → 重置为黄：清空跟场人快照（DutyRecord 保留留痕）；
//   target=confirmed → 指派跟场人：置绿 + confirmerType=assign + DutyRecord 留痕（联动 addConfirmation）。
// settle/cancelled/已归档为终态拒绝；tbd/dutyCancelled 允许（裁决前置态）。
// 注意：不递增 version（接口约定 8.1：B/C 的跟场状态流转不递增该字段）。
async function manualResetStatus(openid, event) {
  const user = await getUserByOpenid(openid);
  const guard = requireAdmin(user);
  if (guard) return guard;

  const { matchId, target, assignOpenid, assignNickname } = event;
  if (target !== CELL_STATUS.PENDING && target !== CELL_STATUS.CONFIRMED) {
    return fail(400, "无效的目标状态");
  }
  if (target === CELL_STATUS.CONFIRMED && !assignOpenid && !assignNickname) {
    return fail(400, "指派跟场人需提供部员昵称");
  }

  const { match, error } = await getMatchById(matchId);
  if (error) return error;
  if (match.isArchived) return fail(409, "该场比赛已归档");
  if (match.cellStatus === CELL_STATUS.SETTLE || match.cellStatus === CELL_STATUS.CANCELLED) {
    return fail(409, "该场比赛已完结，无法修改跟场状态");
  }

  // 可改写来源 = 全部非终态（终态已在上面拦截；条件更新再挡一次并发转橙/取消）
  const editableFrom = _.in([
    CELL_STATUS.PENDING, CELL_STATUS.CONFIRMED, CELL_STATUS.HELP,
    CELL_STATUS.TBD, CELL_STATUS.DUTY_CANCELLED,
  ]);

  if (target === CELL_STATUS.PENDING) {
    const upd = await db.collection("MatchCollection")
      .where({ _id: matchId, cellStatus: editableFrom })
      .update({
        data: {
          cellStatus: CELL_STATUS.PENDING,
          confirmerOpenid: _.remove(),
          confirmerNickname: _.remove(),
          confirmerType: _.remove(),
          updatedAt: Date.now(),
        },
      });
    if (!upd.stats || upd.stats.updated === 0) {
      return fail(409, "比赛状态已变化，请刷新后重试");
    }
    return ok({ cellStatus: CELL_STATUS.PENDING });
  }

  // target = confirmed：先解析被指派人（前端拿不到 openid，通常走昵称）
  const assignee = await resolveAssignee(match, { assignOpenid, assignNickname });
  if (assignee.error) return assignee.error;

  const upd = await db.collection("MatchCollection")
    .where({ _id: matchId, cellStatus: editableFrom })
    .update({
      data: {
        cellStatus: CELL_STATUS.CONFIRMED,
        confirmerOpenid: assignee.openid,
        confirmerNickname: assignee.nickname,
        confirmerType: DUTY_TYPE.ASSIGN, // 指派记录（用例15）
        updatedAt: Date.now(),
      },
    });
  if (!upd.stats || upd.stats.updated === 0) {
    return fail(409, "比赛状态已变化，请刷新后重试");
  }

  // 联动留痕：以 assign 类型写入 DutyRecord（一人一场至多一条，upsert 覆盖）
  await upsertDutyRecord(match, assignee, DUTY_TYPE.ASSIGN);
  return ok({ cellStatus: CELL_STATUS.CONFIRMED });
}

// 解析被指派人：assignOpenid 优先（契约入参）；缺省时按昵称精确匹配部员/运营者。
// 重名处理：先过滤本队 member，仍不唯一 → 400，绝不静默取第一个。
async function resolveAssignee(match, { assignOpenid, assignNickname }) {
  if (assignOpenid) {
    const u = await getUserByOpenid(assignOpenid);
    if (!u || (u.role !== ROLE.MEMBER && u.role !== ROLE.ADMIN)) {
      return { error: fail(400, "未找到该部员，请核对后重试") };
    }
    return { openid: u.openid, nickname: u.nickname };
  }

  const nickname = (assignNickname || "").trim();
  const res = await db.collection("UserCollection")
    .where({ nickname, role: _.in([ROLE.MEMBER, ROLE.ADMIN]) })
    .limit(100)
    .get();
  const users = res.data || [];
  if (users.length === 0) return { error: fail(400, "未找到该昵称的部员，请核对后重试") };
  if (users.length > 1) {
    const inTeam = users.filter((u) => u.teamId === match.teamId);
    if (inTeam.length !== 1) {
      return { error: fail(400, "该昵称对应多名部员，请改用完整昵称或联系管理员") };
    }
    return { openid: inTeam[0].openid, nickname: inTeam[0].nickname };
  }
  return { openid: users[0].openid, nickname: users[0].nickname };
}

// 表态留痕（upsert）：与 DutyManager.upsertDutyRecord 同规则——
// 依赖 DutyRecordCollection 的 matchId+openid 联合唯一索引，先更新后插入，冲突降级再更新。
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
    console.warn("[DashboardManager] upsertDutyRecord add 冲突，降级为更新", e);
    const retry = await coll.where(where).update({ data: patch });
    if (!retry.stats || retry.stats.updated === 0) {
      throw e; // 记录确实不存在 → add 是真故障，抛给外层返回 500，绝不静默丢
    }
  }
}

// 仅供本地单元测试核对契约；对象均冻结，业务代码不得在运行时修改。
exports.__test__ = Object.freeze({
  CELL_STATUS, ROLE, DUTY_TYPE, HOURS, ACTIVE_DUTY,
  ok, fail, formatTime, toDTO, decideFallbackStatus,
});
