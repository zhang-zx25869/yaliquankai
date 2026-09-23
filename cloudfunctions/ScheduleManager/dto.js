// 云函数部署包内的纯转换工具：显式白名单，禁止把数据库记录展开到返回值。
const shanghaiFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function formatMatchTime(matchTime, isTbd = false) {
  if (isTbd === true) return "时间待定";
  if (!Number.isSafeInteger(matchTime) || Number.isNaN(new Date(matchTime).getTime())) {
    throw new TypeError("比赛时间必须是有效的毫秒时间戳");
  }
  const parts = shanghaiFormatter.formatToParts(new Date(matchTime));
  const part = (type) => parts.find((value) => value.type === type).value;
  return `${part("month")}月${part("day")}日 ${part("hour")}:${part("minute")}`;
}

function copyDemands(demands = []) {
  if (!Array.isArray(demands) || demands.some((demand) => typeof demand !== "string")) {
    throw new TypeError("后勤需求必须是字符串数组");
  }
  return [...demands];
}

function toScheduleSummaryDTO(match) {
  return {
    _id: match._id,
    teamName: match.teamName,
    sport: match.sport,
    rival: match.rival,
    timeText: formatMatchTime(match.matchTime, match.isTbd),
    location: match.location,
    isTbd: match.isTbd === true,
    cellStatus: match.cellStatus,
    updatedAt: match.updatedAt,
    version: match.version,
  };
}

function toScheduleEditDTO(match) {
  return {
    _id: match._id,
    teamId: match.teamId,
    teamName: match.teamName,
    sport: match.sport,
    rival: match.rival,
    matchTime: match.isTbd === true ? null : match.matchTime,
    endTime: match.isTbd === true ? null : match.endTime,
    location: match.location,
    demands: copyDemands(match.demands),
    isTbd: match.isTbd === true,
    cellStatus: match.cellStatus,
    version: match.version,
  };
}

function toMatchDTO(match) {
  const demands = copyDemands(match.demands);
  const dto = {
    _id: match._id,
    teamId: match.teamId,
    teamName: match.teamName,
    sport: match.sport,
    rival: match.rival,
    matchTime: match.isTbd === true ? null : match.matchTime,
    endTime: match.isTbd === true ? null : match.endTime,
    location: match.location,
    demands,
    isTbd: match.isTbd === true,
    cellStatus: match.cellStatus,
    isArchived: match.isArchived === true,
    timeText: formatMatchTime(match.matchTime, match.isTbd),
    demandsText: demands.join("、"),
  };
  if (typeof match.confirmerNickname === "string") {
    dto.confirmerNickname = match.confirmerNickname;
  }
  return dto;
}

module.exports = Object.freeze({
  formatMatchTime, toScheduleSummaryDTO, toScheduleEditDTO, toMatchDTO,
});
