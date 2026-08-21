# 雅力全开 — 新雅书院体育部赛事跟场与后勤管理小程序

基于**微信云开发**（云函数 + 云数据库 + 定时触发器）的轻量化赛事跟场与信息管理平台。

## 项目结构

```
yaliquankai/
├── miniprogram/              # 前端（界面类）
│   ├── app.js / app.json     # 全局入口：云环境初始化 + 免密静默登录
│   ├── pages/
│   │   ├── index/            # B2 首页·公共赛程日历（用例16/17）【A·赛程线】
│   │   ├── team/             # B3 队伍栏目（用例19）【收尾】
│   │   ├── dashboard/        # B4 四色看板（用例13/14/15）【C·看板线】
│   │   ├── profile/          # B5 我的·身份与激活码绑定（用例1/2）【已完成】
│   │   ├── respond/          # B6 跟场响应页（用例6/7/8/10）【B·跟场线】
│   │   ├── rescue/           # B7 救场接单页（用例9）【B·跟场线】
│   │   ├── archive/          # B8 赛后归档页（用例11/12）【C·看板线】
│   │   └── schedule-form/    # B9 赛程表单页（用例3/5）【A·赛程线】
│   ├── components/
│   │   └── match-detail-card/ # B10 共用比赛详情卡片（三处复用）
│   └── utils/
│       ├── call.js           # D1 云函数统一调用封装
│       └── status.js         # D2 状态机常量（黄/绿/红/橙/灰 + 角色）
├── cloudfunctions/           # 云函数（控制类）
│   ├── AuthManager/          # C1 身份认证【已完成】
│   ├── ScheduleManager/      # C2 赛程管理【A】
│   ├── DutyManager/          # C3 跟场任务【B】
│   ├── ArchiveManager/       # C4 赛后归档【C】
│   ├── DashboardManager/     # C5 看板与裁决【C】
│   ├── CalendarManager/      # C6 公共日历【收尾】
│   ├── TeamManager/          # C7 队伍栏目【收尾】
│   └── TimerChecker/         # C8 定时巡检（48h拉红/到点转橙）【C】
└── project.config.json
```

## 环境信息

- **云环境 ID**：`yaliquankai-d2g2kt52247d144a8`（已写入 `miniprogram/app.js` 与 `envList.js`）
- **数据库集合**（权限均为自定义安全规则 `read:false, write:false`，只走云函数）：
  `UserCollection` / `MatchCollection` / `DutyRecordCollection` / `ArchiveCollection` / `ActivationCodeCollection`

## 开发环境搭建（每位协作者一次）

1. `git clone` 本仓库；
2. 微信开发者工具 → 导入项目 → 选择本目录 → AppID：`wx4ce0834c631f61ce`；
3. 用自己微信扫码登录（需先被添加为小程序「项目成员-开发者」）。

## 协作规范

- **分支**：各自在 `feat/schedule`（A）/ `feat/duty`（B）/ `feat/dashboard`（C）分支开发，完成后 PR 合并到 `main`；
- **开工先 pull，收工必 push**；
- **改了云函数必须部署**：开发者工具中右键该云函数目录 → 「上传并部署：云端安装依赖」，并在群里说一声；
- **测试数据**用自己名字开头（如 `测试A-排球`），不要删别人的测试数据；
- 前端改完点「编译」即可预览；云函数不部署不生效。

## 部署清单（首次）

1. 云开发控制台已建 5 个集合（见上）；
2. 右键 `cloudfunctions/AuthManager` → 上传并部署；
3. 编译通过后，「我的」页可用测试激活码验证绑定流程。

## 测试激活码示例（开发期）

在 `ActivationCodeCollection` 手动添加记录：

```json
{
  "code": "TEST-CAPTAIN-01",
  "role": "captain",
  "nickname": "测试队长",
  "teamId": "volleyball",
  "used": false
}
```

## 参考资料

- 需求文档（用例模型 + 分析模型）：`../需求文档.md`
- [微信云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)
