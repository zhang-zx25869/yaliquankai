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

  // 1. 查激活码：存在、未使用、未过期
  const codeRes = await db
    .collection("ActivationCodeCollection")
    .where({ code, used: false })
    .get();
  if (codeRes.data.length === 0) return fail(401, "激活码无效或已被使用");
  const codeDoc = codeRes.data[0];
  if (codeDoc.expireAt && codeDoc.expireAt < Date.now()) {
    return fail(401, "激活码已过期");
  }

  // 2. 该 openid 是否已绑定过身份（不允许重复绑定）
  const userRes = await db.collection("UserCollection").where({ openid }).get();
  if (userRes.data.length > 0) return fail(403, "该微信已绑定身份，无需重复绑定");

  // 3. 建立 openid ↔ 角色 永久绑定
  await db.collection("UserCollection").add({
    data: {
      openid,
      role: codeDoc.role,        // captain / member / admin
      nickname: codeDoc.nickname || "", // 激活码可预置昵称（如队长姓名）
      teamId: codeDoc.teamId || null,   // 队长/部员关联的代表队
      bindAt: Date.now(),
    },
  });

  // 4. 作废激活码（一次性）
  await db.collection("ActivationCodeCollection").doc(codeDoc._id).update({
    data: { used: true, usedBy: openid, usedAt: Date.now() },
  });

  return ok({
    role: codeDoc.role,
    nickname: codeDoc.nickname || "",
    teamId: codeDoc.teamId || null,
  });
}
