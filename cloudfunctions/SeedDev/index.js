// 临时造数脚本：造一条测试比赛，matchTime 用相对偏移表达式
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { teamId = "volleyball", matchTimeOffsetH = 72, matchTimeOnsetH = 24 } = event; 

  const now = Date.now();
  await db.collection("MatchCollection").add({
    data: {
      teamId,
      teamName: "测试-新雅男排",
      sport: "排球",
      rival: event.rival || "行健男排",
      matchTime: now + matchTimeOffsetH * 3600 * 1000, // ← 相对偏移，不手算
      endTime: now + (matchTimeOffsetH + 2) * 3600 * 1000,
      location: "东操西男排场",
      demands: ["拍照", "饮用水"],
      isTbd: false,
      cellStatus: "pending",
      isArchived: false,
      captainOpenid: "test-a",
      createdAt: now,
      updatedAt: now,
    },
  });

  await db.collection("MatchCollection").add({
    data: {
      teamId,
      teamName: "测试-新雅男排",
      sport: "排球",
      rival: event.rival || "行健男排",
      matchTime: now + matchTimeOnsetH * 3600 * 1000, // ← 相对偏移，不手算
      endTime: now + (matchTimeOnsetH + 2) * 3600 * 1000,
      location: "东操西男排场",
      demands: ["拍照", "饮用水"],
      isTbd: false,
      cellStatus: "pending",
      isArchived: false,
      captainOpenid: "test-a",
      createdAt: now,
      updatedAt: now,
    },
  });

  return { code: 0 };
};