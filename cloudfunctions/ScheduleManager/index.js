// cloudfunctions/ScheduleManager/index.js
// 控制类：赛程管理（对应用例3/4/5）—— A同学赛程线
// Day 3：统一队长/队伍权限与比赛归属校验，业务 action 后续逐步实装。

const cloud = require("wx-server-sdk");

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
  PENDING: "pending",
  CONFIRMED: "confirmed",
  HELP: "help",
  SETTLE: "settle",
  TBD: "tbd",
  CANCELLED: "cancelled",
  DUTY_CANCELLED: "dutyCancelled",
});

const ROLE = Object.freeze({
  GUEST: "guest",
  CAPTAIN: "captain",
  MEMBER: "member",
  ADMIN: "admin",
});

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

// 身份与队伍只从云端推导，绝不接受 event 中的 openid/role/teamId/teamName。
async function requireCaptain(openid) {
  if (!isNonemptyString(openid)) {
    throw new ScheduleError(401, "请先绑定队长身份");
  }

  const userResult = await db.collection("UserCollection").where({ openid }).limit(2).get();
  if (userResult.data.length === 0) {
    throw new ScheduleError(401, "请先绑定队长身份");
  }
  if (userResult.data.length > 1) {
    throw new ScheduleError(500, "身份数据异常，请联系管理员");
  }
  const user = userResult.data[0];
  if (user.role === ROLE.GUEST) {
    throw new ScheduleError(401, "请先绑定队长身份");
  }
  if (user.role !== ROLE.CAPTAIN) {
    throw new ScheduleError(403, "仅队长可管理赛程");
  }
  if (!isNonemptyString(user.teamId)) {
    throw new ScheduleError(403, "未绑定有效队伍，请联系管理员");
  }

  const teamResult = await db.collection("TeamCollection")
    .where({ _id: user.teamId }).limit(1).get();
  const team = teamResult.data[0];
  if (!team || team.enabled !== true) {
    throw new ScheduleError(403, "队伍不存在或未启用，请联系管理员");
  }
  if (!isNonemptyString(team.teamName)) {
    throw new ScheduleError(500, "队伍数据异常，请联系管理员");
  }
  return { user, team };
}

async function requireOwnMatch(teamId, matchId) {
  if (!isNonemptyString(matchId)) {
    throw new ScheduleError(400, "请提供有效的比赛 ID");
  }
  const result = await db.collection("MatchCollection").where({ _id: matchId }).limit(1).get();
  const match = result.data[0];
  if (!match) throw new ScheduleError(404, "比赛不存在");
  // 同队队长可接手已有赛程，权限不依赖最初发布者 captainOpenid。
  if (match.teamId !== teamId) {
    throw new ScheduleError(403, "只能管理本队赛程");
  }
  return match;
}

exports.main = async (event = {}) => {
  try {
    const action = event && event.action;
    if (!Object.values(ACTION).includes(action)) return fail(400, "未知操作");
    console.log("[ScheduleManager]", action);

    const { OPENID } = cloud.getWXContext();
    const { team } = await requireCaptain(OPENID);

    switch (action) {
      case ACTION.GET_MY_MATCHES:
        return notImplemented(action);
      case ACTION.SAVE_MATCH:
        if (event.matchId !== undefined) await requireOwnMatch(team._id, event.matchId);
        return notImplemented(action);
      case ACTION.GET_MATCH_FOR_EDIT:
      case ACTION.GET_SHARE_CARD:
      case ACTION.CANCEL_MATCH:
        // 后续写 action 仍须在事务内重读并校验归属、状态与 version。
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

// 仅供本地单元测试核对契约；对象均冻结，业务代码不得在运行时修改。
exports.__test__ = Object.freeze({
  ACTION, CELL_STATUS, ROLE, ok, fail, requireCaptain, requireOwnMatch,
});
