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
│   │   ├── match-detail-card/ # B10 共用比赛详情卡片（三处复用）
│   │   └── page-placeholder/  # 未完成页面统一占位组件
│   ├── config/env.js          # develop/trial/release 云环境映射
│   └── utils/
│       ├── call.js           # D1 云函数统一调用封装
│       └── status.js         # D2 状态机常量（黄/绿/红/橙/灰 + 角色）
├── cloudfunctions/           # 云函数（控制类）
│   ├── AuthManager/          # C1 身份认证【已完成】
│   ├── ScheduleManager/      # C2 赛程管理【契约骨架，待实装】
│   └── DutyManager/          # C3 跟场任务【契约空壳，待实装】
└── project.config.json
```

待创建的业务云函数：`ArchiveManager`、`DashboardManager`、`CalendarManager`、`TeamManager`、`TimerChecker`。`ScheduleManager` 已完成 Day 2 契约骨架，A 线后续实装其业务 action，并负责 `CalendarManager.getCalendar/getMatchDetail` 首版；媒体读取 `getMediaLink` 留到归档收尾阶段。

## 环境信息

- **开发云环境 ID**：`yaliquankai-d2g2kt52247d144a8`（配置于 `miniprogram/config/env.js`；体验版和正式版尚未配置）
- **数据库集合**（权限均为自定义安全规则 `read:false, write:false`，只走云函数）：
  `UserCollection` / `MatchCollection` / `DutyRecordCollection` / `ArchiveCollection` / `ActivationCodeCollection` / `TeamCollection`
- 6 个集合均已存在；`TeamCollection` 及所需索引已完成基线确认。

## 开发环境搭建（每位协作者一次）

1. `git clone` 本仓库；
2. `git switch -c dev --track origin/dev`，再从 `dev` 创建自己的功能分支；
3. 微信开发者工具 → 导入项目 → 选择本目录 → AppID：`wx4ce0834c631f61ce`；
4. 用自己微信扫码登录（需先被添加为小程序「项目成员-开发者」）。

## 协作规范

- **分支**：功能分支从 `dev` 创建并合并回 `dev`；稳定版本再由 `dev` 合并到 `main`；
- **开工先 pull，收工必 push**；
- **改了云函数必须部署**：开发者工具中右键该云函数目录 → 「上传并部署：云端安装依赖」，并在群里说一声；
- **测试数据**用自己名字开头（如 `测试A-排球`），不要删别人的测试数据；
- 前端改完点「编译」即可预览；云函数不部署不生效。

## 代码质量与自动化测试

仓库根目录使用 Node.js 20.19+（或 22.13+/24+）、ESLint Flat Config 和 Node.js 内置测试框架。首次使用先安装依赖：

```bash
npm install
```

常用命令：

```bash
npm run lint   # 静态检查小程序、云函数和测试代码
npm test       # 运行状态常量、环境隔离和 Auth 事务测试
npm run check  # 依次执行 lint + test，提交前推荐运行
```

GitHub Actions 会在向 `main` / `dev` 推送或发起 PR 时使用 Node.js 24 自动执行 `npm ci` 和 `npm run check`。CI 通过不能替代微信开发者工具编译和真机测试；涉及云函数的改动仍需部署到开发环境后完成联调。

## A 线开工前确认

1. 从最新 `dev` 创建 `feat/schedule`，确认本机 `node` / `npm` 可用且 `npm run check` 通过；
2. 准备一个绑定到有效 `TeamCollection` 记录的队长测试身份，并确认自己拥有开发环境云函数部署权限；
3. 为 `MatchCollection.createRequestId` 建唯一索引，用于防止新建赛程网络重试产生重复记录；
4. 按 `接口约定.md` 8.1 实现 TBD、时间校验、revision/version、requestId 幂等、状态守卫和分享预加载规则；
5. A 线完成 `CalendarManager.getCalendar/getMatchDetail` 后再验收首页，不以长期 mock 代替公开读取接口。

## 部署清单（首次）

1. 云开发控制台确认 6 个集合（见上），并将权限设为前端不可读写；
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

- 需求文档（用例模型 + 分析模型）：`需求文档.md`
- 代码层权威契约：`接口约定.md`
- [微信云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)
