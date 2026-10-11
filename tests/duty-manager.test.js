const assert = require("node:assert/strict");
const test = require("node:test");
const { dutyFlow, NOW } = require("./helpers/duty-flow");

test("B-line: confirm, history, own list, cancel, decline, help and cross-team rescue form one flow", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = dutyFlow();
  assert.equal((await flow.invoke("a", "confirmDuty", { requestId: "confirm" })).cellStatus, "confirmed");
  assert.equal((await flow.invoke("a", "getMyDuties")).list.length, 1);
  assert.equal((await flow.invoke("a", "getRespondPage")).myStatus, "confirmed");
  assert.equal((await flow.invoke("a", "getTeamStats")).stats.find((row) => row.nickname === "甲").count, 1);
  assert.equal((await flow.invoke("a", "cancelMyDuty", { requestId: "cancel" })).cellStatus, "pending");
  assert.equal((await flow.invoke("b", "declineDuty", { requestId: "decline" })).cellStatus, "help");
  assert.equal((await flow.invoke("a", "getMyDuties")).list.length, 0);
  assert.equal((await flow.invoke("b", "generateHelpCard")).path, "/pages/rescue/index?matchId=match-1");
  await assert.rejects(flow.invoke("other", "getRespondPage"), { code: 403 });
  assert.equal((await flow.invoke("other", "getRescuePage")).canHelp, false);
  assert.equal((await flow.invoke("other", "rescueDuty", { requestId: "rescue" })).cellStatus, "confirmed");
  assert.equal((await flow.invoke("other", "getRescuePage")).myStatus, "confirmed");
  assert.equal((await flow.invoke("other", "cancelMyDuty", { requestId: "cancel-rescue" })).canHelp, false);
  assert.equal(flow.rows.MatchCollection[0].cellStatus, "help");
  assert.equal(flow.rows.MatchCollection[0].version, 1);
  assert.equal(flow.rows.MatchCollection[0].dutyRevision, 1);
});

test("B-line: simultaneous confirms/rescues have one owner and one committed confirmation record", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const actions of [["confirmDuty", "confirmDuty"], ["rescueDuty", "rescueDuty"], ["confirmDuty", "rescueDuty"]]) {
    const flow = dutyFlow();
    Object.assign(flow.rows.MatchCollection[0], { cellStatus: "help", matchTime: NOW + 3600000 });
    const results = await Promise.allSettled(actions.map((action, i) => flow.invoke(i ? "b" : "a", action, { requestId: `race-${i}` })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, 409);
    assert.equal(flow.rows.DutyRecordCollection.length, 1);
    assert.equal(flow.rows.DutyRecordCollection[0].openid, flow.rows.MatchCollection[0].confirmerOpenid);
    assert.equal(flow.rows.MatchCollection[0].cellStatus, "confirmed");
  }
});

test("B-line: same-millisecond concurrent declines converge to help without lost counts", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = dutyFlow();
  const results = await Promise.all([flow.invoke("a", "declineDuty"), flow.invoke("b", "declineDuty")]);
  assert.equal(results.at(-1).cellStatus, "help");
  assert.equal(flow.rows.MatchCollection[0].dutyVersion, 2);
  assert.equal(flow.rows.DutyRecordCollection.length, 2);
});

test("B-line: record write failure rolls back the match for every mutation", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const action of ["confirmDuty", "declineDuty", "rescueDuty", "cancelMyDuty"]) {
    const flow = dutyFlow();
    if (action === "rescueDuty") Object.assign(flow.rows.MatchCollection[0], { cellStatus: "help", matchTime: NOW + 3600000 });
    if (action === "cancelMyDuty") await flow.invoke("a", "confirmDuty");
    const snapshot = structuredClone(flow.rows);
    flow.failNextWrite("DutyRecordCollection");
    await assert.rejects(flow.invoke("a", action), { code: 500 });
    assert.deepEqual(flow.rows, snapshot);
  }
});

test("B-line: response loss retries reuse a request without replaying writes, including cancellation", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const action of ["confirmDuty", "declineDuty", "rescueDuty", "cancelMyDuty"]) {
    const flow = dutyFlow();
    if (action === "rescueDuty") Object.assign(flow.rows.MatchCollection[0], { cellStatus: "help", matchTime: NOW + 3600000 });
    if (action === "cancelMyDuty") await flow.invoke("a", "confirmDuty");
    flow.loseResponse(action);
    await assert.rejects(flow.invoke("a", action, { requestId: "lost" }), /response lost/);
    const snapshot = structuredClone(flow.rows);
    await flow.invoke("a", action, { requestId: "lost" });
    assert.deepEqual(flow.rows, snapshot);
    await assert.rejects(flow.invoke("a", action === "declineDuty" ? "confirmDuty" : "declineDuty", { requestId: "lost" }), { code: 409 });
  }
});

test("B-line: repeated decline recognizes existing history after the snapshot-based status change", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = dutyFlow();
  flow.rows.UserCollection = flow.rows.UserCollection.filter((user) => user._id !== "b");
  flow.rows.DutyRecordCollection.push({ _id: "legacy-record", matchId: "match-1", openid: "private-a", teamId: "team-a", type: "decline" });
  await flow.invoke("a", "declineDuty");
  await flow.invoke("a", "declineDuty");
  assert.equal(flow.rows.MatchCollection[0].cellStatus, "help");
  assert.equal(flow.rows.DutyRecordCollection.length, 1);
  assert.equal(flow.rows.DutyRecordCollection[0]._id, "legacy-record");
});

test("B-line: transaction rechecks role, team, schedule basis, start time and terminal states", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const changes = [
    (rows) => { rows.UserCollection.find((user) => user._id === "a").role = "captain"; },
    (rows) => { rows.UserCollection.find((user) => user._id === "a").teamId = "team-b"; },
    (rows) => { rows.MatchCollection[0].version += 1; },
    (rows) => { rows.MatchCollection[0].matchTime = NOW; },
    (rows) => { rows.MatchCollection[0].isArchived = true; },
    ...["cancelled", "dutyCancelled", "tbd", "settle"].map((status) => (rows) => { rows.MatchCollection[0].cellStatus = status; }),
  ];
  for (const change of changes) {
    const flow = dutyFlow({ beforeTransaction: change });
    await assert.rejects(flow.invoke("a", "confirmDuty"), (error) => [403, 409].includes(error.code));
    assert.equal(flow.rows.DutyRecordCollection.length, 0);
    assert.equal(flow.rows.MatchCollection[0].confirmerOpenid, undefined);
  }
});

test("B-line: all writes reject guests, captains, terminal states and elapsed start times", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const action of ["confirmDuty", "declineDuty", "rescueDuty", "cancelMyDuty"]) {
    for (const patch of [{ matchTime: NOW }, { endTime: NOW }, { isArchived: true }, { isTbd: true }, { cellStatus: "cancelled" }]) {
      const flow = dutyFlow();
      Object.assign(flow.rows.MatchCollection[0], patch);
      await assert.rejects(flow.invoke("a", action), { code: 409 });
    }
    const flow = dutyFlow();
    await assert.rejects(flow.invoke("guest", action), { code: 401 });
    flow.setIdentity({ role: "captain" }, "private-captain");
    await assert.rejects(flow.api.call("DutyManager", { action, matchId: "match-1" }), { code: 403 });
  }
});

test("B-line: admins can confirm across teams but may cancel only their own confirmation", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = dutyFlow();
  await flow.invoke("a", "confirmDuty");
  await assert.rejects(flow.invoke("admin", "cancelMyDuty"), { code: 404 });
  await flow.invoke("a", "cancelMyDuty");
  await flow.invoke("admin", "confirmDuty");
  assert.equal((await flow.invoke("admin", "getMyDuties")).list.length, 1);
  await flow.invoke("admin", "cancelMyDuty");
  assert.equal(flow.rows.MatchCollection[0].confirmerOpenid, "");
});

test("B-line: public DTOs exclude private metadata, format Shanghai time and handle TBD", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = dutyFlow();
  await flow.invoke("a", "confirmDuty", { requestId: "private-request" });
  const result = await flow.invoke("a", "getRespondPage");
  for (const word of ["openid", "private-", "lastRequest", "lastResult", "dutyVersion"]) assert.equal(JSON.stringify(result).includes(word), false);
  assert.equal(result.match.timeText, "10月10日 12:00");
  Object.assign(flow.rows.MatchCollection[0], { isTbd: true, cellStatus: "tbd", matchTime: null, endTime: null, confirmerOpenid: "" });
  assert.equal((await flow.invoke("a", "getRescuePage")).match.timeText, "时间待定");
});

test("B-line: my duties and team statistics paginate beyond the SDK query limit", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = dutyFlow();
  const base = flow.rows.MatchCollection[0];
  flow.rows.MatchCollection = Array.from({ length: 205 }, (_, i) => ({ ...base, _id: `match-${i}`, cellStatus: "confirmed", confirmerOpenid: "private-a" }));
  flow.rows.DutyRecordCollection = flow.rows.MatchCollection.map((match, i) => ({ _id: `record-${i}`, matchId: match._id, openid: "private-a", teamId: "team-a", type: "confirm" }));
  assert.equal((await flow.invoke("a", "getMyDuties")).list.length, 205);
  assert.equal((await flow.invoke("a", "getTeamStats")).stats.find((row) => row.nickname === "甲").count, 205);
});

test("B-line: help card rejects wrong team, expired and archived matches; ID is encoded", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = dutyFlow();
  Object.assign(flow.rows.MatchCollection[0], { _id: "match/1?x", cellStatus: "help", matchTime: NOW + 3600000 });
  const extra = { matchId: "match/1?x" };
  assert.equal((await flow.invoke("a", "generateHelpCard", extra)).path, "/pages/rescue/index?matchId=match%2F1%3Fx");
  await assert.rejects(flow.invoke("other", "generateHelpCard", extra), { code: 403 });
  flow.rows.MatchCollection[0].matchTime = NOW;
  await assert.rejects(flow.invoke("a", "generateHelpCard", extra), { code: 409 });
});

test("B-line: malformed actions, IDs and requests fail without mutations", async () => {
  const flow = dutyFlow();
  for (const data of [null, {}, { action: "missing" }, { action: "confirmDuty", matchId: {} }, { action: "confirmDuty", matchId: "match-1", requestId: [] }]) {
    await assert.rejects(flow.api.call("DutyManager", data), { code: 400 });
  }
  await assert.rejects(flow.invoke("a", "getRescuePage", { matchId: "missing" }), { code: 404 });
  assert.equal(flow.rows.DutyRecordCollection.length, 0);
});

test("B-line: stale UI tokens reject late actions and old retries after a newer intent", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = dutyFlow();
  const first = (await flow.invoke("a", "getRespondPage")).match.dutyToken;
  await flow.invoke("a", "confirmDuty", { requestId: "first", dutyToken: first });
  const confirmed = (await flow.invoke("a", "getRespondPage")).match.dutyToken;
  await flow.invoke("a", "cancelMyDuty", { requestId: "second", dutyToken: confirmed });
  await assert.rejects(flow.invoke("a", "confirmDuty", { requestId: "first", dutyToken: first }), { code: 409 });
  const current = (await flow.invoke("a", "getRespondPage")).match.dutyToken;
  flow.rows.MatchCollection[0].location = "已换场馆";
  await assert.rejects(flow.invoke("a", "confirmDuty", { requestId: "third", dutyToken: current }), { code: 409 });
  assert.equal(flow.rows.MatchCollection[0].confirmerOpenid, "");
});

test("A/B integration: schedule edit resets confirmation, old UI cannot reconfirm, cancellation clears own list", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = dutyFlow();
  const oldToken = (await flow.invoke("a", "getRespondPage")).match.dutyToken;
  await flow.invoke("a", "confirmDuty", { requestId: "confirm-before-edit", dutyToken: oldToken });
  flow.setIdentity({ role: "captain", teamId: "team-a" }, "private-captain");
  const raw = flow.rows.MatchCollection[0];
  await flow.api.call("ScheduleManager", { action: "saveMatch", matchId: raw._id, version: raw.version,
    requestId: "schedule-edit", sport: raw.sport, rival: raw.rival, location: "新场馆", demands: raw.demands,
    isTbd: false, matchTime: raw.matchTime, endTime: raw.endTime });
  assert.equal((await flow.invoke("a", "getRespondPage")).myStatus, "none");
  assert.equal((await flow.invoke("a", "getMyDuties")).list.length, 0);
  await assert.rejects(flow.invoke("a", "confirmDuty", { requestId: "stale-ui", dutyToken: oldToken }), { code: 409 });
  const fresh = (await flow.invoke("a", "getRespondPage")).match;
  await flow.invoke("a", "confirmDuty", { requestId: "fresh-confirm", dutyToken: fresh.dutyToken });
  flow.setIdentity({ role: "captain", teamId: "team-a" }, "private-captain");
  await flow.api.call("ScheduleManager", { action: "cancelMatch", matchId: raw._id, version: flow.rows.MatchCollection[0].version });
  assert.equal((await flow.invoke("a", "getMyDuties")).list.length, 0);
  assert.equal((await flow.invoke("a", "getRespondPage")).match.cellStatus, "cancelled");
  const detail = await flow.api.call("CalendarManager", { action: "getMatchDetail", matchId: raw._id });
  assert.equal(detail.match.cellStatus, "cancelled");
});

test("B-line: concurrent identical intent commits once and legacy rescue re-entry is safe", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = dutyFlow();
  Object.assign(flow.rows.MatchCollection[0], { cellStatus: "help", matchTime: NOW + 3600000 });
  const token = (await flow.invoke("a", "getRescuePage")).match.dutyToken;
  const payload = { requestId: "same", dutyToken: token };
  await Promise.all([flow.invoke("a", "rescueDuty", payload), flow.invoke("a", "rescueDuty", payload)]);
  await flow.invoke("a", "rescueDuty");
  assert.equal(flow.rows.MatchCollection[0].dutyVersion, 1);
  assert.equal(flow.rows.DutyRecordCollection.length, 1);
});

test("B-line: near-start pending match cannot receive new declines before timer catches up", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = dutyFlow();
  flow.rows.MatchCollection[0].matchTime = NOW + 3600000;
  await assert.rejects(flow.invoke("a", "declineDuty"), { code: 409 });
  assert.equal(flow.rows.DutyRecordCollection.length, 0);
});

test("B-line: duplicate identities and duplicate legacy records fail closed", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const flow = dutyFlow();
  flow.rows.UserCollection.push({ ...flow.rows.UserCollection.find((user) => user._id === "a"), _id: "duplicate" });
  await assert.rejects(flow.invoke("a", "confirmDuty"), { code: 500 });
  flow.rows.UserCollection.pop();
  flow.rows.DutyRecordCollection.push(...["old-a", "old-b"].map((_id) => ({ _id, matchId: "match-1", openid: "private-a", type: "decline" })));
  await assert.rejects(flow.invoke("a", "confirmDuty"), { code: 500 });
  assert.equal(flow.rows.MatchCollection[0].confirmerOpenid, undefined);
});
