// Miska 弹幕插件 — 为 Forward 播放器提供 Miska 弹幕服务器支持
// Miska: https://github.com/l429609201/misaka_danmu_server
// 兼容弹弹play API v2 规范

WidgetMetadata = {
    id: "miska.danmu",
    title: "Miska 弹幕",
    version: "1.8.0",
    requiredVersion: "0.0.2",
    description: "从 Miska 弹幕服务器获取弹幕数据，支持搜索番剧、获取分集列表和弹幕内容",
    author: "Forward-Danmu",
    site: "https://github.com/iErics/forward-danmu-plugins",
    globalParams: [
        {
            name: "server",
            title: "服务器地址",
            type: "input",
            placeholders: [
                {
                    title: "Miska 服务器地址（含 Token）",
                    value: "https://your-server.com/your-token"
                }
            ]
        },
        {
            name: "matchTimeout",
            title: "匹配请求超时（秒）",
            type: "input",
            value: "90",
            description: "等待 Miska 匹配管道完成的最长时间"
        },
        {
            name: "pollTimeout",
            title: "轮询下载超时（秒）",
            type: "input",
            value: "120",
            description: "匹配完成后轮询等待弹幕下载到位的最长时间"
        },
        {
            name: "blockKeywords",
            title: "屏蔽关键词",
            type: "input",
            value: ""
        },
        {
            name: "maxCount",
            title: "弹幕数量上限",
            type: "input",
            value: "0"
        }
    ],
    modules: [
        {
            id: "searchDanmu",
            title: "搜索弹幕",
            functionName: "searchDanmu",
            type: "danmu",
            params: []
        },
        {
            id: "getDetail",
            title: "获取详情",
            functionName: "getDetailById",
            type: "danmu",
            params: []
        },
        {
            id: "getComments",
            title: "获取弹幕",
            functionName: "getCommentsById",
            type: "danmu",
            params: []
        }
    ]
};

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function buildUrl(server, path, query) {
    let base = server.replace(/\/+$/, "");
    let url = `${base}/api/v2/${path}`;
    if (!query) return url;
    let parts = Object.entries(query)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    if (parts.length) url += "?" + parts.join("&");
    return url;
}

// 调用 /match 端点，返回 "matched" | "timeout" | "miss"
// 注意：Miska /match 内部有约30秒超时，超时返回 isMatched:false 但任务仍在后台运行
async function awaitMatch(server, title, season, episode, timeoutSec) {
    const base = server.replace(/\/+$/, "");
    let fileName = title;
    const s = parseInt(season) || 0;
    const e = parseInt(episode) || 0;
    if (s > 0 && e > 0) {
        fileName = `${title} S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
    } else if (e > 0) {
        fileName = `${title} 第${e}集`;
    }
    const start = Date.now();
    console.log(`[Miska] 匹配: ${fileName} (超时 ${timeoutSec}s)`);
    try {
        const res = await Promise.race([
            Widget.http.post(`${base}/match`, { fileName }, { headers: requestHeaders }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutSec * 1000))
        ]);
        const elapsed = (Date.now() - start) / 1000;
        if (res && res.data && res.data.isMatched) {
            console.log(`[Miska] 匹配成功 (${elapsed.toFixed(1)}s)`);
            return "matched";
        }
        // 耗时较长但未命中：可能是服务器内部超时，任务仍在后台运行
        if (elapsed > 5) {
            console.log(`[Miska] 匹配未命中但耗时 ${elapsed.toFixed(1)}s，任务可能在后台`);
            return "timeout";
        }
        console.log(`[Miska] 匹配未命中 (${elapsed.toFixed(1)}s)`);
        return "miss";
    } catch (err) {
        const isTimeout = err.message === "timeout";
        console.log(`[Miska] 匹配${isTimeout ? "超时" : "异常"}: ${err}`);
        return isTimeout ? "timeout" : "miss";
    }
}

// 调 search/anime 触发后备搜索下载弹幕
async function triggerDownload(server, title) {
    const url = buildUrl(server, "search/anime", { keyword: title });
    console.log(`[Miska] 触发后备搜索下载`);
    try {
        await Widget.http.get(url, { headers: requestHeaders });
    } catch (e) {
        console.log(`[Miska] 后备搜索异常: ${e}`);
    }
}

// 轮询：等待 /match 后台任务下载弹幕入库，确认 comment 有内容才返回
async function pollLibrary(server, title, episode, tmdbId, timeoutSec) {
    const deadline = Date.now() + timeoutSec * 1000;
    const epQuery = { anime: title, episode: episode || "" };
    if (tmdbId) epQuery.tmdbId = String(tmdbId);
    const epUrl = buildUrl(server, "search/episodes", epQuery);

    while (Date.now() < deadline) {
        try {
            const res = await Widget.http.get(epUrl, { headers: requestHeaders });
            if (res && res.data && res.data.animes && res.data.animes.length > 0) {
                // 检查每个 episode 的 comment 是否有实际内容
                for (const anime of res.data.animes) {
                    if (!anime.episodes) continue;
                    for (const ep of anime.episodes) {
                        try {
                            const commentUrl = buildUrl(server, `comment/${ep.episodeId}`, { withRelated: "true", chConvert: "0" });
                            const cRes = await Widget.http.get(commentUrl, { headers: requestHeaders });
                            if (cRes && cRes.data && cRes.data.comments && cRes.data.comments.length > 0) {
                                const elapsed = ((Date.now() - deadline + timeoutSec * 1000) / 1000).toFixed(1);
                                console.log(`[Miska] 弹幕下载完成 (${cRes.data.comments.length}条)，耗时 ${elapsed}s`);
                                return res.data.animes;
                            }
                        } catch (e) { /* 忽略单条 comment 错误 */ }
                    }
                }
            }
        } catch (e) { /* 忽略轮询错误 */ }
        await new Promise(r => setTimeout(r, 3000));
    }
    console.log(`[Miska] 轮询超时 (${timeoutSec}s)`);
    return null;
}

// 整季匹配缓存：key = "title_season"，已成功匹配的季无需重复调 /match
const seasonMatched = new Map();

const requestHeaders = {
    "Content-Type": "application/json",
    "User-Agent": "ForwardWidgets/1.0.0"
};

function parseBlockKeywords(raw) {
    if (!raw || !raw.trim()) return [];
    return raw.split(/[,，]/).map(k => k.trim()).filter(k => k);
}

// ---------------------------------------------------------------------------
// 模块处理函数
// ---------------------------------------------------------------------------

/**
 * 搜索弹幕资源
 * 仅用 search/episodes 查库内弹幕，无结果返回空（让 Forward 触发匹配管道下载）
 */
async function searchDanmu(params) {
    const { server, title: rawTitle, episode, tmdbId, matchTimeout, pollTimeout } = params;
    const title = (rawTitle || "").trim();

    if (!server || !title) return { animes: [] };

    const currentEp = parseInt(episode) || 0;
    const matchWait = Math.max(10, parseInt(matchTimeout) || 90);
    const pollWait = Math.max(10, parseInt(pollTimeout) || 120);

    function cleanTitle(t) {
        return (t || "").replace(/（(?:库内|搜索)[^）]*）/g, "").trim();
    }

    function processAnimes(rawList) {
        if (!rawList || !rawList.length) return [];
        const seen = {};
        const result = [];
        for (const anime of rawList) {
            if (anime.animeTitle) anime.animeTitle = cleanTitle(anime.animeTitle);
            if (currentEp > 0 && anime.episodes && anime.episodes.length > 0) {
                anime.episodes = anime.episodes.filter(ep => {
                    const m = ep.episodeTitle ? ep.episodeTitle.match(/\d+/) : null;
                    return m && parseInt(m[0]) === currentEp;
                });
            }
            const key = anime.animeTitle || String(anime.animeId);
            if (!seen[key] && (!currentEp || (anime.episodes && anime.episodes.length > 0))) {
                seen[key] = true;
                result.push(anime);
            }
        }
        return result;
    }

    const query = { anime: title, episode: episode || "" };
    if (tmdbId) query.tmdbId = String(tmdbId);
    const epUrl = buildUrl(server, "search/episodes", query);

    // 1) 库内搜索
    try {
        const response = await Widget.http.get(epUrl, { headers: requestHeaders });
        if (response && response.data && response.data.animes && response.data.animes.length > 0) {
            const animes = processAnimes(response.data.animes);
            if (animes.length > 0) {
                console.log(`[Miska] 找到 ${animes.length} 个番剧`);
                return { animes };
            }
        }
    } catch (e) {
        console.log(`[Miska] 搜索异常: ${e}`);
    }

    // 2) 库内无结果：匹配 → 触发后备搜索 → 轮询等待下载
    console.log(`[Miska] 库内无匹配: ${title}`);
    const seasonKey = `${title}_${params.season || 0}`;

    let matchResult;
    if (seasonMatched.has(seasonKey)) {
        console.log(`[Miska] 整季缓存命中: ${seasonKey}，跳过 /match`);
        matchResult = "matched";
    } else {
        matchResult = await awaitMatch(server, title, params.season, episode, matchWait);
        if (matchResult !== "miss") {
            seasonMatched.set(seasonKey, true);
        }
    }

    if (matchResult !== "miss") {
        // matched 或 timeout：匹配已/将在后台完成，触发下载并轮询
        await triggerDownload(server, title);
        const pollResult = await pollLibrary(server, title, episode, tmdbId, pollWait);
        if (pollResult) {
            const animes = processAnimes(pollResult);
            if (animes.length > 0) {
                console.log(`[Miska] 匹配后找到 ${animes.length} 个番剧`);
                return { animes };
            }
        }
    }

    console.log(`[Miska] 未找到匹配番剧: ${title}`);
    return { animes: [] };
}

/**
 * 获取番剧详情（分集列表），仅保留当前集
 */
async function getDetailById(params) {
    const { server, animeId, episode } = params;
    if (!server || !animeId) return [];

    // bangumi 端点要求 "A{animeId}" 格式
    const animeIdStr = String(animeId);
    const bangumiId = animeIdStr.startsWith("A") ? animeIdStr : `A${animeIdStr}`;

    try {
        const response = await Widget.http.get(
            buildUrl(server, `bangumi/${bangumiId}`),
            { headers: requestHeaders }
        );
        if (response && response.data && response.data.bangumi) {
            const episodes = response.data.bangumi.episodes || [];
            const ep = episode ? String(episode).trim() : "";
            // 仅保留当前集
            const filtered = ep
                ? episodes.filter(e => String(e.episodeNumber || "") === ep)
                : episodes;
            console.log(`[Miska] 获取到 ${episodes.length} 个分集，过滤后 ${filtered.length} 个`);
            return filtered;
        }
    } catch (e) {
        console.log(`[Miska] getDetailById 异常: ${e}`);
    }
    return [];
}

/**
 * 获取弹幕内容
 * 支持屏蔽词过滤和数量限制
 */
async function getCommentsById(params) {
    const { server, commentId, blockKeywords, maxCount: rawMax } = params;
    if (!server || !commentId) return null;

    try {
        const response = await Widget.http.get(
            buildUrl(server, `comment/${commentId}`, { withRelated: "true", chConvert: "0" }),
            { headers: requestHeaders }
        );
        if (!response || !response.data) return null;

        const data = response.data;
        if (!data.comments) {
            if (data.count === 0) {
                console.log(`[Miska] 弹幕尚未入库 (episodeId=${commentId})，后台可能正在下载`);
            }
            return null;
        }

        console.log(`[Miska] 获取到 ${data.comments.length} 条弹幕`);

        // 屏蔽词过滤
        const keywords = parseBlockKeywords(blockKeywords || "");
        if (keywords.length > 0) {
            const before = data.comments.length;
            data.comments = data.comments.filter(c => !keywords.some(kw => c.m && c.m.includes(kw)));
            console.log(`[Miska] 屏蔽过滤: ${before} → ${data.comments.length}`);
        }

        // 数量限制（间隔均匀采样）
        const maxCount = parseInt(rawMax) || 0;
        if (maxCount > 0 && data.comments.length > maxCount) {
            const step = data.comments.length / maxCount;
            const result = [];
            let acc = 0;
            for (const c of data.comments) {
                acc += 1;
                if (acc >= step) { result.push(c); acc -= step; }
            }
            if (result.length > 0 && result[0] !== data.comments[0]) {
                result[0] = data.comments[0];
            }
            const lastIdx = data.comments.length - 1;
            if (result.length > 1 && result[result.length - 1] !== data.comments[lastIdx]) {
                result[result.length - 1] = data.comments[lastIdx];
            }
            data.comments = result;
            console.log(`[Miska] 截取至 ${data.comments.length} 条`);
        }

        return data;
    } catch (e) {
        console.log(`[Miska] getCommentsById 异常: ${e}`);
        return null;
    }
}
