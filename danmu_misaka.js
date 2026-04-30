// Miska 弹幕插件 — 为 Forward 播放器提供 Miska 弹幕服务器支持
// Miska: https://github.com/l429609201/misaka_danmu_server
// 兼容弹弹play API v2 规范

WidgetMetadata = {
    id: "miska.danmu",
    title: "Miska 弹幕",
    version: "1.0.5",
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
 * 优先 search/episodes（库内），无结果时降级 search/anime（后备）
 */
async function searchDanmu(params) {
    const { server, title: rawTitle, episode } = params;
    const title = (rawTitle || "").trim();

    if (!server || !title) return { animes: [] };

    const currentEp = parseInt(episode) || 0;

    // 1) 优先从库内搜索
    const epUrl = buildUrl(server, "search/episodes", { anime: title, episode: episode || "" });
    console.log(`[Miska] 库内搜索: ${epUrl}`);

    try {
        const epRes = await Widget.http.get(epUrl, { headers: requestHeaders });
        if (epRes && epRes.data && epRes.data.animes && epRes.data.animes.length > 0) {
            const animes = epRes.data.animes.map(anime => {
                if (anime.animeTitle) {
                    anime.animeTitle = anime.animeTitle.replace(/（(?:库内|搜索)：\d+）/g, "").trim();
                }
                if (currentEp > 0 && anime.episodes && anime.episodes.length > 0) {
                    anime.episodes = anime.episodes.filter(ep => {
                        const m = ep.episodeTitle ? ep.episodeTitle.match(/\d+/) : null;
                        return m && parseInt(m[0]) === currentEp;
                    });
                }
                return anime;
            });
            console.log(`[Miska] 库内找到 ${animes.length} 个番剧`);
            return { animes };
        }
    } catch (e) {
        console.log(`[Miska] 库内搜索异常: ${e}`);
    }

    // 2) 后备：search/anime 全网搜索
    console.log(`[Miska] 库内无结果，执行后备搜索`);
    const animeUrl = buildUrl(server, "search/anime", { keyword: title, anime: title });

    try {
        const animeRes = await Widget.http.get(animeUrl, { headers: requestHeaders });
        if (animeRes && animeRes.data && animeRes.data.animes) {
            const animes = animeRes.data.animes.map(anime => {
                if (anime.animeTitle) {
                    anime.animeTitle = anime.animeTitle.replace(/（(?:库内|搜索)：\d+）/g, "").trim();
                }
                return anime;
            });
            console.log(`[Miska] 后备搜索找到 ${animes.length} 个番剧`);
            return { animes };
        }
    } catch (e) {
        console.log(`[Miska] 后备搜索异常: ${e}`);
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
