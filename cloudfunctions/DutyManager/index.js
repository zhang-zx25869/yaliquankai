// B 线跟场读取、事务表态与分享。
const cloud = require("wx-server-sdk");
const { createHash } = require("node:crypto");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const CELL_STATUS = Object.freeze({
  PENDING: "pending", CONFIRMED: "confirmed", HELP: "help", SETTLE: "settle",
  TBD: "tbd", CANCELLED: "cancelled", DUTY_CANCELLED: "dutyCancelled",
});
const ROLE = Object.freeze({ GUEST: "guest", CAPTAIN: "captain", MEMBER: "member", ADMIN: "admin" });
const DUTY_TYPE = Object.freeze({ CONFIRM: "confirm", DECLINE: "decline", RESCUE: "rescue", ASSIGN: "assign" });
const HOURS = Object.freeze({ FORCE_RED: 48 });
const ok = (data) => ({ code: 0, data });
const fail = (code, message) => ({ code, message });
const nonempty = (value) => typeof value === "string" && Boolean(value.trim());
const documentData = (result) => Array.isArray(result.data) ? result.data[0] : result.data;
class DutyError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
class RetryDuty extends Error {}
const reject = (result) => { if (result) throw new DutyError(result.code, result.message); };
const actions = ["getRespondPage", "getRescuePage", "getTeamStats", "confirmDuty", "declineDuty",
  "rescueDuty", "cancelMyDuty", "generateHelpCard", "getMyDuties"];

exports.main = async (event = {}) => {
  try {
    if (!event || !actions.includes(event.action)) return fail(400, "未知操作");
    const { OPENID } = cloud.getWXContext();
    if (!nonempty(OPENID)) return fail(401, "请先绑定身份");
    const user = await getUserByOpenid(OPENID);
    reject(requireMember(user));
    if (event.action === "getTeamStats") {
      if (!nonempty(user.teamId)) return fail(400, "缺少队伍参数");
      return ok({ stats: await buildTeamStats(user.teamId) });
    }
    if (event.action === "getMyDuties") return await getMyDuties(OPENID);
    if (!nonempty(event.matchId)) return fail(400, "缺少有效比赛参数");
    if (["confirmDuty", "declineDuty", "rescueDuty", "cancelMyDuty"].includes(event.action)) {
      return await mutateDuty(user, event);
    }
    let match = await readMatch(event.matchId);
    if (event.action !== "getRescuePage") reject(requireTeamManager(user, match));
    await recalcCellStatus(match);
    // 重算可能与队长修改交错，DTO、myStatus 和分享守卫统一使用最新快照。
    match = await readMatch(event.matchId);
    if (event.action !== "getRescuePage") reject(requireTeamManager(user, match));
    if (event.action === "generateHelpCard") {
      if (!canHelp(user, match)) return fail(409, "该比赛当前状态不允许求助分享");
      return ok({ title: `【跟场求助】${match.teamName} vs ${match.rival} ${formatTime(match.matchTime)}，希望有空的同学补位！`,
        path: `/pages/rescue/index?matchId=${encodeURIComponent(match._id)}` });
    }
    const myStatus = await getMyLatestType(match, OPENID);
    if (event.action === "getRescuePage") return ok({ match: toDTO(match), myStatus, canHelp: canHelp(user, match) });
    const [stats, total, declined] = await Promise.all([
      buildTeamStats(match.teamId), countTeamManager(match.teamId), countDeclinedUsers(match._id),
    ]);
    return ok({ match: toDTO(match), myStatus, stats,
      remainingCount: Math.max(0, total - declined), canHelp: canHelp(user, match) });
  } catch (error) {
    if (error instanceof DutyError) return fail(error.code, error.message);
    console.error("[DutyManager]", error);
    return fail(500, "服务器开小差了");
  }
};

async function getUserByOpenid(openid) {
  const { data } = await db.collection("UserCollection").where({ openid }).limit(2).get();
  if (data.length > 1) throw new DutyError(500, "身份数据异常，请联系管理员");
  return data[0];
}
function requireMember(user) {
  if (!user || user.role === ROLE.GUEST) return fail(401, "请先绑定身份");
  if (![ROLE.MEMBER, ROLE.ADMIN].includes(user.role)) return fail(403, "仅部员可执行此操作");
  return null;
}
function requireTeamManager(user, match) {
  const guard = requireMember(user);
  if (guard) return guard;
  if (user.role !== ROLE.ADMIN && (!nonempty(user.teamId) || user.teamId !== match.teamId)) {
    return fail(403, "仅本队经理人可操作本场跟场");
  }
  return null;
}
async function readMatch(id) {
  const data = documentData(await db.collection("MatchCollection").doc(id).get());
  if (!data) throw new DutyError(404, "比赛不存在");
  return data;
}
const formatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function formatTime(ts) {
  if (!Number.isSafeInteger(ts) || Number.isNaN(new Date(ts).getTime())) return "时间待定";
  const parts = formatter.formatToParts(new Date(ts));
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("month")}月${part("day")}日 ${part("hour")}:${part("minute")}`;
}
// 客户端确认基于自己看到的快照；不向 DTO 暴露版本号或身份字段。
function mutationToken(match) {
  return createHash("sha256").update(JSON.stringify([
    match._id, match.version, match.dutyRevision, match.dutyVersion || 0,
    match.matchTime, match.endTime, match.location, match.teamId, match.isTbd,
    match.isArchived, match.cellStatus, match.confirmerOpenid || "",
  ])).digest("hex");
}
function toDTO(match) {
  const dto = {};
  for (const key of ["_id", "teamId", "teamName", "sport", "rival", "location", "cellStatus", "confirmerNickname", "confirmerType"]) {
    dto[key] = typeof match[key] === "string" ? match[key] : "";
  }
  dto.dutyToken = mutationToken(match);
  dto.demands = Array.isArray(match.demands) ? match.demands.filter((item) => typeof item === "string") : [];
  dto.demandsText = dto.demands.join("、");
  dto.isTbd = match.isTbd === true;
  dto.isArchived = match.isArchived === true;
  dto.matchTime = !dto.isTbd && Number.isSafeInteger(match.matchTime) ? match.matchTime : null;
  dto.endTime = !dto.isTbd && Number.isSafeInteger(match.endTime) ? match.endTime : null;
  dto.timeText = dto.isTbd ? "时间待定" : formatTime(dto.matchTime);
  return dto;
}
function isTerminalStatus(status) {
  return [CELL_STATUS.TBD, CELL_STATUS.CANCELLED, CELL_STATUS.DUTY_CANCELLED, CELL_STATUS.SETTLE].includes(status);
}
function actionable(match) {
  return !match.isArchived && !match.isTbd && [CELL_STATUS.PENDING, CELL_STATUS.CONFIRMED, CELL_STATUS.HELP].includes(match.cellStatus)
    && Number.isFinite(match.matchTime) && match.matchTime > Date.now()
    && Number.isFinite(match.endTime) && match.endTime > Date.now();
}
function canHelp(user, match) {
  return actionable(match) && match.cellStatus === CELL_STATUS.HELP && !requireTeamManager(user, match);
}
async function countTeamManager(teamId) {
  if (!teamId) return 0;
  return (await db.collection("UserCollection").where({ teamId, role: ROLE.MEMBER }).count()).total || 0;
}
async function countDeclinedUsers(matchId) {
  return (await db.collection("DutyRecordCollection").where({ matchId, type: DUTY_TYPE.DECLINE }).count()).total || 0;
}
async function readOwnRecord(matchId, openid) {
  const { data } = await db.collection("DutyRecordCollection").where({ matchId, openid }).limit(2).get();
  if (data.length > 1) throw new DutyError(500, "跟场记录重复，请联系管理员");
  return data[0];
}
async function getMyLatestType(match, openid) {
  if (match.confirmerOpenid === openid && !match.isArchived && ![CELL_STATUS.CANCELLED, CELL_STATUS.DUTY_CANCELLED, CELL_STATUS.TBD].includes(match.cellStatus)) return "confirmed";
  return (await readOwnRecord(match._id, openid))?.type === DUTY_TYPE.DECLINE ? "declined" : "none";
}
async function readAll(name, filter, order = [["_id", "asc"]]) {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    let query = db.collection(name).where(filter);
    for (const [field, direction] of order) query = query.orderBy(field, direction);
    const { data } = await query.skip(offset).limit(100).get();
    rows.push(...data);
    if (data.length < 100) return rows;
  }
}
async function buildTeamStats(teamId) {
  const [users, records] = await Promise.all([
    readAll("UserCollection", { teamId, role: ROLE.MEMBER }),
    readAll("DutyRecordCollection", { teamId, type: _.in([DUTY_TYPE.CONFIRM, DUTY_TYPE.RESCUE, DUTY_TYPE.ASSIGN]) }),
  ]);
  const counts = new Map();
  for (const row of records) counts.set(row.openid, (counts.get(row.openid) || 0) + 1);
  return users.map((user) => ({ nickname: typeof user.nickname === "string" ? user.nickname : "", count: counts.get(user.openid) || 0 }));
}
async function getMyDuties(openid) {
  const rows = await readAll("MatchCollection", { confirmerOpenid: openid,
    cellStatus: _.in([CELL_STATUS.CONFIRMED, CELL_STATUS.SETTLE]), isArchived: _.neq(true),
  }, [["matchTime", "asc"], ["_id", "asc"]]);
  return ok({ list: rows.map(toDTO) });
}
function decideStatus(match, total, declined, now = Date.now()) {
  if (match.isArchived || isTerminalStatus(match.cellStatus)) return match.cellStatus;
  if (match.isTbd) return CELL_STATUS.TBD;
  if (Number.isFinite(match.endTime) && match.endTime <= now) return CELL_STATUS.SETTLE;
  if (match.confirmerOpenid) return CELL_STATUS.CONFIRMED;
  return (total > 0 && declined >= total) || match.matchTime - now < HOURS.FORCE_RED * 3600000
    ? CELL_STATUS.HELP : CELL_STATUS.PENDING;
}
async function recalcCellStatus(match) {
  const fresh = await readMatch(match._id);
  if (fresh.isArchived || isTerminalStatus(fresh.cellStatus)) return fresh.cellStatus;
  const [total, declined] = await Promise.all([countTeamManager(fresh.teamId), countDeclinedUsers(fresh._id)]);
  const cellStatus = decideStatus(fresh, total, declined);
  const guard = { _id: fresh._id };
  for (const field of ["version", "dutyRevision", "dutyVersion", "cellStatus", "confirmerOpenid", "updatedAt", "isArchived"]) {
    guard[field] = fresh[field] === undefined ? _.exists(false) : fresh[field];
  }
  const written = await db.collection("MatchCollection").where(guard).update({ data: { cellStatus, updatedAt: Date.now() } });
  return written.stats && written.stats.updated > 0 ? cellStatus : (await readMatch(match._id)).cellStatus;
}

// 聚合与旧留痕 ID 在事务外读取；事务只用 doc，重读身份/比赛/本人记录。
// dutyVersion 串行化 B 线表态，防止同毫秒的两次 decline 使用过期人数。
// 不递增 A 线 version，不对历史记录分代；旧随机 ID 原地更新，新记录用确定性 ID。
async function mutateDuty(identity, event) {
  const { action, matchId, requestId } = event;
  if (requestId !== undefined && (!nonempty(requestId) || requestId.length > 128)) throw new DutyError(400, "无效的请求标识");
  if (event.dutyToken !== undefined && (typeof event.dutyToken !== "string" || !/^[a-f0-9]{64}$/.test(event.dutyToken))) throw new DutyError(400, "无效的跟场状态标识");
  const basis = await readMatch(matchId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const original = await readMatch(matchId);
    const [existing, total, declined] = await Promise.all([
      readOwnRecord(matchId, identity.openid), countTeamManager(original.teamId), countDeclinedUsers(matchId),
    ]);
    const recordId = existing?._id || createHash("sha256").update(JSON.stringify([matchId, identity.openid])).digest("hex").slice(0, 32);
    try {
      return await db.runTransaction(async (tx) => {
        const user = documentData(await tx.collection("UserCollection").doc(identity._id).get());
        if (!user || user.openid !== identity.openid) throw new DutyError(401, "身份已变化，请重新登录");
        reject(requireMember(user));
        const matchRef = tx.collection("MatchCollection").doc(matchId);
        const match = documentData(await matchRef.get());
        if (!match) throw new DutyError(404, "比赛不存在");
        if (["confirmDuty", "declineDuty"].includes(action)) reject(requireTeamManager(user, match));
        const recordRef = tx.collection("DutyRecordCollection").doc(recordId);
        const record = documentData(await recordRef.get());
        if (record && (record.matchId !== matchId || record.openid !== user.openid)) throw new DutyError(500, "跟场记录异常");
        // 已提交的同一请求仅返回原结果，绝不重做取消或恢复旧确认。
        if (requestId && record?.lastRequestId === requestId) {
          if (record.lastAction !== action) throw new DutyError(409, "请求标识已被使用");
          return ok(record.lastResult);
        }
        if (event.dutyToken && event.dutyToken !== mutationToken(match)) throw new DutyError(409, "比赛信息或跟场状态已变化，请刷新后确认");
        if (!actionable(match)) throw new DutyError(409, "比赛已开始、结束或当前状态不可操作");
        for (const field of ["version", "dutyRevision", "matchTime", "endTime", "location", "teamId"]) {
          if (match[field] !== basis[field]) throw new DutyError(409, "赛程已变化，请刷新后确认");
        }
        const claim = action === "confirmDuty" || action === "rescueDuty";
        if (claim && match.confirmerOpenid && match.confirmerOpenid !== user.openid) throw new DutyError(409, "本场已有人跟场");
        if (claim && match.confirmerOpenid === user.openid) return ok({ cellStatus: CELL_STATUS.CONFIRMED });
        if (action === "cancelMyDuty" && match.confirmerOpenid !== user.openid) {
          if (record?.lastAction === action && record.type === DUTY_TYPE.DECLINE && !requestId) {
            return ok({ cellStatus: match.cellStatus, canHelp: canHelp(user, match) });
          }
          throw new DutyError(404, "你尚未确认本场跟场");
        }
        if ((match.dutyVersion || 0) !== (original.dutyVersion || 0)
          || match.updatedAt !== original.updatedAt || (record?.type || "") !== (existing?.type || "")) throw new RetryDuty();
        const currentStatus = decideStatus(match, total, declined);
        if (action === "rescueDuty" && currentStatus !== CELL_STATUS.HELP) throw new DutyError(409, "当前状态无法救场");
        if (action === "declineDuty" && (match.confirmerOpenid || currentStatus !== CELL_STATUS.PENDING)
          && !(record?.type === DUTY_TYPE.DECLINE && !match.confirmerOpenid)) {
          throw new DutyError(409, "仅待确认状态可表态没空");
        }
        const type = claim ? (action === "confirmDuty" ? DUTY_TYPE.CONFIRM : DUTY_TYPE.RESCUE) : DUTY_TYPE.DECLINE;
        const nextDeclined = declined - (record?.type === DUTY_TYPE.DECLINE ? 1 : 0) + (type === DUTY_TYPE.DECLINE ? 1 : 0);
        const patch = { updatedAt: Date.now(), dutyVersion: (match.dutyVersion || 0) + 1 };
        if (claim) Object.assign(patch, { confirmerOpenid: user.openid, confirmerNickname: user.nickname || "", confirmerType: type });
        if (action === "cancelMyDuty") Object.assign(patch, { confirmerOpenid: "", confirmerNickname: "", confirmerType: "" });
        // 从撤确认后的快照和最新人数重算，取消后的颜色不写死。
        const next = { ...match, ...patch };
        patch.cellStatus = decideStatus(next, total, nextDeclined);
        next.cellStatus = patch.cellStatus;
        const result = { cellStatus: next.cellStatus };
        if (!claim) result.canHelp = canHelp(user, next);
        if (action === "declineDuty") result.remainingCount = Math.max(0, total - nextDeclined);
        const recordPatch = {
          matchId, teamId: match.teamId, matchTime: match.matchTime, openid: user.openid,
          nickname: user.nickname || "", type, updatedAt: Date.now(),
          lastRequestId: requestId || "", lastAction: action, lastResult: result,
        };
        await matchRef.update({ data: patch });
        if (record) await recordRef.update({ data: recordPatch });
        else await tx.collection("DutyRecordCollection").add({ data: { _id: recordId, ...recordPatch, createdAt: Date.now() } });
        return ok(result);
      });
    } catch (error) {
      if (!(error instanceof RetryDuty)) throw error;
    }
  }
  throw new DutyError(409, "跟场状态已变化，请刷新后重试");
}
