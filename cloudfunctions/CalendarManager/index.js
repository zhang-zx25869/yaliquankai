const cloud = require("wx-server-sdk");
const { toMatchDTO } = require("./dto");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const command = db.command;
const PAGE_SIZE = 100;
const ok = (data) => ({ code: 0, data });
const fail = (code, message) => ({ code, message });
const validTimestamp = (value) => Number.isSafeInteger(value) && !Number.isNaN(new Date(value).getTime());

async function readAll(collection, filter, ordering) {
  const records = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = db.collection(collection).where(filter);
    for (const [field, direction] of ordering) query = query.orderBy(field, direction);
    const { data } = await query.skip(offset).limit(PAGE_SIZE).get();
    records.push(...data);
    if (data.length < PAGE_SIZE) return records;
  }
}

async function publicMatches(matches) {
  const ids = matches.filter((match) => match.isArchived === true).map((match) => match._id);
  const archives = new Map();
  // 批量取归档，避免列表每场发一次查询；只读取本次公开比赛需要的记录。
  for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
    const records = await readAll("ArchiveCollection", {
      matchId: command.in(ids.slice(offset, offset + PAGE_SIZE)),
    }, [["_id", "asc"]]);
    for (const archive of records) {
      if (archives.has(archive.matchId)) throw new Error("比赛归档记录重复");
      archives.set(archive.matchId, archive);
    }
  }
  return matches.map((match) => toMatchDTO(match, archives.get(match._id)));
}

exports.main = async (event = {}) => {
  try {
    // 公开只读接口无需绑定身份；不读取 UserCollection，也不接受调用者身份字段。
    switch (event && event.action) {
      case "getCalendar": {
        const { fromTs, toTs } = event;
        if (!validTimestamp(fromTs) || !validTimestamp(toTs) || fromTs >= toTs) {
          return fail(400, "请提供有效的开始和结束时间范围");
        }
        // 半开区间 [fromTs, toTs)，相邻日期窗口不会重复包含边界比赛。
        const [matches, tbdMatches] = await Promise.all([
          readAll("MatchCollection", {
            isTbd: command.neq(true), matchTime: command.gte(fromTs).and(command.lt(toTs)),
          }, [["matchTime", "asc"], ["_id", "asc"]]),
          readAll("MatchCollection", {
            isTbd: true, isArchived: command.neq(true), cellStatus: command.neq("cancelled"),
          }, [["updatedAt", "desc"], ["_id", "asc"]]),
        ]);
        return ok({ matches: await publicMatches(matches), tbdMatches: tbdMatches.map((match) => toMatchDTO(match)) });
      }
      case "getMatchDetail": {
        if (typeof event.matchId !== "string" || !event.matchId.trim()) return fail(400, "请提供有效的比赛 ID");
        const { data } = await db.collection("MatchCollection").where({ _id: event.matchId }).limit(1).get();
        if (!data.length) return fail(404, "比赛不存在");
        return ok({ match: (await publicMatches(data))[0] });
      }
      default:
        return fail(400, "未知操作");
    }
  } catch (error) {
    console.error("[CalendarManager]", error);
    return fail(500, "服务器开小差了");
  }
};
