// cloudfunctions/ScheduleManager/index.js
// 控制类：赛程管理（对应用例3/4/5）—— A同学赛程线
// Day 2 契约骨架：action 已登记，业务逻辑从 Day 3 起逐步实装。

const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

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

exports.main = async (event = {}) => {
  const { action } = event;
  console.log("[ScheduleManager]", action, event);

  try {
    cloud.getWXContext();

    switch (action) {
      case ACTION.GET_MY_MATCHES:
      case ACTION.GET_MATCH_FOR_EDIT:
      case ACTION.SAVE_MATCH:
      case ACTION.GET_SHARE_CARD:
      case ACTION.CANCEL_MATCH:
        return notImplemented(action);
      default:
        return fail(400, "未知操作");
    }
  } catch (error) {
    console.error("[ScheduleManager]", error);
    return fail(500, "服务器开小差了");
  }
};

// 仅供本地单元测试核对契约；对象均冻结，业务代码不得在运行时修改。
exports.__test__ = Object.freeze({ ACTION, CELL_STATUS, ROLE, ok, fail });
