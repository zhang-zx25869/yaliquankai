// cloudfunctions/TeamManager/index.js
// 控制类：代表队栏目（对应用例19）—— 收尾阶段
//
// action: getTeamList     —— 全部启用代表队列表：[{ teamId, teamName, sport }]（游客可调）
// action: getTeamMatches  —— 按队检索：{ upcoming: [MatchDTO], archived: [MatchDTO] }
//   upcoming = 未归档比赛（含 TBD 末尾、含已取消只读），按 matchTime 升序；
//   archived = 已归档比赛（合并 ArchiveCollection 的比分/胜负/hasMedia），按 matchTime 降序。
// 公开只读接口：不读 UserCollection，DTO 全脱敏（无 openid、无 mediaLink）。

const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const command = db.command;
const { toMatchDTO } = require("./dto");

const PAGE_SIZE = 100;
const ok = (data) => ({ code: 0, data });
const fail = (code, message) => ({ code, message });

exports.main = async (event = {}) => {
  try {
    switch (event && event.action) {
      case "getTeamList":
        return ok({ teams: await getTeamList() });
      case "getTeamMatches":
        return await getTeamMatches(event);
      default:
        return fail(400, "未知操作");
    }
  } catch (error) {
    console.error("[TeamManager]", error);
    return fail(500, "服务器开小差了");
  }
};

// —— 用例19 第1步：全部代表队列表 ——
// 集合读取失败时降级为空列表，不阻塞公开栏目页（与 DashboardManager.loadTeams 同策略）。
async function getTeamList() {
  try {
    const res = await db.collection("TeamCollection")
      .where({ enabled: true })
      .orderBy("sortOrder", "asc")
      .limit(100) // 服务端 get 默认仅返回 100 条，显式放宽
      .get();
    return (res.data || []).map((team) => ({
      teamId: team._id,
      teamName: team.teamName,
      sport: team.sport,
    })).filter((team) => typeof team.teamName === "string" && typeof team.sport === "string");
  } catch (e) {
    console.warn("[TeamManager] TeamCollection 读取失败，按空名册处理", e);
    return [];
  }
}

// —— 用例19 第2-4步：按队检索并分类 ——
async function getTeamMatches(event) {
  if (typeof event.teamId !== "string" || !event.teamId.trim()) {
    return fail(400, "请提供有效的代表队 ID");
  }
  const teamId = event.teamId.trim();
  const matches = await readAll("MatchCollection", { teamId });
  // 未开始赛程：TBD（无时间）排末尾，其余按 matchTime 升序；已归档：最近在前。
  const upcoming = matches
    .filter((match) => match.isArchived !== true)
    .sort(compareUpcoming)
    .map((match) => toMatchDTO(match));
  const archivedMatches = matches.filter((match) => match.isArchived === true);
  const archives = await loadArchives(archivedMatches.map((match) => match._id));
  const archived = archivedMatches
    .sort((a, b) => (b.matchTime || 0) - (a.matchTime || 0))
    .map((match) => toMatchDTO(match, archives.get(match._id)));
  return ok({ upcoming, archived });
}

function compareUpcoming(a, b) {
  // TBD 的 matchTime 为 null，固定排在末尾；都为 TBD 时按更新时间倒序。
  if (a.isTbd && b.isTbd) return (b.updatedAt || 0) - (a.updatedAt || 0);
  if (a.isTbd) return 1;
  if (b.isTbd) return -1;
  return (a.matchTime || 0) - (b.matchTime || 0);
}

// 批量取归档记录；一场至多一条，重复即数据异常（与 CalendarManager.publicMatches 同策略）。
async function loadArchives(matchIds) {
  const archives = new Map();
  for (let offset = 0; offset < matchIds.length; offset += PAGE_SIZE) {
    const records = await readAll("ArchiveCollection", {
      matchId: command.in(matchIds.slice(offset, offset + PAGE_SIZE)),
    });
    for (const archive of records) {
      if (archives.has(archive.matchId)) throw new Error("比赛归档记录重复");
      archives.set(archive.matchId, archive);
    }
  }
  return archives;
}

// 不依赖云端默认的单次查询上限；列表级读取统一走这里（与 ScheduleManager.getMyMatches 同模式）。
async function readAll(name, filter) {
  const list = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const result = await db.collection(name).where(filter)
      .skip(offset).limit(PAGE_SIZE).get();
    list.push(...(result.data || []));
    if ((result.data || []).length < PAGE_SIZE) break;
  }
  return list;
}

// 仅供本地单元测试核对契约；对象均冻结，业务代码不得在运行时修改。
exports.__test__ = Object.freeze({
  ok, fail, toMatchDTO, compareUpcoming, readAll, loadArchives, getTeamList, getTeamMatches,
});
