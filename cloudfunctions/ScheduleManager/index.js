// 赛程管理：队长查询、编辑原始数据与新建；修改、分享和取消按后续排期实现。
const cloud = require("wx-server-sdk");
const { createHash } = require("crypto");
const { toScheduleSummaryDTO, toScheduleEditDTO } = require("./dto");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const ACTION = Object.freeze({
  GET_MY_MATCHES: "getMyMatches",
  GET_MATCH_FOR_EDIT: "getMatchForEdit",
  SAVE_MATCH: "saveMatch",
  GET_SHARE_CARD: "getShareCard",
  CANCEL_MATCH: "cancelMatch",
});
const CELL_STATUS = Object.freeze({
  PENDING: "pending", CONFIRMED: "confirmed", HELP: "help", SETTLE: "settle",
  TBD: "tbd", CANCELLED: "cancelled", DUTY_CANCELLED: "dutyCancelled",
});
const ROLE = Object.freeze({ GUEST: "guest", CAPTAIN: "captain", MEMBER: "member", ADMIN: "admin" });
const FORCE_RED_MS = 48 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const ok = (data) => ({ code: 0, data });
const fail = (code, message) => ({ code, message });
const notImplemented = (action) => fail(501, `${action} 开发中`);

class ScheduleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ScheduleError";
    this.code = code;
  }
}
const isNonemptyString = (value) => typeof value === "string" && value.trim().length > 0;
const documentData = (result) => Array.isArray(result.data) ? result.data[0] : result.data;

function checkCaptainTeam(user, team) {
  if (!user || user.role === ROLE.GUEST) throw new ScheduleError(401, "请先绑定队长身份");
  if (user.role !== ROLE.CAPTAIN) throw new ScheduleError(403, "仅队长可管理赛程");
  if (!isNonemptyString(user.teamId) || !team || team._id !== user.teamId || team.enabled !== true) {
    throw new ScheduleError(403, "队伍不存在或未启用，请联系管理员");
  }
  if (!isNonemptyString(team.teamName)) throw new ScheduleError(500, "队伍数据异常，请联系管理员");
}

// 身份与队伍只从云端推导，绝不接受 event 中的 openid/role/teamId/teamName。
async function requireCaptain(openid) {
  if (!isNonemptyString(openid)) throw new ScheduleError(401, "请先绑定队长身份");
  const userResult = await db.collection("UserCollection").where({ openid }).limit(2).get();
  if (userResult.data.length === 0) throw new ScheduleError(401, "请先绑定队长身份");
  if (userResult.data.length > 1) throw new ScheduleError(500, "身份数据异常，请联系管理员");
  const user = userResult.data[0];
  if (user.role === ROLE.GUEST) throw new ScheduleError(401, "请先绑定队长身份");
  if (user.role !== ROLE.CAPTAIN) throw new ScheduleError(403, "仅队长可管理赛程");
  if (!isNonemptyString(user.teamId)) throw new ScheduleError(403, "未绑定有效队伍，请联系管理员");
  const teamResult = await db.collection("TeamCollection").where({ _id: user.teamId }).limit(1).get();
  const team = teamResult.data[0];
  checkCaptainTeam(user, team);
  return { user, team };
}

async function requireOwnMatch(teamId, matchId) {
  if (!isNonemptyString(matchId)) throw new ScheduleError(400, "请提供有效的比赛 ID");
  const result = await db.collection("MatchCollection").where({ _id: matchId }).limit(1).get();
  const match = result.data[0];
  if (!match) throw new ScheduleError(404, "比赛不存在");
  // 同队队长可接手已有赛程，权限不依赖最初发布者 captainOpenid。
  if (match.teamId !== teamId) throw new ScheduleError(403, "只能管理本队赛程");
  return match;
}

async function getMyMatches(teamId) {
  const list = [];
  // 不依赖云端默认的单次查询上限；已取消项保留，归档项排除。
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const result = await db.collection("MatchCollection").where({ teamId })
      .orderBy("updatedAt", "desc").orderBy("_id", "asc").skip(offset).limit(PAGE_SIZE).get();
    list.push(...result.data.filter((match) => match.isArchived !== true).map(toScheduleSummaryDTO));
    if (result.data.length < PAGE_SIZE) break;
  }
  return ok({ list });
}

function validateNewMatch(event, now) {
  const fields = {};
  for (const [field, label] of [["sport", "比赛项目"], ["rival", "对手"], ["location", "比赛地点"]]) {
    if (!isNonemptyString(event[field])) throw new ScheduleError(400, `请填写${label}`);
    fields[field] = event[field].trim();
  }
  if (typeof event.isTbd !== "boolean") throw new ScheduleError(400, "请选择是否时间待定");
  if (!Array.isArray(event.demands) || event.demands.some((item) => !isNonemptyString(item))) {
    throw new ScheduleError(400, "后勤需求必须是有效的字符串数组");
  }
  fields.demands = [...new Set(event.demands.map((item) => item.trim()))];
  fields.isTbd = event.isTbd;
  if (event.isTbd) {
    fields.matchTime = null;
    fields.endTime = null;
  } else {
    const validTimestamp = (value) => Number.isSafeInteger(value) && !Number.isNaN(new Date(value).getTime());
    if (!validTimestamp(event.matchTime) || !validTimestamp(event.endTime)) {
      throw new ScheduleError(400, "开始和结束时间必须是有效的毫秒时间戳");
    }
    if (!(now < event.matchTime && event.matchTime < event.endTime)) {
      throw new ScheduleError(400, "开始时间须晚于当前时间，结束时间须晚于开始时间");
    }
    fields.matchTime = event.matchTime;
    fields.endTime = event.endTime;
  }
  return fields;
}

async function findCreateRequest(requestId) {
  const result = await db.collection("MatchCollection").where({ createRequestId: requestId }).limit(2).get();
  if (result.data.length > 1) throw new ScheduleError(500, "赛程幂等数据异常，请联系管理员");
  return result.data[0];
}

function createResult(match, openid, teamId) {
  if (match.captainOpenid !== openid || match.teamId !== teamId) {
    throw new ScheduleError(409, "保存请求已被使用，请重新提交");
  }
  return ok({ matchId: match._id, cellStatus: match.cellStatus, version: match.version });
}

async function createMatch(openid, identity, event) {
  if (!isNonemptyString(event.requestId)) throw new ScheduleError(400, "缺少保存请求标识，请重试");
  if (event.version !== undefined) throw new ScheduleError(400, "新建赛程不应携带版本号");
  const requestId = event.requestId.trim();
  const existing = await findCreateRequest(requestId);
  // 先处理重试，已成功的新建请求即使过了开赛时间也不重复创建。
  if (existing) return createResult(existing, openid, identity.team._id);
  const fields = validateNewMatch(event, Date.now());
  // 确定性文档 ID 兜底并发重试；部署时仍须建立 createRequestId 唯一索引。
  const matchId = createHash("sha256").update("schedule-create:" + requestId).digest("hex").slice(0, 32);
  try {
    return await db.runTransaction(async (transaction) => {
      const user = documentData(await transaction.collection("UserCollection").doc(identity.user._id).get());
      const team = documentData(await transaction.collection("TeamCollection").doc(identity.team._id).get());
      if (!user || user.openid !== openid) throw new ScheduleError(401, "身份已变化，请重新登录");
      checkCaptainTeam(user, team);
      const now = Date.now();
      // 事务排队期间时间可能已过期，写入前再次校验。
      validateNewMatch(event, now);
      const cellStatus = fields.isTbd ? CELL_STATUS.TBD
        : fields.matchTime - now < FORCE_RED_MS ? CELL_STATUS.HELP : CELL_STATUS.PENDING;
      const record = {
        _id: matchId, ...fields,
        teamId: team._id, teamName: team.teamName, captainOpenid: openid,
        cellStatus, dutyRevision: 1, version: 1,
        createRequestId: requestId, lastRequestId: requestId,
        isArchived: false, createdAt: now, updatedAt: now,
      };
      await transaction.collection("MatchCollection").add({ data: record });
      return ok({ matchId, cellStatus, version: 1 });
    });
  } catch (error) {
    if (error instanceof ScheduleError) throw error;
    // 另一并发重试可能已经提交；重新查重，禁止把任意 SDK 错误当业务错误。
    const committed = await findCreateRequest(requestId);
    if (committed) return createResult(committed, openid, identity.team._id);
    throw error;
  }
}

exports.main = async (event = {}) => {
  try {
    const action = event && event.action;
    if (!Object.values(ACTION).includes(action)) return fail(400, "未知操作");
    console.log("[ScheduleManager]", action);
    const { OPENID } = cloud.getWXContext();
    const identity = await requireCaptain(OPENID);
    const { team } = identity;
    switch (action) {
      case ACTION.GET_MY_MATCHES:
        return await getMyMatches(team._id);
      case ACTION.GET_MATCH_FOR_EDIT:
        return ok({ match: toScheduleEditDTO(await requireOwnMatch(team._id, event.matchId)) });
      case ACTION.SAVE_MATCH:
        if (event.matchId !== undefined) {
          await requireOwnMatch(team._id, event.matchId);
          return notImplemented(action);
        }
        return await createMatch(OPENID, identity, event);
      case ACTION.GET_SHARE_CARD:
      case ACTION.CANCEL_MATCH:
        await requireOwnMatch(team._id, event.matchId);
        return notImplemented(action);
      default:
        return fail(400, "未知操作");
    }
  } catch (error) {
    if (error instanceof ScheduleError) return fail(error.code, error.message);
    console.error("[ScheduleManager]", error);
    return fail(500, "服务器开小差了");
  }
};

exports.__test__ = Object.freeze({
  ACTION, CELL_STATUS, ROLE, ok, fail, requireCaptain, requireOwnMatch,
});
