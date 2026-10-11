const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CELL_STATUS,
  STATUS_META,
  ROLE,
  DUTY_TYPE,
  HOURS,
} = require("../miniprogram/utils/status");

test("status and role contracts expose the frozen API values", () => {
  assert.deepEqual(Object.values(CELL_STATUS), [
    "pending",
    "confirmed",
    "help",
    "settle",
    "tbd",
    "cancelled",
    "dutyCancelled",
  ]);
  assert.deepEqual(Object.values(ROLE), ["guest", "captain", "member", "admin"]);
  assert.deepEqual(Object.values(DUTY_TYPE), ["confirm", "decline", "rescue", "assign"]);
  assert.equal(HOURS.FORCE_RED, 48);
  assert.ok(Object.isFrozen(CELL_STATUS));
  assert.ok(Object.isFrozen(ROLE));
  assert.ok(Object.isFrozen(DUTY_TYPE));
});

test("every cell status has immutable display metadata", () => {
  for (const status of Object.values(CELL_STATUS)) {
    assert.ok(STATUS_META[status], `missing metadata for ${status}`);
    assert.match(STATUS_META[status].color, /^#[0-9A-F]{6}$/i);
    assert.ok(Object.isFrozen(STATUS_META[status]));
  }
});
