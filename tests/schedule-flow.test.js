const assert = require("node:assert/strict");
const test = require("node:test");
const { createScheduleFlow } = require("./helpers/schedule-flow");

const NOW = Date.parse("2026-10-07T12:00:00+08:00");
const form = (fields = {}) => ({
  sport: "测试A-篮球", rival: "对手", location: "体育馆", demands: ["饮用水"], isTbd: false,
  startDate: "2026-10-10", startTime: "14:00", endDate: "2026-10-10", endTime: "16:00", ...fields,
});
const input = (page, field, value) => page.onFieldInput({ currentTarget: { dataset: { field } }, detail: { value } });
async function publish(flow, fields = {}) {
  const page = flow.page("schedule-form");
  await page.onShow();
  page.setData({ form: form(fields) });
  await page.onSave();
  assert.equal(page.data.saved, true, page.data.errorText);
  return page;
}
async function edit(flow, id) {
  const page = flow.page("schedule-form", { matchId: id });
  await page.onShow();
  assert.equal(page.data.authorized, true);
  assert.equal(page.data.errorText, "");
  return page;
}
function assertPublic(value) {
  const json = JSON.stringify(value);
  for (const secret of ["private-", "captainOpenid", "confirmerOpenid", "createRequestId", "lastSaveResult", "mediaLink"]) {
    assert.equal(json.includes(secret), false, secret);
  }
}

test("A-line: publish, manage, edit, share, cancel and refresh use the same persisted match", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = createScheduleFlow();
  const home = flow.page("index");
  await home.onShow();
  home.onPublish();
  assert.equal(flow.routes.at(-1).url, "/pages/schedule-form/index");
  home.onHide();
  const created = await publish(flow);
  const id = flow.rows.MatchCollection[0]._id;
  assert.equal(created.onShareAppMessage().path, `/pages/respond/index?matchId=${id}`);
  created.onManage();
  assert.equal(flow.routes.at(-1).url, "/pages/schedule-list/index");
  const list = flow.page("schedule-list");
  await list.onShow();
  assert.equal(list.data.list[0]._id, id);
  list.onOpenMatch({ currentTarget: { dataset: { id } } });
  assert.equal(flow.routes.at(-1).url, `/pages/schedule-form/index?matchId=${id}`);
  const page = await edit(flow, id);
  input(page, "rival", "新对手");
  assert.equal(page.data.shareReady, false);
  await page.onSave();
  assert.equal(flow.rows.MatchCollection[0].version, 2);
  assert.match(page.onShareAppMessage().title, /新对手/);
  await home.onShow();
  assert.equal(home.data.matches[0].rival, "新对手");
  await home.onToggleMatch({ detail: { id } });
  assert.equal(home.data.detail.rival, "新对手");
  assertPublic(home.data.detail);
  await page.onReload();
  input(page, "location", "未保存草稿");
  await page.onCancel();
  assert.equal(page.data.cancelled, true);
  assert.equal(page.data.form.location, "体育馆");
  assert.equal(page.onShareAppMessage().path, "/pages/index/index");
  assert.equal(flow.rows.MatchCollection[0].version, 3);
  await list.onShow();
  assert.equal(list.data.list[0].actionLabel, "查看已取消赛程");
  await home.onPullDownRefresh();
  assert.equal(home.data.expandedId, "");
  assert.equal(home.data.matches[0].cellStatus, "cancelled");
  await home.onToggleMatch({ detail: { id } });
  assert.equal(home.data.detail.cellStatus, "cancelled");
  assertPublic(home.data.matches);
  const readonly = await edit(flow, id);
  assert.equal(readonly.data.viewOnly, true);
  await readonly.onSave();
  assert.equal(flow.rows.MatchCollection.length, 1);
  assert.equal(flow.rows.MatchCollection[0].version, 3);
});

test("A-line: committed create/edit/cancel responses can be retried without duplicate writes", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = createScheduleFlow();
  const page = flow.page("schedule-form");
  await page.onShow();
  page.setData({ form: form() });
  flow.loseResponse("saveMatch");
  await page.onSave();
  assert.equal(page.data.retryPending, true);
  assert.equal(flow.rows.MatchCollection.length, 1);
  page.onHide();
  await page.onShow();
  await page.onSave();
  assert.equal(page.data.saved, true);
  assert.equal(flow.rows.MatchCollection.length, 1);
  const id = flow.rows.MatchCollection[0]._id;
  const editing = await edit(flow, id);
  input(editing, "location", "新场馆");
  flow.loseResponse("saveMatch");
  await editing.onSave();
  assert.equal(editing.data.retryPending, true);
  assert.equal(flow.rows.MatchCollection[0].version, 2);
  editing.onHide();
  await editing.onShow();
  await editing.onSave();
  assert.equal(editing.data.saved, true);
  assert.equal(flow.rows.MatchCollection[0].version, 2);
  const saves = flow.requests.filter((request) => request.data.action === "saveMatch");
  assert.deepEqual(saves[0], saves[1]);
  assert.deepEqual(saves[2], saves[3]);
  await editing.onReload();
  flow.loseResponse("cancelMatch");
  await editing.onCancel();
  assert.equal(editing.data.cancelRetryPending, true);
  assert.equal(flow.rows.MatchCollection[0].version, 3);
  await editing.onCancel();
  assert.equal(editing.data.cancelled, true);
  assert.equal(flow.rows.MatchCollection[0].version, 3);
  assert.equal(flow.modals.filter((modal) => modal.title === "确认取消比赛？").length, 1);
});

test("A-line: TBD moves between calendar sections and cancellation removes it from TBD", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = createScheduleFlow();
  const created = await publish(flow, { isTbd: true, startDate: "", endDate: "" });
  assert.match(created.onShareAppMessage().title, /时间待定/);
  const id = flow.rows.MatchCollection[0]._id;
  const home = flow.page("index");
  await home.onShow();
  assert.equal(home.data.matches.length, 0);
  assert.equal(home.data.tbdMatches[0]._id, id);
  const page = await edit(flow, id);
  page.onTbdChange({ detail: { value: false } });
  for (const field of ["startDate", "startTime", "endDate", "endTime"]) input(page, field, form()[field]);
  await page.onSave();
  await home.onPullDownRefresh();
  assert.equal(home.data.tbdMatches.length, 0);
  assert.equal(home.data.matches[0]._id, id);
  assert.equal(flow.rows.MatchCollection[0].dutyRevision, 2);
  await page.onReload();
  page.onTbdChange({ detail: { value: true } });
  await page.onSave();
  assert.equal(flow.rows.MatchCollection[0].matchTime, null);
  assert.equal(flow.rows.MatchCollection[0].endTime, null);
  await home.onPullDownRefresh();
  assert.equal(home.data.matches.length, 0);
  assert.equal(home.data.tbdMatches[0]._id, id);
  await page.onReload();
  await page.onCancel();
  await home.onPullDownRefresh();
  assert.equal(home.data.tbdMatches.length, 0);
  const detail = await flow.api.call("CalendarManager", { action: "getMatchDetail", matchId: id });
  assert.equal(detail.match.cellStatus, "cancelled");
});

test("A-line: demand edits preserve confirmation; a basis change clears it and refreshes public detail", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = createScheduleFlow();
  await publish(flow);
  const id = flow.rows.MatchCollection[0]._id;
  // Fixture represents a prior B-line confirmation; DutyManager is tested separately.
  Object.assign(flow.rows.MatchCollection[0], {
    cellStatus: "confirmed", confirmerOpenid: "private-member", confirmerNickname: "经理人", confirmerType: "confirm",
  });
  flow.rows.DutyRecordCollection.push({ _id: "duty", matchId: id, openid: "private-member", type: "confirm" });
  const page = await edit(flow, id);
  page.onDemandsChange({ detail: { value: ["摄影"] } });
  await page.onSave();
  assert.equal(flow.rows.MatchCollection[0].confirmerOpenid, "private-member");
  assert.equal(flow.rows.MatchCollection[0].dutyRevision, 1);
  assert.equal(flow.modals.at(-1).title, "后勤需求已更新");
  await page.onReload();
  input(page, "startDate", "2026-10-08");
  input(page, "endDate", "2026-10-08");
  await page.onSave();
  assert.equal(flow.rows.MatchCollection[0].cellStatus, "help");
  assert.equal(flow.rows.MatchCollection[0].confirmerOpenid, "");
  assert.equal(flow.rows.MatchCollection[0].dutyRevision, 2);
  assert.equal(flow.rows.DutyRecordCollection.length, 1);
  const home = flow.page("index");
  await home.onShow();
  await home.onToggleMatch({ detail: { id } });
  assert.equal(home.data.detail.cellStatus, "help");
  assert.equal(home.data.detail.confirmerNickname, "");
  assert.match(home.data.detail.timeText, /10月8日/);
  assertPublic(home.data.detail);
});

test("A-line: two editors conflict, reload latest version, then cancel without overwriting newer data", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = createScheduleFlow();
  await publish(flow);
  const id = flow.rows.MatchCollection[0]._id;
  const first = await edit(flow, id), second = await edit(flow, id);
  input(first, "rival", "先保存的对手");
  await first.onSave();
  input(second, "rival", "旧页面草稿");
  await second.onSave();
  assert.equal(second.data.conflict, true);
  assert.equal(second.data.shareReady, false);
  assert.equal(flow.rows.MatchCollection[0].rival, "先保存的对手");
  await second.onReload();
  assert.equal(second.data.form.rival, "先保存的对手");
  await second.onCancel();
  await first.onReload();
  assert.equal(first.data.viewOnly, true);
  assert.equal(first.data.cancelled, true);
  assert.equal(first.data.shareReady, false);
});

test("A-line: guests can read persisted matches but cannot manage; a foreign captain cannot edit", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = createScheduleFlow();
  await publish(flow);
  const id = flow.rows.MatchCollection[0]._id;
  flow.setIdentity({ role: "guest" });
  const home = flow.page("index");
  await home.onShow();
  assert.equal(home.data.isCaptain, false);
  assert.equal(home.data.matches[0]._id, id);
  await assert.rejects(flow.api.call("ScheduleManager", { action: "getMatchForEdit", matchId: id }), { code: 401 });
  flow.rows.UserCollection.push({ _id: "captain-b", openid: "private-other", role: "captain", teamId: "team-b" });
  flow.rows.TeamCollection.push({ _id: "team-b", teamName: "另一队", enabled: true });
  flow.setIdentity({ role: "captain", teamId: "team-b" }, "private-other");
  const page = flow.page("schedule-form", { matchId: id });
  await page.onShow();
  assert.equal(page.data.authorized, false);
  assert.equal(page.data.shareReady, false);
  const list = flow.page("schedule-list");
  await list.onShow();
  assert.equal(list.data.list.length, 0);
  assert.equal(flow.rows.MatchCollection[0].version, 1);
  assertPublic(home.data.matches);
});
