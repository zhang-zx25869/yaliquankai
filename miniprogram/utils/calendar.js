const { dateTimeFields, toTimestamp } = require("./schedule-form");
const DAY = 24 * 60 * 60 * 1000;

function shiftMonth(month, offset) {
  const [year, number] = month.split("-").map(Number);
  return dateTimeFields(Date.UTC(year, number - 1 + offset, 1)).date.slice(0, 7);
}

function calendarView(mode, selectedDate, now = Date.now()) {
  const today = dateTimeFields(now).date;
  const date = mode === "upcoming" ? today : selectedDate;
  if (!Number.isFinite(toTimestamp(date, "00:00"))) throw new Error("无效日期");
  const month = date.slice(0, 7);
  const fromTs = toTimestamp(mode === "month" ? `${month}-01` : date, "00:00");
  const toTs = mode === "day" ? fromTs + DAY : toTimestamp(`${shiftMonth(month, 1)}-01`, "00:00");
  const first = new Date(`${month}-01T00:00:00Z`);
  const count = new Date(`${shiftMonth(month, 1)}-01T00:00:00Z`).getTime() - first.getTime();
  const days = Array.from({ length: first.getUTCDay() }, (_, index) => ({ key: `blank-${index}`, day: "" }));
  for (let day = 1; day <= count / DAY; day += 1) {
    const key = `${month}-${String(day).padStart(2, "0")}`;
    days.push({ key, day, today: key === today, selected: mode === "day" && key === date,
      inRange: mode === "month" || (mode === "upcoming" && key >= today) });
  }
  return { mode, selectedDate: date, month, days, fromTs, toTs,
    rangeLabel: mode === "upcoming" ? `${today} 起至本月底` : mode === "month" ? `${month} 全月` : date };
}

module.exports = { calendarView, shiftMonth };
