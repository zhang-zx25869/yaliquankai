// cloudfunctions/ArchiveManager/index.js
// 控制类：赛后归档（对应用例11/12）—— C同学看板线
//
// action: submitArchive —— 提交赛果归档：
//   校验必填（比分/胜负）→ 校验提交人（本场跟场人）→ 校验状态（settle）
//   → 先锁 Match（isArchived=true 防重复归档）→ 写 ArchiveCollection → 返回 archiveId
//   归档后该场比赛从看板查询中排除（销号，用例11 第5步 closeCell）

const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 单元格状态（与 miniprogram/utils/status.js 同值；接口约定第四节为最终契约）
const CELL_STATUS = Object.freeze({
  PENDING: "pending",         // 黄色：待确认
  CONFIRMED: "confirmed",     // 绿色：已确认
  HELP: "help",               // 红色：求助中
  SETTLE: "settle",           // 橙色：待结算
  TBD: "tbd",                 // 灰色：时间待定挂起
  CANCELLED: "cancelled",     // 已取消
  DUTY_CANCELLED: "dutyCancelled", // 无需跟场（运营者强制取消）
});

// 用户角色（UserCollection.role 字段取值）
const ROLE = Object.freeze({
  GUEST: "guest",
  CAPTAIN: "captain",
  MEMBER: "member",
  ADMIN: "admin",
});

// 统一返回格式：{ code: 0, data } 成功；{ code: 非0, message } 失败
const ok = (data) => ({ code: 0, data });
const fail = (code, message) => ({ code, message });

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext(); // 微信自动注入操作者对应编号
  const { action } = event;

  console.log("[ArchiveManager]", action, event);

  try {
    switch (action) {
      case "submitArchive":
        return await submitArchive(OPENID, event);
      default:
        return fail(400, "未知操作");
    }
  } catch (e) {
    console.error("[ArchiveManager]", e);
    return fail(500, "服务器开小差了");
  }
};


// ─────────────────────────────────────────────
// 通用工具（与 DutyManager / DashboardManager 同名函数保持一致，改动须多处同步）
// ─────────────────────────────────────────────

// 按 OPENID 查 UserCollection 拿身份；查不到视为游客（接口约定 8.2）
async function getUserByOpenid(openid) {
  if (!openid) return null;
  const res = await db.collection("UserCollection").where({ openid }).limit(1).get();
  return res.data[0] || null;
}

// 查单场比赛；不存在 → 404
async function getMatchById(matchId) {
  if (!matchId) return { error: fail(400, "缺少比赛参数") };
  const res = await db.collection("MatchCollection").doc(matchId).get().catch(() => null);
  if (!res || !res.data) return { error: fail(404, "比赛不存在") };
  return { match: res.data };
}

// 归档入参规整（纯函数，供单测）：非字符串归一为空串并去首尾空白；
// 比分/胜负任一为空即 missing（用例11 第4步：必填项校验，文案与前端一致）
function normalizeArchiveInput({ score, result, mediaLink } = {}) {
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const normScore = str(score);
  const normResult = str(result);
  return {
    score: normScore,
    result: normResult,
    mediaLink: str(mediaLink), // 选填，可为空且不校验链接内容（用例12）
    missing: !normScore || !normResult,
  };
}


// ─────────────────────────────────────────────
// action：submitArchive（用例11/12）
// ─────────────────────────────────────────────

// 校验链（判序固定）：401 → 400 必填空 → 404 → 403 非本场跟场人 → 409 非 settle。
// 403 在 409 前：非跟场人探测不到比赛状态细节。
// 幂等闸门：先条件更新 Match（settle 且未归档 → isArchived=true），
// updated=0 即已被归档或状态已变 → 409，保证 ArchiveCollection 一场至多一条。
// 注意：归档线依赖 endTime、不受「已开赛硬禁」影响（接口约定 8.1），故不加 matchTime 拦截。
async function submitArchive(openid, event) {
  const user = await getUserByOpenid(openid);
  if (!user) return fail(401, "请先绑定身份");

  const { matchId } = event;
  const input = normalizeArchiveInput(event);
  if (!matchId) return fail(400, "缺少比赛参数");
  if (input.missing) return fail(400, "必填项未填写，无法提交");

  const { match, error } = await getMatchById(matchId);
  if (error) return error;

  // 403：仅本场跟场人可提交；无跟场人的比赛（熬到 settle 无人确认）仅运营者兜底，
  // 否则该场永远无人能归档（契约死锁补丁，已在群里同步）
  if (user.role !== ROLE.ADMIN) {
    if (!match.confirmerOpenid) {
      return fail(403, "本场无跟场人，仅运营者可提交赛果");
    }
    if (match.confirmerOpenid !== openid) {
      return fail(403, "仅本场跟场人可提交赛果");
    }
  }

  // 409：仅橙色（待结算）可归档
  if (match.cellStatus !== CELL_STATUS.SETTLE) {
    return fail(409, "比赛尚未结束，无法归档");
  }

  // 幂等闸门：条件更新先行，防止并发双写产生两条归档记录
  const now = Date.now();
  const upd = await db.collection("MatchCollection")
    .where({
      _id: matchId,
      cellStatus: CELL_STATUS.SETTLE,
      isArchived: _.or([_.eq(false), _.exists(false)]),
    })
    .update({
      data: {
        isArchived: true,   // 销号：从看板/我的跟场查询中排除（getDashboard / getMyDuties 均按此过滤）
        archivedAt: now,
        updatedAt: now,
      },
    });
  if (!upd.stats || upd.stats.updated === 0) {
    // 重读区分：已被归档 vs 状态被并发流转
    const fresh = await getMatchById(matchId);
    if (fresh.match && fresh.match.isArchived) return fail(409, "该场比赛已归档");
    return fail(409, "比赛状态已变化，请刷新后重试");
  }

  // 写归档记录（字段严格按分工.md 第六节 ArchiveCollection 约定）
  try {
    const added = await db.collection("ArchiveCollection").add({
      data: {
        matchId,
        teamId: match.teamId,
        teamName: match.teamName,
        sport: match.sport,
        rival: match.rival,
        score: input.score,
        result: input.result,
        mediaLink: input.mediaLink,
        submitterOpenid: openid,
        createdAt: now,
      },
    });
    return ok({ archiveId: added._id });
  } catch (e) {
    // 定向回补：归档记录写入失败时撤销本次销号（用 archivedAt 精确匹配，
    // 避免误清并发归档），返回 500 由用户重试
    console.error("[ArchiveManager] 归档记录写入失败，回补习号", e);
    await db.collection("MatchCollection")
      .where({ _id: matchId, archivedAt: now })
      .update({ data: { isArchived: _.remove(), archivedAt: _.remove() } })
      .catch(() => {});
    return fail(500, "服务器开小差了");
  }
}

// 仅供本地单元测试核对契约；对象均冻结，业务代码不得在运行时修改。
exports.__test__ = Object.freeze({
  CELL_STATUS, ROLE,
  ok, fail, normalizeArchiveInput,
});
