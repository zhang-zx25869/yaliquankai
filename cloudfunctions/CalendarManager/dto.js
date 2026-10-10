// 随 CalendarManager 独立部署，不跨目录依赖其他云函数。
const formatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function toMatchDTO(match, archive) {
  const dto = {};
  // 白名单字段还需限制类型，避免异常嵌套对象带出身份信息。
  for (const key of ["_id", "teamId", "teamName", "sport", "rival", "location", "cellStatus"]) {
    if (typeof match[key] !== "string") throw new TypeError(`无效的比赛字段：${key}`);
    dto[key] = match[key];
  }
  dto.isTbd = match.isTbd === true;
  dto.isArchived = match.isArchived === true;
  for (const key of ["matchTime", "endTime"]) {
    const value = match[key];
    if (!dto.isTbd && (!Number.isSafeInteger(value) || Number.isNaN(new Date(value).getTime()))) {
      throw new TypeError("无效的比赛时间");
    }
    dto[key] = dto.isTbd ? null : value;
  }
  if (!Array.isArray(match.demands) || match.demands.some((item) => typeof item !== "string")) {
    throw new TypeError("无效的后勤需求");
  }
  dto.demands = [...match.demands];
  dto.demandsText = dto.demands.join("、");
  dto.timeText = "时间待定";
  if (!dto.isTbd) {
    const parts = formatter.formatToParts(new Date(dto.matchTime));
    const part = (type) => parts.find((item) => item.type === type).value;
    dto.timeText = `${part("month")}月${part("day")}日 ${part("hour")}:${part("minute")}`;
  }
  if (typeof match.confirmerNickname === "string") dto.confirmerNickname = match.confirmerNickname;
  if (dto.isArchived) {
    if (archive && typeof archive.score === "string") dto.score = archive.score;
    if (archive && typeof archive.result === "string") dto.result = archive.result;
    dto.hasMedia = Boolean(archive && typeof archive.mediaLink === "string" && archive.mediaLink.trim());
  }
  return dto;
}

module.exports = { toMatchDTO };
