const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const authModulePath = path.resolve(__dirname, "../cloudfunctions/AuthManager/index.js");

const clone = (value) => structuredClone(value);

const matches = (document, query) =>
  Object.entries(query).every(([key, value]) => document[key] === value);

function createFakeDatabase(initialState = {}, options = {}) {
  const state = {
    activationCodes: clone(initialState.activationCodes || []),
    users: clone(initialState.users || []),
  };
  let transactionQueue = Promise.resolve();

  const documentsFor = (name, source = state) => {
    if (name === "ActivationCodeCollection") return source.activationCodes;
    if (name === "UserCollection") return source.users;
    throw new Error(`Unknown collection: ${name}`);
  };

  const queryReference = (name, query) => {
    let limit = Infinity;
    const reference = {
      limit(value) {
        limit = value;
        return reference;
      },
      async get() {
        return {
          data: documentsFor(name).filter((item) => matches(item, query)).slice(0, limit).map(clone),
        };
      },
    };
    return reference;
  };

  const regularCollection = (name) => ({
    where: (query) => queryReference(name, query),
  });

  const transactionCollection = (name, draft) => ({
    doc(id) {
      return {
        async get() {
          const document = documentsFor(name, draft).find((item) => item._id === id);
          return { data: document ? clone(document) : null };
        },
        async update({ data }) {
          if (name === "ActivationCodeCollection" && options.failCodeUpdate) {
            throw new Error("simulated activation-code update failure");
          }
          const documents = documentsFor(name, draft);
          const index = documents.findIndex((item) => item._id === id);
          if (index < 0) return { updated: 0 };
          documents[index] = { ...documents[index], ...clone(data) };
          return { updated: 1 };
        },
      };
    },
    async add({ data }) {
      const documents = documentsFor(name, draft);
      if (documents.some((item) => item._id === data._id)) {
        throw new Error("duplicate document id");
      }
      documents.push(clone(data));
      return { _id: data._id };
    },
  });

  const database = {
    state,
    command: {},
    collection: regularCollection,
    runTransaction(callback) {
      const execute = async () => {
        const draft = clone(state);
        const transaction = {
          collection: (name) => transactionCollection(name, draft),
        };
        const result = await callback(transaction);
        state.activationCodes = draft.activationCodes;
        state.users = draft.users;
        return result;
      };

      const result = transactionQueue.then(execute, execute);
      transactionQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };

  return database;
}

function loadAuthManager(database, openid) {
  const originalLoad = Module._load;
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database: () => database,
    getWXContext: () => ({ OPENID: openid }),
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "wx-server-sdk") return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[authModulePath];
  try {
    return require(authModulePath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[authModulePath];
  }
}

const validCode = (overrides = {}) => ({
  _id: "code-1",
  code: "TEST-CAPTAIN-01",
  role: "captain",
  nickname: "Test Captain",
  teamId: "volleyball",
  used: false,
  expireAt: Date.now() + 60_000,
  ...overrides,
});

test("bindIdentity atomically creates the user and consumes the code", async () => {
  const database = createFakeDatabase({ activationCodes: [validCode()] });
  const auth = loadAuthManager(database, "openid-a");

  const result = await auth.main({ action: "bindIdentity", code: "TEST-CAPTAIN-01" });

  assert.deepEqual(result, {
    code: 0,
    data: { role: "captain", nickname: "Test Captain", teamId: "volleyball" },
  });
  assert.equal(database.state.users.length, 1);
  assert.equal(database.state.users[0]._id, "openid-a");
  assert.equal(database.state.activationCodes[0].used, true);
  assert.equal(database.state.activationCodes[0].usedBy, "openid-a");
});

test("an already-used activation code cannot create a user", async () => {
  const database = createFakeDatabase({ activationCodes: [validCode({ used: true })] });
  const auth = loadAuthManager(database, "openid-a");

  const result = await auth.main({ action: "bindIdentity", code: "TEST-CAPTAIN-01" });

  assert.equal(result.code, 401);
  assert.equal(database.state.users.length, 0);
});

test("duplicate activation-code records are rejected as corrupted data", async () => {
  const database = createFakeDatabase({
    activationCodes: [validCode(), validCode({ _id: "code-2" })],
  });
  const auth = loadAuthManager(database, "openid-a");

  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await auth.main({ action: "bindIdentity", code: "TEST-CAPTAIN-01" });
    assert.equal(result.code, 500);
    assert.equal(database.state.users.length, 0);
  } finally {
    console.error = originalError;
  }
});

test("a failed activation-code update rolls back the user creation", async () => {
  const database = createFakeDatabase(
    { activationCodes: [validCode()] },
    { failCodeUpdate: true },
  );
  const auth = loadAuthManager(database, "openid-a");

  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await auth.main({ action: "bindIdentity", code: "TEST-CAPTAIN-01" });
    assert.equal(result.code, 500);
    assert.equal(database.state.users.length, 0);
    assert.equal(database.state.activationCodes[0].used, false);
  } finally {
    console.error = originalError;
  }
});

test("concurrent use of one activation code has exactly one winner", async () => {
  const database = createFakeDatabase({ activationCodes: [validCode()] });
  const first = loadAuthManager(database, "openid-a");
  const second = loadAuthManager(database, "openid-b");

  const results = await Promise.all([
    first.main({ action: "bindIdentity", code: "TEST-CAPTAIN-01" }),
    second.main({ action: "bindIdentity", code: "TEST-CAPTAIN-01" }),
  ]);

  assert.deepEqual(results.map((result) => result.code).sort(), [0, 401]);
  assert.equal(database.state.users.length, 1);
  assert.equal(database.state.activationCodes[0].used, true);
});

test("concurrent codes cannot bind the same openid twice", async () => {
  const database = createFakeDatabase({
    activationCodes: [
      validCode(),
      validCode({ _id: "code-2", code: "TEST-CAPTAIN-02" }),
    ],
  });
  const first = loadAuthManager(database, "openid-a");
  const second = loadAuthManager(database, "openid-a");

  const results = await Promise.all([
    first.main({ action: "bindIdentity", code: "TEST-CAPTAIN-01" }),
    second.main({ action: "bindIdentity", code: "TEST-CAPTAIN-02" }),
  ]);

  assert.deepEqual(results.map((result) => result.code).sort(), [0, 403]);
  assert.equal(database.state.users.length, 1);
  assert.equal(database.state.activationCodes.filter((item) => item.used).length, 1);
});
