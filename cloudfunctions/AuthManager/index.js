// cloudfunctions/AuthManager/index.js
// 控制类：身份认证（对应用例1 OpenIDLogin / 用例2 BindIdentity）
// action: autoLogin    —— 免密静默登录：openid 查身份，未绑定返回 guest
// action: bindIdentity —— 激活码绑定：校验激活码 → 绑定 openid → 作废激活码

const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 统一返回格式：{ code: 0, data } 成功；{ code: 非0, message } 失败
const ok = (data) => ({ code: 0, data });
const fail = (code, message) => ({ code, message });

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext(); // 微信自动注入，无法伪造
  const { action } = event;

  try {
    switch (action) {
      case "autoLogin":
        return await autoLogin(OPENID);
      case "bindIdentity":
        return await bindIdentity(OPENID, event);
      default:
        return fail(400, "未知操作");
    }
  } catch (e) {
    console.error("[AuthManager]", e);
    return fail(500, "服务器开小差了");
  }
};

// —— 用例1：免密自动登录 ——
// 前端启动时调用；返回 { role, nickname, teamId? } 或 guest
async function autoLogin(openid) {
  const res = await db.collection("UserCollection").where({ openid }).get();
  if (res.data.length === 0) {
    // 未绑定：以游客身份进入
    return ok({ role: "guest" });
  }
  const u = res.data[0];
  return ok({
    role: u.role,       // captain / member / admin
    nickname: u.nickname,
    teamId: u.teamId,   // 队长/部员所属代表队；运营者为 undefined
  });
}

// —— 用例2：一次性激活码绑定 ——
// event: { code } 激活码字符串
async function bindIdentity(openid, { code }) {
  if (!code) return fail(400, "请输入激活码");

  // 1. 事务只支持按文档 ID 操作，先定位激活码文档；事务内会重新校验最新状态。
  const codeRes = await db
    .collection("ActivationCodeCollection")
    .where({ code })
    .limit(2)
    .get();
  if (codeRes.data.length === 0) return fail(401, "激活码无效或已被使用");
  if (codeRes.data.length > 1) {
    console.error("[AuthManager] duplicate activation code", code);
    return fail(500, "激活码数据异常，请联系管理员");
  }
  const codeDoc = codeRes.data[0];

  // 2. 该 openid 是否已绑定过身份（不允许重复绑定）
  const userRes = await db.collection("UserCollection").where({ openid }).get();
  if (userRes.data.length > 0) return fail(403, "该微信已绑定身份，无需重复绑定");

  try {
    // 3. 创建用户与作废激活码必须原子完成；事务冲突由 SDK 自动重试。
    return await db.runTransaction(async (transaction) => {
      const freshCodeRes = await transaction
        .collection("ActivationCodeCollection")
        .doc(codeDoc._id)
        .get();
      const freshCode = Array.isArray(freshCodeRes.data)
        ? freshCodeRes.data[0]
        : freshCodeRes.data;

      if (!freshCode || freshCode.code !== code || freshCode.used) {
        return fail(401, "激活码无效或已被使用");
      }
      if (freshCode.expireAt && freshCode.expireAt < Date.now()) {
        return fail(401, "激活码已过期");
      }

      const now = Date.now();
      const nickname = freshCode.nickname || "";
      const teamId = freshCode.teamId || null;

      // 使用 openid 作为确定性文档 ID，同时充当同一用户并发绑定的唯一锁。
      await transaction.collection("UserCollection").add({
        data: {
          _id: openid,
          openid,
          role: freshCode.role, // captain / member / admin
          nickname,
          teamId, // 队长/部员关联的代表队；运营者为 null
          bindAt: now,
        },
      });

      await transaction.collection("ActivationCodeCollection").doc(codeDoc._id).update({
        data: { used: true, usedBy: openid, usedAt: now },
      });

      return ok({ role: freshCode.role, nickname, teamId });
    });
  } catch (e) {
    // 并发请求可能在事务重试期间由另一请求先完成，转换成稳定的业务错误码。
    const [latestUserRes, latestCodeRes] = await Promise.all([
      db.collection("UserCollection").where({ openid }).get(),
      db.collection("ActivationCodeCollection").where({ _id: codeDoc._id }).limit(1).get(),
    ]);
    if (latestUserRes.data.length > 0) {
      return fail(403, "该微信已绑定身份，无需重复绑定");
    }
    const latestCode = latestCodeRes.data[0];
    if (!latestCode || latestCode.used) {
      return fail(401, "激活码无效或已被使用");
    }
    throw e;
  }
}
