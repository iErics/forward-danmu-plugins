// Miska 弹幕插件 — 为 Forward 播放器提供 Miska 弹幕服务器支持
// Miska: https://github.com/l429609201/misaka_danmu_server
// 兼容弹弹play API v2 规范

const WidgetMetadata = {
    id: "danmu_misaka",
    title: "Miska 弹幕",
    description: "从 Miska 弹幕服务器获取弹幕数据，支持搜索番剧、获取分集弹幕和按播放时间加载弹幕",
    author: "Forward-Danmu",
    site: "https://github.com/l429609201/misaka_danmu_server",
    version: "1.0.0",
    requiredVersion: "1.0.0",
    modules: [
        {
            id: "searchDanmu",
            title: "搜索弹幕资源",
            description: "根据视频标题在 Miska 服务器中搜索对应的番剧弹幕资源",
            type: "danmu",
            functionName: "searchDanmu",
            cacheDuration: 3600,
            params: []
        },
        {
            id: "getComments",
            title: "获取弹幕分段信息",
            description: "获取番剧的分集列表和弹幕分段信息，支持按需加载",
            type: "danmu",
            functionName: "getComments",
            cacheDuration: 3600,
            params: []
        },
        {
            id: "getDanmuWithSegmentTime",
            title: "获取指定时刻弹幕",
            description: "根据当前播放时间获取对应的弹幕数据",
            type: "danmu",
            functionName: "getDanmuWithSegmentTime",
            cacheDuration: 300,
            params: []
        }
    ],
    globalParams: [
        {
            name: "server",
            title: "服务器地址",
            type: "input",
            description: "Miska 服务器地址，需包含 API 令牌。格式: https://your-server.com/your-token",
            value: ""
        },
        {
            name: "maxCount",
            title: "弹幕数量上限",
            type: "input",
            description: "单次加载的最大弹幕数量，0 表示不限制。超出时按时间均匀采样",
            value: "0"
        },
        {
            name: "blockKeywords",
            title: "屏蔽关键词",
            type: "input",
            description: "包含这些关键词的弹幕将被过滤，多个关键词用逗号分隔",
            value: ""
        }
    ]
};

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 构建 API 请求 URL
 * @param {string} server - 服务器基址（含 token）
 * @param {string} path - API 路径（不含前导斜杠）
 * @param {object} query - 查询参数对象
 * @returns {string} 完整请求 URL
 */
function buildUrl(server, path, query) {
    let base = server.replace(/\/+$/, "");
    let url = `${base}/api/v2/${path}`;
    if (query && Object.keys(query).length > 0) {
        let params = Object.entries(query)
            .filter(([, v]) => v != null && v !== "")
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&");
        if (params) url += "?" + params;
    }
    return url;
}

/**
 * 带重试的 HTTP GET 请求
 * @param {string} url
 * @param {number} retries - 最大重试次数
 * @returns {object|null} 响应数据
 */
async function fetchWithRetry(url, retries) {
    retries = retries || 2;
    let lastError = null;
    for (let i = 0; i <= retries; i++) {
        try {
            let response = await Widget.http.get(url);
            return response.data;
        } catch (e) {
            lastError = e;
            if (i < retries) {
                // 短暂等待后重试
                await new Promise(r => { let t = setTimeout(() => { clearTimeout(t); r(); }, 1000 * (i + 1)); });
            }
        }
    }
    console.log(`[Miska] 请求失败 (已重试${retries}次): ${url} — ${lastError}`);
    return null;
}

/**
 * 解析屏蔽关键词列表
 * @param {string} raw - 逗号分隔的关键词字符串
 * @returns {string[]}
 */
function parseBlockKeywords(raw) {
    if (!raw || !raw.trim()) return [];
    return raw.split(/[,，]/).map(k => k.trim()).filter(k => k.length > 0);
}

/**
 * 检查弹幕内容是否包含屏蔽词
 * @param {string} text - 弹幕文本
 * @param {string[]} keywords - 屏蔽词列表
 * @returns {boolean}
 */
function isBlocked(text, keywords) {
    if (!text || keywords.length === 0) return false;
    return keywords.some(kw => text.includes(kw));
}

/**
 * 按时间均匀采样限制弹幕数量
 * 使用间隔采样法，保持弹幕在时间轴上的均匀分布
 * @param {Array} comments - 弹幕数组
 * @param {number} maxCount - 数量上限
 * @returns {Array}
 */
function limitComments(comments, maxCount) {
    if (maxCount <= 0 || comments.length <= maxCount) return comments;
    let step = comments.length / maxCount;
    let result = [];
    let accumulated = 0;
    for (let i = 0; i < comments.length; i++) {
        accumulated += 1;
        if (accumulated >= step) {
            result.push(comments[i]);
            accumulated -= step;
        }
    }
    // 确保至少包含第一条和最后一条
    if (result.length > 0 && result[0] !== comments[0]) {
        result[0] = comments[0];
    }
    if (result.length > 1 && result[result.length - 1] !== comments[comments.length - 1]) {
        result[result.length - 1] = comments[comments.length - 1];
    }
    return result;
}

/**
 * 将 Miska 弹幕格式转换为 Forward 框架要求的格式
 * Miska/dandanplay 格式: { p: "time,position,color,type", m: "文本", cid: "id" }
 * Forward 直接消费此格式，无需转换。仅做字段规范化。
 */
function normalizeComments(comments) {
    if (!Array.isArray(comments)) return [];
    return comments.map(c => ({
        p: c.p || "",
        m: c.m || "",
        cid: c.cid || ""
    }));
}

// ---------------------------------------------------------------------------
// 模块处理函数
// ---------------------------------------------------------------------------

/**
 * 搜索弹幕资源
 * 根据视频标题在 Miska 服务器中搜索匹配的番剧
 *
 * @param {object} params - 由 Forward 框架注入
 * @param {string} params.title - 视频标题
 * @param {string} params.type - 类型 (tv/movie)
 * @param {string} [params.season] - 季
 * @param {string} [params.episode] - 集
 * @returns {Array} 搜索结果列表
 */
async function searchDanmu(params) {
    let server = params.server || "";
    if (!server) {
        console.log("[Miska] 未配置服务器地址");
        return [];
    }

    let title = (params.title || "").trim();
    if (!title) {
        console.log("[Miska] 搜索标题为空");
        return [];
    }

    // 并发请求两个搜索端点
    // search/anime: 返回番剧级信息（bangumiId、年份等），无分集列表
    // search/episodes: 返回带分集列表的结果
    // 并发获取，用 animeTitle 去重合并
    let animeUrl = buildUrl(server, "search/anime", { keyword: title, anime: title });
    let epUrl = buildUrl(server, "search/episodes", { anime: title, episode: params.episode || "" });

    console.log(`[Miska] 并发搜索: ${animeUrl} | ${epUrl}`);
    let [animeData, epData] = await Promise.all([
        fetchWithRetry(animeUrl),
        fetchWithRetry(epUrl)
    ]);

    let merged = {};

    // 先处理 search/anime 结果（提供 bangumiId）
    if (animeData && animeData.animes) {
        for (let item of animeData.animes) {
            let key = (item.animeTitle || "").trim();
            if (key) {
                merged[key] = {
                    animeId: item.animeId,
                    bangumiId: item.bangumiId,
                    animeTitle: item.animeTitle,
                    imageUrl: item.imageUrl,
                    type: item.type,
                    typeDescription: item.typeDescription,
                    episodeCount: item.episodeCount || 0,
                    rating: item.rating || 0,
                    startDate: item.startDate || "",
                    year: item.year || 0,
                    episodes: []
                };
            }
        }
    }

    // 再处理 search/episodes 结果（提供 episodes 列表）
    if (epData && epData.animes) {
        for (let item of epData.animes) {
            let key = (item.animeTitle || "").trim();
            if (key && merged[key]) {
                // 已存在：补充 episodes
                // search/episodes 不返回 bangumiId，getComments 会用 A{animeId} 格式构造
                merged[key].episodes = item.episodes || [];
            } else if (key) {
                // 仅在 search/episodes 中出现的结果
                merged[key] = {
                    animeId: item.animeId,
                    bangumiId: null,
                    animeTitle: item.animeTitle,
                    imageUrl: item.imageUrl,
                    type: item.type,
                    typeDescription: item.typeDescription,
                    episodeCount: (item.episodes || []).length,
                    rating: 0,
                    startDate: "",
                    year: 0,
                    episodes: item.episodes || []
                };
            }
        }
    }

    let results = Object.values(merged);
    if (results.length === 0) {
        console.log(`[Miska] 未找到匹配番剧: ${title}`);
        return [];
    }

    console.log(`[Miska] 搜索到 ${results.length} 个番剧（去重合并后）`);

    // 转换为 Forward 数据模型
    return results.map(item => ({
        id: item.animeId != null ? String(item.animeId) : "",
        title: item.animeTitle || "",
        posterPath: item.imageUrl || "",
        type: item.type || params.type || "tv",
        mediaType: item.type || params.type || "tv",
        description: item.typeDescription || "",
        rating: item.rating || 0,
        releaseDate: item.startDate || "",
        animeId: item.animeId,
        bangumiId: item.bangumiId,
        episodeCount: item.episodeCount || (item.episodes ? item.episodes.length : 0)
    }));
}

/**
 * 获取弹幕分段信息
 * 获取番剧的分集列表，Forward 框架据此按时间匹配对应分集的弹幕
 *
 * @param {object} params - 由 Forward 框架注入
 * @param {string|number} params.animeId - 番剧 ID（来自 searchDanmu 返回结果）
 * @param {string} [params.commentId] - 当前分集 ID
 * @returns {Array} 分集信息列表
 */
async function getComments(params) {
    let server = params.server || "";
    if (!server) {
        console.log("[Miska] 未配置服务器地址");
        return [];
    }

    let animeId = params.animeId;
    if (!animeId) {
        // 没有 animeId 则无法获取分集信息
        console.log("[Miska] 缺少 animeId 参数");
        return [];
    }

    // bangumi 端点要求 "A{animeId}" 格式
    let bangumiId = String(animeId).startsWith("A") ? String(animeId) : `A${animeId}`;

    // 检查缓存
    let cacheKey = `misaka_bangumi_${bangumiId}`;
    let cached = await Widget.storage.get(cacheKey);
    if (cached) {
        console.log(`[Miska] 命中分集缓存: bangumiId=${bangumiId}`);
        return cached;
    }

    let url = buildUrl(server, `bangumi/${bangumiId}`);
    console.log(`[Miska] 获取番剧详情: ${url}`);
    let data = await fetchWithRetry(url);

    if (!data || !data.bangumi || !data.bangumi.episodes) {
        console.log(`[Miska] 获取分集失败: bangumiId=${bangumiId}`);
        return [];
    }

    let episodes = data.bangumi.episodes;
    console.log(`[Miska] 获取到 ${episodes.length} 个分集`);

    // 构建分集列表，每个分集包含 commentId（即 episodeId）供后续弹幕加载使用
    let result = episodes.map(ep => ({
        id: String(ep.episodeId),
        title: ep.episodeTitle || `第${ep.episodeNumber}集`,
        commentId: ep.episodeId,
        episodeNumber: ep.episodeNumber || "",
        animeId: data.bangumi.animeId || animeId,
        animeTitle: data.bangumi.animeTitle || ""
    }));

    // 写入缓存
    await Widget.storage.set(cacheKey, result);

    return result;
}

/**
 * 获取指定时刻的弹幕
 * 根据当前播放时间和分集 ID 从 Miska 获取对应弹幕数据
 *
 * @param {object} params - 由 Forward 框架注入
 * @param {string|number} params.commentId - 分集 ID (episodeId)
 * @param {string|number} [params.segmentTime] - 当前播放时间（秒）
 * @param {string} params.blockKeywords - 屏蔽关键词（来自 globalParams）
 * @param {string|number} params.maxCount - 数量上限（来自 globalParams）
 * @returns {Array} 弹幕数组（Forward 标准格式）
 */
async function getDanmuWithSegmentTime(params) {
    let server = params.server || "";
    if (!server) {
        console.log("[Miska] 未配置服务器地址");
        return [];
    }

    let commentId = params.commentId;
    if (!commentId) {
        console.log("[Miska] 缺少 commentId 参数");
        return [];
    }

    let maxCount = parseInt(params.maxCount) || 0;
    let blockKeywords = parseBlockKeywords(params.blockKeywords || "");

    // 获取全部弹幕，Forward 框架自行处理时间轴渲染
    // withRelated=true: 获取关联弹幕
    // chConvert=0: 服务端不做繁简转换
    let query = {
        withRelated: "true",
        chConvert: "0"
    };

    let url = buildUrl(server, `comment/${commentId}`, query);
    console.log(`[Miska] 获取弹幕: ${url}`);
    let data = await fetchWithRetry(url, 1);

    if (!data || !data.comments) {
        // 弹幕未入库时 Miska 返回 count=0 / comments=[]
        if (data && data.count === 0) {
            console.log(`[Miska] 弹幕尚未入库 (episodeId=${commentId})，Miska 后台可能正在下载`);
        } else {
            console.log(`[Miska] 获取弹幕失败: episodeId=${commentId}`);
        }
        return [];
    }

    let comments = normalizeComments(data.comments);
    console.log(`[Miska] 获取到 ${comments.length} 条弹幕 (episodeId=${commentId})`);

    // 过滤屏蔽词
    if (blockKeywords.length > 0) {
        let before = comments.length;
        comments = comments.filter(c => !isBlocked(c.m, blockKeywords));
        if (comments.length < before) {
            console.log(`[Miska] 屏蔽词过滤: ${before} → ${comments.length}`);
        }
    }

    // 限制数量
    if (maxCount > 0 && comments.length > maxCount) {
        comments = limitComments(comments, maxCount);
        console.log(`[Miska] 数量限制: 截取至 ${comments.length} 条`);
    }

    return comments;
}
