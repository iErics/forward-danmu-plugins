const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadPlugin(widget) {
  const code = fs.readFileSync(path.join(__dirname, "..", "danmu_misaka.js"), "utf8");
  const context = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Widget: widget || {
      http: { get: async () => ({ data: {} }), post: async () => ({ data: {} }) },
      storage: { get: async () => null, set: async () => null },
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

test("normalizes Misaka server URLs without duplicating api/v2", () => {
  const plugin = loadPlugin();

  assert.equal(
    plugin.normalizeServer("https://miska.example/api/v1/token/api/v2/"),
    "https://miska.example/api/v1/token"
  );
  assert.equal(
    plugin.buildEndpoint("https://miska.example/api/v1/token/api/v2", "comment/42", { async: 1 }),
    "https://miska.example/api/v1/token/api/v2/comment/42?async=1"
  );
});

test("builds a match filename from the current Forward playback episode", () => {
  const plugin = loadPlugin();

  assert.equal(
    plugin.buildMatchFileName({ title: "金关", season: "1", episode: "2" }),
    "金关 S01E02"
  );
  assert.equal(
    plugin.buildMatchFileName({ type: "movie", title: "上海滩之猛龙闯金关", premiereDate: "2024-01-12" }),
    "上海滩之猛龙闯金关 2024"
  );
});

test("generates Misaka virtual episode ids for fallback search results", () => {
  const plugin = loadPlugin();

  assert.equal(plugin.generateVirtualEpisodeId(900002, 1, 3), 25900002010003);
});

test("chooses a TV candidate that best matches the current title", () => {
  const plugin = loadPlugin();

  const best = plugin.chooseBestAnime(
    [
      { animeId: 900001, bangumiId: "A900001", animeTitle: "上海滩之猛龙闯金关 （来源：iqiyi 年份：2024）", type: "movie", episodeCount: 1 },
      { animeId: 900002, bangumiId: "A900002", animeTitle: "金关 （来源：youku 年份：2026）", type: "tvseries", episodeCount: 22 },
    ],
    { title: "金关", type: "tv", episode: "1" }
  );

  assert.equal(best.animeId, 900002);
});

test("polls taskcomment after comment async returns a taskId", async () => {
  const calls = [];
  const widget = {
    http: {
      get: async (url) => {
        calls.push(url);
        if (url.includes("/comment/25900002010001") && url.includes("async=1")) {
          return { data: { count: 0, comments: [], status: "pending", taskId: "task-1" } };
        }
        if (url.includes("/taskcomment/task-1")) {
          return { data: { status: calls.filter((u) => u.includes("/taskcomment/")).length < 2 ? "pending" : "completed", taskId: "task-1", episodeId: 25900002010001, progress: 100 } };
        }
        if (url.includes("/comment/25900002010001")) {
          return { data: { count: 1, comments: [{ cid: 1, p: "1,1,16777215", m: "hello" }] } };
        }
        throw new Error(`unexpected url ${url}`);
      },
    },
  };
  const plugin = loadPlugin(widget);

  const result = await plugin.fetchCommentsWithPolling(
    "https://miska.example/api/v1/token",
    25900002010001,
    { taskPollInterval: "0", taskPollTimeout: "5", chConvert: "0" }
  );

  assert.equal(result.count, 1);
  assert.equal(result.comments[0].m, "hello");
  assert.ok(calls.some((url) => url.includes("/taskcomment/task-1")));
});
