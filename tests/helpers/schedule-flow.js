const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Production pages, call.js and cloud entry points share one store.
// Models serialization/atomic rollback, not cloud indexes or SDK concurrency.
function createScheduleFlow(options = {}) {
  const rows = {
    UserCollection: [{ _id: "captain-a", openid: "private-captain", role: "captain", teamId: "team-a" }],
    TeamCollection: [{ _id: "team-a", teamName: "测试A-队伍", enabled: true }],
    MatchCollection: [], DutyRecordCollection: [], ArchiveCollection: [],
  };
  const condition = (test) => ({ test, and(other) { return condition((value) => test(value) && other.test(value)); } });
  let transactionQueue = Promise.resolve();
  let failWrite = "";
  const database = {
    command: {
      exists: (target) => condition((value) => (value !== undefined) === target),
      neq: (target) => condition((value) => value !== target),
      gte: (target) => condition((value) => value >= target),
      lt: (target) => condition((value) => value < target),
      in: (targets) => condition((value) => targets.includes(value)),
    },
    collection(name) {
      assert.ok(Object.hasOwn(rows, name));
      return {
        doc(id) { return { async get() { return { data: structuredClone(rows[name].find((row) => row._id === id) || null) }; } }; },
        where(filter) {
          let offset = 0, size = 20;
          const order = [];
          const filtered = () => rows[name].filter((row) => Object.entries(filter).every(([key, value]) =>
            value && value.test ? value.test(row[key]) : row[key] === value));
          const query = {
            limit(value) { size = value; return query; },
            skip(value) { offset = value; return query; },
            orderBy(field, direction) { order.push([field, direction]); return query; },
            async update({ data }) {
              const targets = filtered();
              for (const row of targets) Object.assign(row, structuredClone(data));
              return { stats: { updated: targets.length } };
            },
            async count() { return { total: filtered().length }; },
            async get() {
              const result = filtered().sort((a, b) => {
                for (const [field, direction] of order) {
                  if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * (direction === "desc" ? -1 : 1);
                }
                return 0;
              });
              return { data: structuredClone(result.slice(offset, offset + size)) };
            },
          };
          return query;
        },
      };
    },
    runTransaction(callback) {
      const execute = async () => {
        if (options.beforeTransaction) await options.beforeTransaction(rows);
        const draft = structuredClone(rows);
        const result = await callback({
          collection(name) {
            return {
              doc(id) {
                return {
                  async get() { return { data: structuredClone(draft[name].find((row) => row._id === id) || null) }; },
                  async update({ data }) {
                    if (failWrite === name) { failWrite = ""; throw new Error("write failed"); }
                    const row = draft[name].find((row) => row._id === id);
                    assert.ok(row);
                    Object.assign(row, structuredClone(data));
                    return { stats: { updated: 1 } };
                  },
                };
              },
              async add({ data }) {
                if (failWrite === name) { failWrite = ""; throw new Error("write failed"); }
                if (draft[name].some((row) => row._id === data._id
                  || (data.createRequestId && row.createRequestId === data.createRequestId))) throw new Error("duplicate");
                draft[name].push(structuredClone(data));
                return { _id: data._id };
              },
            };
          },
        });
        Object.assign(rows, draft);
        return result;
      };
      const result = transactionQueue.then(execute);
      transactionQueue = result.catch(() => {});
      return result;
    },
  };
  let openid = "private-captain", lostAction = "";
  const app = { globalData: { cloudState: "ready", userInfo: { role: "captain", teamId: "team-a" } } };
  const requests = [], routes = [], modals = [];
  let stops = 0;
  const quietConsole = { log() {}, error() {} };
  function loadModule(relative, overrides = {}, globals = {}) {
    const filename = path.resolve(__dirname, "../..", relative);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
      module, exports: module.exports, Date, console: quietConsole,
      require(name) {
        if (Object.hasOwn(overrides, name)) return overrides[name];
        return name.startsWith(".") ? require(path.resolve(path.dirname(filename), name)) : require(name);
      }, ...globals,
    }, { filename });
    return module.exports;
  }
  const cloud = { init() {}, database: () => database, getWXContext: () => ({ OPENID: openid }) };
  const managers = Object.fromEntries(["ScheduleManager", "CalendarManager", "DutyManager"].map((name) => [name,
    loadModule(`cloudfunctions/${name}/index.js`, { "wx-server-sdk": cloud }),
  ]));
  const wx = {
    cloud: {
      async callFunction({ name, data }) {
        requests.push({ name, data: structuredClone(data) });
        if (options.beforeCall) await options.beforeCall(name, data);
        const result = JSON.parse(JSON.stringify(await managers[name].main(structuredClone(data))));
        if (lostAction === data?.action && result.code === 0) {
          lostAction = "";
          throw new Error("response lost after commit");
        }
        if (options.afterCall) await options.afterCall(name, data, result);
        return { result };
      },
    },
    showLoading() {}, hideLoading() {}, hideShareMenu() {}, showShareMenu() {},
    setNavigationBarTitle() {}, stopPullDownRefresh() { stops += 1; }, showToast() {},
    showModal(value) {
      modals.push(value);
      if (options.modal) return options.modal(value);
      if (value.success) value.success({ confirm: true });
      return Promise.resolve({ confirm: true });
    },
    navigateTo(value) { routes.push(value); }, redirectTo(value) { routes.push(value); },
    navigateBack(value) { routes.push(value); }, switchTab(value) { routes.push(value); },
  };
  const api = loadModule("miniprogram/utils/call.js", {}, { wx, getApp: () => app });
  return {
    rows, requests, routes, modals, api,
    get stops() { return stops; },
    failNextWrite(name) { failWrite = name; },
    loseResponse(action) { lostAction = action; },
    setIdentity(user, id = "visitor") { app.globalData.userInfo = user; openid = id; },
    page(name, options = {}) {
      let definition;
      const duty = loadModule("miniprogram/utils/duty-page.js", { "./call": api }, { wx });
      loadModule(`miniprogram/pages/${name}/index.js`, { "../../utils/call": api, "../../utils/duty-page": duty }, {
        wx, getCurrentPages: () => [], Page(value) { definition = value; },
      });
      const page = { ...definition, data: structuredClone(definition.data) };
      page.setData = (patch) => {
        for (const [key, value] of Object.entries(patch)) {
          const parts = key.split(".");
          let target = page.data;
          for (const part of parts.slice(0, -1)) target = target[part];
          target[parts.at(-1)] = value;
        }
      };
      page.onLoad(options);
      return page;
    },
  };
}

module.exports = { createScheduleFlow };
