// —— 三套 mock 比赛：分别对应要测的三种场景 ——
// matchTime 用 3 天后（正常）/ 2 小时后（触发 48h 安全锁）
const { CELL_STATUS } = require("./status");

const MOCK_MATCHES = {
  "测试B-常规": {
    _id: "测试B-常规",
    _teamSize: 3,        // 本队经理人总数（mock 重算器用）
    _declinedCount: 0,   // 已表态没空人数（mock 落库字段）
    teamId: "volleyball",
    teamName: "排球队",
    sport: "排球",
    rival: "计算机系",
    matchTime: Date.now() + 3 * 24 * 3600 * 1000, // 3 天后：正常流程
    endTime: Date.now() + 3 * 24 * 3600 * 1000 + 2 * 3600 * 1000,
    location: "东区体育馆",
    demands: ["饮用水", "记分"],
    cellStatus: CELL_STATUS.PENDING,
  },
  "测试B-紧急": {
    _id: "测试B-紧急",
    _teamSize: 2,
    _declinedCount: 0,
    teamId: "volleyball",
    teamName: "排球队",
    sport: "排球",
    rival: "经管学院",
    matchTime: Date.now() + 1 * 3600 * 1000, // 2 小时后：触发 48h 拉红
    endTime: Date.now() + 4 * 3600 * 1000,
    location: "西区排球场",
    demands: ["摄影"],
    cellStatus: CELL_STATUS.PENDING,
  },
  "测试B-求助": {
    _id: "测试B-求助",
    _teamSize: 2,
    _declinedCount: 2,   // 全员已没空 → 红态（与重算规则自洽）
    teamId: "volleyball",
    teamName: "排球队",
    sport: "排球",
    rival: "建筑系",
    matchTime: Date.now() + 1 * 24 * 3600 * 1000,
    endTime: Date.now() + 1 * 24 * 3600 * 1000 + 2 * 3600 * 1000,
    location: "南区球场",
    demands: ["饮用水", "记分", "摄影"],
    cellStatus: CELL_STATUS.HELP,
  },
  "测试B-超时": {
    _id: "测试B-超时",
    _teamSize: 3,
    _declinedCount: 0,   // 无人表态 + 48h 内 → 超时拉红（无触发者场景）
    teamId: "volleyball",
    teamName: "排球队",
    sport: "排球",
    rival: "物理系",
    matchTime: Date.now() + 20 * 3600 * 1000, // 20 小时后开赛
    endTime: Date.now() + 22 * 3600 * 1000,
    location: "北区体育馆",
    demands: ["记分"],
    cellStatus: CELL_STATUS.HELP,
  },
};

module.exports = { MOCK_MATCHES };
