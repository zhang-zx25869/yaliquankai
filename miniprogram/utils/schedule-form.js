// 表单日期按上海时区转换，避免手机时区影响提交的毫秒时间戳。
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;
const pad = (value) => String(value).padStart(2, "0");

function dateTimeFields(timestamp) {
  const date = new Date(timestamp + SHANGHAI_OFFSET);
  return {
    date: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    time: `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`,
  };
}

function toTimestamp(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return NaN;
  const timestamp = Date.parse(`${date}T${time}:00+08:00`);
  if (!Number.isFinite(timestamp)) return NaN;
  const actual = dateTimeFields(timestamp);
  return actual.date === date && actual.time === time ? timestamp : NaN;
}

function buildCreatePayload(form, now = Date.now()) {
  const payload = {};
  for (const [field, label] of [["sport", "比赛项目"], ["rival", "对手"], ["location", "比赛地点"]]) {
    if (typeof form[field] !== "string" || !form[field].trim()) throw new Error(`请填写${label}`);
    payload[field] = form[field].trim();
  }
  if (typeof form.isTbd !== "boolean") throw new Error("请选择是否时间待定");
  if (!Array.isArray(form.demands) || form.demands.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("请选择有效的后勤需求");
  }
  payload.demands = [...new Set(form.demands.map((item) => item.trim()))];
  payload.isTbd = form.isTbd;
  payload.matchTime = form.isTbd ? null : toTimestamp(form.startDate, form.startTime);
  payload.endTime = form.isTbd ? null : toTimestamp(form.endDate, form.endTime);
  if (!form.isTbd) {
    if (!Number.isFinite(payload.matchTime) || !Number.isFinite(payload.endTime)) {
      throw new Error("请选择完整的开始和结束时间");
    }
    if (payload.matchTime <= now) throw new Error("开始时间须晚于当前时间");
    if (payload.endTime <= payload.matchTime) throw new Error("结束时间须晚于开始时间");
  }
  return payload;
}

function createRequestId() {
  const random = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join("");
  return `schedule-${Date.now().toString(36)}-${random}`;
}

module.exports = { dateTimeFields, toTimestamp, buildCreatePayload, createRequestId };
