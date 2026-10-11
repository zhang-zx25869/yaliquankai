const { createScheduleFlow } = require("./schedule-flow");
const NOW = Date.parse("2026-10-07T12:00:00+08:00");
const users = {
  a: { _id: "a", openid: "private-a", nickname: "甲", role: "member", teamId: "team-a" },
  b: { _id: "b", openid: "private-b", nickname: "乙", role: "member", teamId: "team-a" },
  other: { _id: "other", openid: "private-other", nickname: "外队", role: "member", teamId: "team-b" },
  admin: { _id: "admin", openid: "private-admin", nickname: "运营者", role: "admin", teamId: "team-b" },
};
function dutyFlow(options = {}) {
  const flow = createScheduleFlow(options);
  flow.rows.UserCollection.push(...Object.values(users).map((user) => ({ ...user })));
  flow.rows.MatchCollection.push({
    _id: "match-1", teamId: "team-a", teamName: "测试队", sport: "篮球", rival: "对手", location: "体育馆",
    demands: ["摄影"], cellStatus: "pending", matchTime: NOW + 72 * 3600000, endTime: NOW + 74 * 3600000,
    isTbd: false, isArchived: false, version: 1, dutyRevision: 1, updatedAt: 1,
  });
  flow.as = (name) => {
    const user = users[name];
    flow.setIdentity(user ? { role: user.role, teamId: user.teamId, nickname: user.nickname } : { role: "guest" }, user?.openid || "guest");
  };
  flow.invoke = (name, action, extra = {}) => {
    flow.as(name);
    return flow.api.call("DutyManager", { action, matchId: "match-1", ...extra });
  };
  flow.as("a");
  return flow;
}
module.exports = { dutyFlow, NOW, users };
