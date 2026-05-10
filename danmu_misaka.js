// Misaka 弹幕插件 - Forward 播放当前集时自动匹配、下载并轮询弹幕
// Misaka: https://github.com/l429609201/misaka_danmu_server

WidgetMetadata = {
  id: "misaka.auto.danmu",
  title: "Misaka 自动弹幕",
  version: "0.1.5",
  requiredVersion: "0.0.2",
  description: "自动适配 Misaka/dandanplay 兼容接口，支持 match、后备搜索、异步弹幕任务轮询",
  author: "Forward-Danmu",
  site: "https://github.com/l429609201/misaka_danmu_server",
  globalParams: [
    {
      name: "server",
      title: "Misaka 接口地址",
      type: "input",
      placeholders: [
        {
          title: "Misaka /api/v1/<token>",
          value: "https://your-misaka.example/api/v1/your-token"
        }
      ]
    },
    {
      name: "autoMatch",
      title: "自动匹配当前集",
      type: "enumeration",
      value: "true",
      enumOptions: [
        { title: "开启", value: "true" },
        { title: "关闭", value: "false" }
      ]
    },
    {
      name: "prefetchOnSearch",
      title: "搜索时触发当前集下载",
      type: "enumeration",
      value: "true",
      enumOptions: [
        { title: "开启", value: "true" },
        { title: "关闭", value: "false" }
      ]
    },
    { name: "searchTimeout", title: "搜索超时（秒）", type: "input", value: "90" },
    { name: "detailTimeout", title: "详情超时（秒）", type: "input", value: "90" },
    { name: "prefetchTimeout", title: "触发下载请求超时（秒）", type: "input", value: "60" },
    { name: "taskPollTimeout", title: "弹幕任务轮询超时（秒）", type: "input", value: "180" },
    { name: "taskPollInterval", title: "弹幕任务轮询间隔（秒）", type: "input", value: "3" },
    {
      name: "chConvert",
      title: "简繁转换",
      type: "enumeration",
      value: "0",
      enumOptions: [
        { title: "跟随 Misaka/不转换", value: "0" },
        { title: "转简体", value: "1" },
        { title: "转繁体", value: "2" }
      ]
    },
    { name: "blockKeywords", title: "弹幕屏蔽词（逗号分隔）", type: "input", value: "" },
    { name: "maxCount", title: "弹幕数量上限（0 不限制）", type: "input", value: "0" }
  ],
  modules: [
    { id: "searchDanmu", title: "搜索弹幕", functionName: "searchDanmu", type: "danmu", params: [] },
    { id: "getDetail", title: "获取详情", functionName: "getDetailById", type: "danmu", params: [] },
    { id: "getComments", title: "获取弹幕", functionName: "getCommentsById", type: "danmu", params: [] }
  ]
};

const REQUEST_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "ForwardWidgets/1.0.0"
};

const ANIME_CACHE_KEY = "misaka_auto_anime_cache";

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolParam(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() !== "false";
}

function normalizeServer(server) {
  return String(server || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api\/v2$/i, "");
}

function buildEndpoint(server, path, query) {
  const base = normalizeServer(server);
  let url = `${base}/api/v2/${String(path || "").replace(/^\/+/, "")}`;
  const parts = [];
  for (const key in query || {}) {
    const value = query[key];
    if (value !== undefined && value !== null && value !== "") {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  if (parts.length) url += `?${parts.join("&")}`;
  return url;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutSec, label) {
  const timeout = Math.max(1, toInt(timeoutSec, 30)) * 1000;
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label || "request"} timeout`)), timeout);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function responseData(response) {
  const data = response && response.data !== undefined ? response.data : response;
  if (typeof data === "string") {
    try { return JSON.parse(data); } catch (_) { return data; }
  }
  return data;
}

async function httpGetJson(url, timeoutSec) {
  const response = await withTimeout(
    Widget.http.get(url, { headers: REQUEST_HEADERS }),
    timeoutSec,
    url
  );
  return responseData(response);
}

async function httpPostJson(url, body, timeoutSec) {
  const response = await withTimeout(
    Widget.http.post(url, body, { headers: REQUEST_HEADERS }),
    timeoutSec,
    url
  );
  return responseData(response);
}

function normalizeTitle(title) {
  return String(title || "")
    .replace(/（来源：.*?）/g, "")
    .replace(/\(来源：.*?\)/g, "")
    .replace(/\s+/g, "")
    .replace(/[：:]/g, "")
    .toLowerCase();
}

function getYear(params) {
  const raw = params && (params.year || params.premiereDate || params.airDate);
  const match = String(raw || "").match(/\d{4}/);
  return match ? match[0] : "";
}

function isMovieType(type) {
  const value = String(type || "").toLowerCase();
  return ["movie", "电影", "剧场版"].some((item) => value.includes(item));
}

function buildMatchFileName(params) {
  const title = String((params && (params.seriesName || params.title)) || "").trim();
  const type = params && params.type;
  if (!title) return "";

  if (isMovieType(type)) {
    const year = getYear(params);
    return year ? `${title} ${year}` : title;
  }

  const season = toInt(params && params.season, 1);
  const episode = toInt(params && params.episode, 0);
  if (episode > 0) {
    return `${title} S${String(season || 1).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  }
  return title;
}

function generateVirtualEpisodeId(animeId, sourceOrder, episodeNumber) {
  const anime = toInt(animeId, 0);
  const source = toInt(sourceOrder, 1);
  const episode = toInt(episodeNumber, 1);
  return Number(`25${String(anime).padStart(6, "0")}${String(source).padStart(2, "0")}${String(episode).padStart(4, "0")}`);
}

function chooseBestAnime(animes, params) {
  if (!animes || !animes.length) return null;
  const target = normalizeTitle((params && (params.seriesName || params.title)) || "");
  const wantMovie = isMovieType(params && params.type);
  const episode = toInt(params && params.episode, 0);
  const year = getYear(params);

  let best = null;
  let bestScore = -Infinity;
  for (const anime of animes) {
    let score = 0;
    const animeTitle = normalizeTitle(anime.animeTitle || "");
    const animeIsMovie = isMovieType(anime.type);
    if (wantMovie === animeIsMovie) score += 60;
    if (target && animeTitle === target) score += 80;
    else if (target && animeTitle.includes(target)) score += 55;
    else if (target && target.includes(animeTitle)) score += 35;
    if (episode > 0 && toInt(anime.episodeCount, 0) >= episode) score += 25;
    if (year && String(anime.year || anime.startDate || "").includes(year)) score += 20;
    if (String(anime.animeTitle || "").includes("来源：")) score += 5;
    if (score > bestScore) {
      bestScore = score;
      best = anime;
    }
  }
  return best;
}

async function readAnimeCache() {
  try {
    if (!Widget.storage || !Widget.storage.get) return {};
    const raw = await Widget.storage.get(ANIME_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

async function writeAnimeCacheEntry(anime) {
  if (!anime || anime.animeId === undefined || !Widget.storage || !Widget.storage.set) return;
  try {
    const cache = await readAnimeCache();
    cache[String(anime.animeId)] = anime;
    if (anime.bangumiId) cache[String(anime.bangumiId)] = anime;
    await Widget.storage.set(ANIME_CACHE_KEY, JSON.stringify(cache));
  } catch (_) {}
}

async function getCachedAnime(params) {
  const cache = await readAnimeCache();
  return cache[String(params.animeId || "")] || cache[String(params.bangumiId || "")] || null;
}

function buildSearchKeywords(params) {
  const base = String((params && (params.seriesName || params.title)) || "").trim();
  const matchName = buildMatchFileName(params);
  const list = [];
  if (matchName) list.push(matchName);
  if (base && base !== matchName) list.push(base);
  return list;
}

async function runMatch(server, params) {
  const fileName = buildMatchFileName(params);
  if (!fileName) return null;
  console.log(`[Misaka] 自动匹配: ${fileName}`);
  try {
    const data = await httpPostJson(
      buildEndpoint(server, "match"),
      {
        fileName,
        fileHash: params.fileHash || "",
        fileSize: toInt(params.fileSize, 0),
        videoDuration: toInt(params.videoDuration || params.runtime, 0),
        matchMode: "hashAndFileName"
      },
      params.matchTimeout || 45
    );
    if (data && data.isMatched && data.matches && data.matches.length > 0) {
      console.log(`[Misaka] 自动匹配成功: episodeId=${data.matches[0].episodeId}`);
      return data.matches[0];
    }
  } catch (e) {
    console.log(`[Misaka] 自动匹配失败: ${e.message || e}`);
  }
  return null;
}

async function searchMisakaAnimes(server, params) {
  const timeout = params.searchTimeout || 90;
  for (const keyword of buildSearchKeywords(params)) {
    try {
      console.log(`[Misaka] 后备搜索: ${keyword}`);
      const data = await httpGetJson(buildEndpoint(server, "search/anime", { keyword }), timeout);
      if (data && data.success !== false && data.animes && data.animes.length > 0) {
        return data.animes;
      }
    } catch (e) {
      console.log(`[Misaka] 后备搜索超时/失败: ${e.message || e}`);
    }
  }
  return [];
}

async function searchDanmu(params) {
  const server = normalizeServer(params.server);
  if (!server) return { animes: [] };

  const episodeResult = await searchEpisodesForPlayback(server, params);
  if (episodeResult && episodeResult.episodeId) {
    if (boolParam(params.prefetchOnSearch, true)) {
      await triggerCommentDownload(server, episodeResult.episodeId, params);
    }
    return { animes: episodeResult.animes };
  }

  if (boolParam(params.autoMatch, true)) {
    const match = await runMatch(server, params);
    if (match && match.episodeId) {
      const anime = animeFromMatch(match);
      await writeAnimeCacheEntry(anime);
      if (boolParam(params.prefetchOnSearch, true)) {
        await triggerCommentDownload(server, match.episodeId, params);
      }
      return { animes: [anime] };
    }
  }

  let animes = await searchMisakaAnimes(server, params);
  if (animes.length > 0) {
    animes = animes.slice().sort((a, b) => {
      const best = chooseBestAnime([a, b], params);
      return best === a ? -1 : 1;
    });
    for (const anime of animes) await writeAnimeCacheEntry(anime);
  }
  return { animes };
}

async function searchEpisodesForPlayback(server, params) {
  const title = String((params && (params.seriesName || params.title)) || "").trim();
  if (!title) return null;

  try {
    const data = await httpGetJson(buildEndpoint(server, "search/episodes", {
      anime: title
    }), params.episodeSearchTimeout || 15);
    const animes = data && data.success !== false && data.animes ? data.animes : [];
    const targetEpisode = toInt(params.episode, 0);
    for (const anime of animes) {
      const episodes = anime.episodes || [];
      const selected = episodes.find((ep) => {
        const index = ep.episodeIndex !== undefined ? ep.episodeIndex : ep.episodeNumber;
        return targetEpisode > 0 ? String(index) === String(targetEpisode) : true;
      }) || episodes[0];
      if (selected && selected.episodeId) {
        return { animes, episodeId: selected.episodeId, episode: selected };
      }
    }
  } catch (e) {
    console.log(`[Misaka] 分集搜索失败: ${e.message || e}`);
  }
  return null;
}

function animeFromMatch(match) {
  return {
    animeId: match.animeId,
    bangumiId: match.animeId ? `A${match.animeId}` : "",
    animeTitle: match.animeTitle || "",
    type: match.type || "tvseries",
    typeDescription: match.typeDescription || "",
    imageUrl: match.imageUrl || "",
    episodeCount: 1,
    rating: 0,
    isFavorited: false,
    episodes: [
      {
        episodeId: match.episodeId,
        episodeTitle: match.episodeTitle || "",
        episodeNumber: String(match.episodeNumber || "")
      }
    ]
  };
}

async function triggerCommentDownload(server, episodeId, params) {
  try {
    const data = await fetchCommentsOnce(server, episodeId, Object.assign({}, params, {
      commentTimeout: params.prefetchTimeout || params.commentTimeout || 60
    }), false);
    if (data && data.comments) {
      console.log(`[Misaka] 搜索阶段触发弹幕下载完成: episodeId=${episodeId}, count=${data.count || 0}`);
    }
  } catch (e) {
    console.log(`[Misaka] 搜索阶段触发弹幕下载失败: ${e.message || e}`);
  }
}

function buildFallbackEpisodes(anime, params) {
  const count = Math.max(1, toInt(anime && anime.episodeCount, toInt(params && params.episode, 1)));
  const episodes = [];
  for (let i = 1; i <= count; i++) {
    episodes.push({
      episodeId: generateVirtualEpisodeId(anime.animeId, 1, i),
      episodeTitle: `第${i}集`,
      episodeNumber: String(i)
    });
  }
  return episodes;
}

async function getDetailById(params) {
  const server = normalizeServer(params.server);
  const animeId = params.animeId || params.bangumiId;
  if (!server || !animeId) return [];

  const cachedAnime = await getCachedAnime(params);
  const bangumiId = String(params.bangumiId || (String(animeId).startsWith("A") ? animeId : `A${animeId}`));
  try {
    console.log(`[Misaka] 获取详情: ${bangumiId}`);
    const data = await httpGetJson(buildEndpoint(server, `bangumi/${bangumiId}`), params.detailTimeout || 90);
    const episodes = data && data.bangumi && data.bangumi.episodes ? data.bangumi.episodes : [];
    if (episodes.length > 0) {
      const currentEpisode = toInt(params.episode, 0);
      return currentEpisode > 0
        ? episodes.filter((ep) => String(ep.episodeNumber || "") === String(currentEpisode))
        : episodes;
    }
  } catch (e) {
    console.log(`[Misaka] 获取详情失败，使用临时分集: ${e.message || e}`);
  }

  if (cachedAnime || toInt(animeId, 0) > 0) {
    return buildFallbackEpisodes(cachedAnime || { animeId, episodeCount: params.episode || 1 }, params);
  }
  return [];
}

async function resolveEpisodeIdForPlayback(server, params) {
  const episodeResult = await searchEpisodesForPlayback(server, params);
  if (episodeResult && episodeResult.episodeId) return episodeResult.episodeId;

  const match = boolParam(params.autoMatch, true) ? await runMatch(server, params) : null;
  if (match && match.episodeId) return match.episodeId;

  const animes = await searchMisakaAnimes(server, params);
  const best = chooseBestAnime(animes, params);
  if (!best) return null;
  await writeAnimeCacheEntry(best);

  const episodes = await getDetailById(Object.assign({}, params, {
    animeId: best.animeId,
    bangumiId: best.bangumiId
  }));
  const targetEpisode = toInt(params.episode, 1);
  const selected = episodes.find((ep) => String(ep.episodeNumber || "") === String(targetEpisode)) || episodes[0];
  if (selected && selected.episodeId) return selected.episodeId;

  return generateVirtualEpisodeId(best.animeId, 1, targetEpisode);
}

async function fetchCommentsOnce(server, episodeId, params, asyncMode) {
  return await httpGetJson(buildEndpoint(server, `comment/${episodeId}`, {
    withRelated: "true",
    chConvert: params.chConvert || "0",
    async: asyncMode ? "1" : ""
  }), params.commentTimeout || 45);
}

async function pollTaskComment(server, taskId, params) {
  const timeoutSec = Math.max(1, toInt(params.taskPollTimeout, 180));
  const intervalMs = Math.max(0, toInt(params.taskPollInterval, 3)) * 1000;
  const deadline = Date.now() + timeoutSec * 1000;
  let last = null;

  while (Date.now() <= deadline) {
    last = await httpGetJson(buildEndpoint(server, `taskcomment/${taskId}`), params.taskPollRequestTimeout || 15);
    if (last && last.status === "completed") return last;
    if (last && last.status === "failed") return last;
    if (intervalMs > 0) await sleep(intervalMs);
  }
  return last || { status: "failed", description: "轮询超时" };
}

async function fetchCommentsWithPolling(server, episodeId, params) {
  const first = await fetchCommentsOnce(server, episodeId, params || {}, true);
  if (first && first.comments && first.comments.length > 0) return first;

  if (first && first.taskId && first.status === "pending") {
    console.log(`[Misaka] 弹幕下载任务开始: ${first.taskId}`);
    const task = await pollTaskComment(server, first.taskId, params || {});
    if (task && task.status === "completed") {
      const finalEpisodeId = task.episodeId || first.episodeId || episodeId;
      console.log(`[Misaka] 弹幕下载完成: episodeId=${finalEpisodeId}`);
      return await fetchCommentsOnce(server, finalEpisodeId, params || {}, false);
    }
    console.log(`[Misaka] 弹幕下载未完成: ${(task && task.description) || "unknown"}`);
    return first;
  }

  return first || null;
}

function parseBlockKeywords(raw) {
  return String(raw || "")
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function postProcessComments(data, params) {
  if (!data || !data.comments) return data;
  const keywords = parseBlockKeywords(params.blockKeywords);
  if (keywords.length) {
    data.comments = data.comments.filter((comment) => {
      const text = comment && comment.m ? String(comment.m) : "";
      return !keywords.some((keyword) => text.includes(keyword));
    });
    data.count = data.comments.length;
  }

  const maxCount = toInt(params.maxCount, 0);
  if (maxCount > 0 && data.comments.length > maxCount) {
    const sampled = [];
    const step = data.comments.length / maxCount;
    for (let i = 0; i < maxCount; i++) {
      sampled.push(data.comments[Math.floor(i * step)]);
    }
    data.comments = sampled;
    data.count = sampled.length;
  }
  return data;
}

async function getCommentsById(params) {
  const server = normalizeServer(params.server);
  if (!server) return null;

  let episodeId = params.commentId;
  if (!episodeId) {
    episodeId = await resolveEpisodeIdForPlayback(server, params);
  }
  if (!episodeId) {
    console.log("[Misaka] 无法自动解析当前集 episodeId");
    return null;
  }

  try {
    const data = await fetchCommentsWithPolling(server, episodeId, params);
    return postProcessComments(data, params);
  } catch (e) {
    console.log(`[Misaka] 获取弹幕失败: ${e.message || e}`);
    return null;
  }
}
