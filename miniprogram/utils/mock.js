// —— 三套 mock 比赛：分别对应要测的三种场景 ——
// matchTime 用 3 天后（正常）/ 2 小时后（触发 48h 安全锁）
const MOCK_MATCHES = {
  "测试B-常规": {
    _id: "测试B-常规",
    teamId: "volleyball",
    teamName: "排球队",
    sport: "排球",
    rival: "计算机系",
    matchTime: Date.now() + 3 * 24 * 3600 * 1000, // 3 天后：正常流程
    endTime: Date.now() + 3 * 24 * 3600 * 1000 + 2 * 3600 * 1000,
    location: "东区体育馆",
    demands: ["饮用水", "记分"],
    cellStatus: "pending",
    remainingCount: 3,
  },
  "测试B-紧急": {
    _id: "测试B-紧急",
    teamId: "volleyball",
    teamName: "排球队",
    sport: "排球",
    rival: "经管学院",
    matchTime: Date.now() + 2 * 3600 * 1000, // 2 小时后：触发 48h 安全锁
    endTime: Date.now() + 4 * 3600 * 1000,
    location: "西区排球场",
    demands: ["摄影"],
    cellStatus: "pending",
    remainingCount: 2,
  },
  "测试B-求助": {
    _id: "测试B-求助",
    teamId: "volleyball",
    teamName: "排球队",
    sport: "排球",
    rival: "建筑系",
    matchTime: Date.now() + 1 * 24 * 3600 * 1000,
    endTime: Date.now() + 1 * 24 * 3600 * 1000 + 2 * 3600 * 1000,
    location: "南区球场",
    demands: ["饮用水", "记分", "摄影"],
    cellStatus: "help", 
    helpReason: "本队经理人全员没空，等待大群救场", 
  },
};

module.exports = { MOCK_MATCHES }