const assert = require("node:assert/strict");
const test = require("node:test");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { dutyFlow, NOW } = require("./helpers/duty-flow");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function open(flow, name) {
  const page = flow.page(name, { matchId: "match-1" });
  await page.onShow();
  return page;
}

test("B pages: real response page confirms, own card expands, cancels and handles rescue", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = dutyFlow();
  const response = await open(flow, "respond");
  assert.equal(response.data.role, "member");
  assert.equal(response.data.shareReady, true);
  await response.onConfirm();
  assert.equal(response.data.myStatus, "confirmed");
  const profile = await open(flow, "profile");
  profile.onToggleDuty({ detail: { id: "match-1" } });
  assert.equal(profile.data.expandedId, "match-1");
  await profile.onCancelDuty({ detail: { id: "match-1" } });
  assert.equal(profile.data.myDuties.length, 0);
  await flow.invoke("b", "declineDuty");
  flow.as("a");
  await response.onShow();
  assert.equal(response.data.myStatus, "declined");
  assert.equal(response.onShareAppMessage().path, "/pages/rescue/index?matchId=match-1");
  const rescue = await open(flow, "rescue");
  await rescue.onRescue();
  assert.equal(rescue.data.myStatus, "confirmed");
  await rescue.onCancelRescue();
  assert.equal(rescue.data.match.cellStatus, "help");
  assert.equal(rescue.data.myStatus, "declined");
});

test("B pages: mutation response loss survives hide/show and retries one stable payload", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const [name, method, action] of [["respond", "onConfirm", "confirmDuty"], ["rescue", "onRescue", "rescueDuty"], ["profile", "onCancelDuty", "cancelMyDuty"]]) {
    const flow = dutyFlow();
    if (name === "rescue") Object.assign(flow.rows.MatchCollection[0], { cellStatus: "help", matchTime: NOW + 3600000 });
    if (name === "profile") await flow.invoke("a", "confirmDuty");
    const page = await open(flow, name);
    flow.loseResponse(action);
    await page[method]({ detail: { id: "match-1" } });
    assert.equal(page.data.retryPending, true);
    const version = flow.rows.MatchCollection[0].dutyVersion;
    page.onHide();
    await page.onShow();
    await page.onRetryAction();
    assert.equal(page.data.retryPending, false);
    assert.equal(flow.rows.MatchCollection[0].dutyVersion, version);
    const requests = flow.requests.filter((request) => request.data.action === action);
    assert.deepEqual(requests.at(-1), requests.at(-2));
    assert.equal(flow.modals.filter((modal) => modal.cancelText).length, 1);
  }
});

test("B pages: duplicate clicks and leaving during confirmation cannot send another write", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const name of ["respond", "rescue", "profile"]) {
    const modal = deferred();
    const flow = dutyFlow({ modal: () => modal.promise });
    if (name === "profile") await flow.invoke("a", "confirmDuty");
    if (name === "rescue") Object.assign(flow.rows.MatchCollection[0], { cellStatus: "help", matchTime: NOW + 3600000 });
    const page = await open(flow, name);
    const method = name === "respond" ? "onConfirm" : name === "rescue" ? "onRescue" : "onCancelDuty";
    const args = { detail: { id: "match-1" } };
    const first = page[method](args);
    await page[method](args);
    assert.equal(flow.modals.length, 1);
    const count = flow.requests.length;
    page.onHide();
    modal.resolve({ confirm: true });
    await first;
    assert.equal(flow.requests.length, count);
    await page.onShow();
    assert.equal(page.data.busy, false);
  }
});

test("B pages: hidden and unloaded pages discard late reads and identity changes", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const name of ["respond", "rescue", "profile"]) {
    for (const exit of ["onHide", "onUnload", "identity"]) {
      const gate = deferred();
      const flow = dutyFlow({ afterCall: () => gate.promise });
      const page = flow.page(name, { matchId: "match-1" });
      const show = page.onShow();
      await nextTurn();
      if (exit === "identity") flow.as("guest"); else page[exit]();
      const stops = flow.stops;
      gate.resolve();
      await show;
      assert.equal(name === "profile" ? page.data.myDuties.length : page.data.match, name === "profile" ? 0 : null);
      if (exit !== "identity") assert.equal(flow.stops, stops);
    }
  }
});

test("B pages: overlapping reads keep newest data and do not prematurely end refresh", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const name of ["respond", "rescue", "profile"]) {
    const gates = [];
    const flow = dutyFlow({ afterCall(_name, payload) {
      if (payload.action.startsWith("get") && payload.action !== "generateHelpCard") {
        const gate = deferred(); gates.push(gate); return gate.promise;
      }
    } });
    if (name === "profile") {
      // Seed an existing assignment so the list is nonempty without calling the delayed read.
      Object.assign(flow.rows.MatchCollection[0], { cellStatus: "confirmed", confirmerOpenid: "private-a" });
    }
    const page = flow.page(name, { matchId: "match-1" });
    const first = page.onShow(); await nextTurn();
    flow.rows.MatchCollection[0].rival = "最新对手";
    const second = page.onPullDownRefresh(); await nextTurn();
    const stops = flow.stops;
    gates[0].resolve(); await first;
    assert.equal(flow.stops, stops);
    assert.equal(name === "profile" ? page.data.loadingDuties : page.data.loading, true);
    gates[1].resolve(); await second;
    assert.equal((name === "profile" ? page.data.myDuties[0] : page.data.match).rival, "最新对手");
  }
});

test("B pages: failed reads clear prior data, offer retry and recover from guest binding", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const name of ["respond", "rescue", "profile"]) {
    let fails = false;
    const flow = dutyFlow({ beforeCall() { if (fails) throw new Error("断网"); } });
    const page = await open(flow, name);
    fails = true;
    await page.onPullDownRefresh();
    assert.match(name === "profile" ? page.data.dutyError : page.data.errorText, /断网/);
    assert.equal(name === "profile" ? page.data.myDuties.length : page.data.match, name === "profile" ? 0 : null);
    fails = false;
    flow.as("guest");
    await page.onShow();
    if (name !== "profile") assert.equal(page.data.needBind, true);
    flow.as("a");
    await page.onShow();
    if (name !== "profile") { assert.equal(page.data.needBind, false); assert.equal(page.data.match._id, "match-1"); }
  }
});

test("B pages: help preload is disabled until ready, late cards cannot revive after leaving", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const name of ["respond", "rescue"]) {
    const gate = deferred();
    const flow = dutyFlow({ afterCall(_name, payload) { if (payload.action === "generateHelpCard") return gate.promise; } });
    Object.assign(flow.rows.MatchCollection[0], { cellStatus: "help", matchTime: NOW + 3600000 });
    const page = flow.page(name, { matchId: "match-1" });
    const show = page.onShow(); await nextTurn();
    assert.equal(page.data.shareLoading, true);
    assert.equal(page.onShareAppMessage().path, "/pages/index/index");
    page.onHide();
    gate.resolve(); await show;
    assert.equal(page.data.shareReady, false);
    await page.onShow();
    assert.equal(page.onShareAppMessage().path, "/pages/rescue/index?matchId=match-1");
    const count = flow.requests.length;
    page.onShareAppMessage();
    assert.equal(flow.requests.length, count);
    flow.as("guest");
    assert.equal(page.onShareAppMessage().path, "/pages/index/index");
  }
});

test("B pages: help prefetch failure retries independently, and expiry disables cached sharing/actions", async (t) => {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  let fail = true;
  const flow = dutyFlow({ beforeCall(_name, payload) { if (payload.action === "generateHelpCard" && fail) throw new Error("分享断网"); } });
  Object.assign(flow.rows.MatchCollection[0], { cellStatus: "help", matchTime: NOW + 3600000 });
  const page = await open(flow, "respond");
  assert.equal(page.data.shareReady, false);
  assert.match(page.data.shareError, /断网/);
  fail = false;
  await page.prefetchHelpCard();
  assert.equal(page.data.shareReady, true);
  now += 3600000;
  assert.equal(page.onShareAppMessage().path, "/pages/index/index");
  const count = flow.requests.length;
  await page.onConfirm();
  assert.equal(flow.requests.length, count);
});

test("B pages: profile cancellation that turns red routes to the permitted follow-up page", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const actor of ["a", "other", "admin"]) {
    const flow = dutyFlow();
    Object.assign(flow.rows.MatchCollection[0], { cellStatus: "help", matchTime: NOW + 3600000 });
    await flow.invoke(actor, "rescueDuty");
    const profile = await open(flow, "profile");
    assert.equal(profile.data.myDuties[0].myConfirmed, true);
    await profile.onCancelDuty({ detail: { id: "match-1" } });
    assert.equal(flow.routes.at(-1).url, `/pages/${actor === "other" ? "rescue" : "respond"}/index?matchId=match-1`);
  }
});

test("B pages: old help prefetch cannot overwrite a newer saved schedule title", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  let release;
  const gate = deferred();
  let first = true;
  const flow = dutyFlow({ afterCall(_name, payload) {
    if (payload.action === "generateHelpCard" && first) { first = false; release = true; return gate.promise; }
  } });
  Object.assign(flow.rows.MatchCollection[0], { cellStatus: "help", matchTime: NOW + 3600000 });
  const page = flow.page("respond", { matchId: "match-1" });
  const old = page.onShow(); await nextTurn(); assert.equal(release, true);
  flow.rows.MatchCollection[0].rival = "新对手";
  await page.onPullDownRefresh();
  gate.resolve(); await old;
  assert.match(page.onShareAppMessage().title, /新对手/);
});

test("B pages: hide/show or refresh during a committed write cannot leave controls stuck busy", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const name of ["respond", "profile"]) {
    const gate = deferred();
    let delayed = false;
    const flow = dutyFlow({ afterCall(_name, payload) {
      if (delayed && ["confirmDuty", "cancelMyDuty"].includes(payload.action)) return gate.promise;
    } });
    if (name === "profile") await flow.invoke("a", "confirmDuty");
    const page = await open(flow, name);
    delayed = true;
    const action = name === "profile" ? page.onCancelDuty({ detail: { id: "match-1" } }) : page.onConfirm();
    await nextTurn();
    page.onHide();
    await page.onShow();
    assert.equal(page.data.busy, true);
    gate.resolve();
    await action;
    assert.equal(page.data.busy, false);
    assert.equal(page.data.retryPending, false);
  }
});

test("B pages: identity changes during a write clear busy state without leaking old action results", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const name of ["respond", "profile"]) {
    const gate = deferred();
    let delayed = false;
    const flow = dutyFlow({ afterCall(_name, payload) {
      if (delayed && ["confirmDuty", "cancelMyDuty"].includes(payload.action)) return gate.promise;
    } });
    if (name === "profile") await flow.invoke("a", "confirmDuty");
    const page = await open(flow, name);
    delayed = true;
    const action = name === "profile" ? page.onCancelDuty({ detail: { id: "match-1" } }) : page.onConfirm();
    await nextTurn();
    flow.as("guest");
    await page.onShow();
    gate.resolve(); await action;
    assert.equal(page.data.busy, false);
    assert.equal(page.data.retryPending, false);
    assert.equal(page.data.actionError, "");
    if (name === "respond") assert.equal(page.data.match, null);
    else assert.equal(page.data.myDuties.length, 0);
  }
});
