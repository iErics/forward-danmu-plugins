// Miska 弹幕插件 — 为 Forward 播放器提供 Miska 弹幕服务器支持
// Miska: https://github.com/l429609201/misaka_danmu_server
// 兼容弹弹play API v2 规范

const WidgetMetadata = {
    id: "danmu_misaka",
    title: "Miska 弹幕",
    version: "1.0.0",
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
            name: "maxCount",
            title: "弹幕数量上限",
            type: "input",
            defaultValue: "0",
            description: "0 表示不限制，超出时按时间均匀采样"
        },
        {
            name: "blockKeywords",
            title: "屏蔽关键词",
            type: "input",
            description: "包含这些关键词的弹幕将被过滤，逗号分隔"
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
    var base = server.replace(/\/+$/, "");
    var url = base + "/api/v2/" + path;
    if (query) {
        var keys = Object.keys(query);
        if (keys.length > 0) {
            var parts = [];
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                var v = query[k];
                if (v != null && v !== "") {
                    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
                }
            }
            if (parts.length > 0) {
                url += "?" + parts.join("&");
            }
        }
    }
    return url;
}

function getHeaders() {
    return {
        "Content-Type": "application/json",
        "User-Agent": "ForwardWidgets/1.0.0"
    };
}

function parseBlockKeywords(raw) {
    if (!raw || !raw.trim()) return [];
    return raw.split(/[,，]/).map(function(k) { return k.trim(); }).filter(function(k) { return k.length > 0; });
}

function isBlocked(text, keywords) {
    if (!text || keywords.length === 0) return false;
    for (var i = 0; i < keywords.length; i++) {
        if (text.indexOf(keywords[i]) !== -1) return true;
    }
    return false;
}

function limitComments(comments, maxCount) {
    if (maxCount <= 0 || comments.length <= maxCount) return comments;
    var step = comments.length / maxCount;
    var result = [];
    var accumulated = 0;
    for (var i = 0; i < comments.length; i++) {
        accumulated += 1;
        if (accumulated >= step) {
            result.push(comments[i]);
            accumulated -= step;
        }
    }
    if (result.length > 0 && result[0] !== comments[0]) {
        result[0] = comments[0];
    }
    if (result.length > 1 && result[result.length - 1] !== comments[comments.length - 1]) {
        result[result.length - 1] = comments[comments.length - 1];
    }
    return result;
}

// ---------------------------------------------------------------------------
// 模块处理函数
// ---------------------------------------------------------------------------

/**
 * 搜索弹幕资源
 * 并发请求 search/anime 和 search/episodes，按标题去重合并
 * @returns {{animes: Array}} 包装对象
 */
async function searchDanmu(params) {
    var server = params.server || "";
    if (!server) {
        throw new Error("请配置 Miska 服务器地址");
    }

    var title = (params.title || "").trim();
    if (!title) {
        return { animes: [] };
    }

    // 并发请求两个端点
    var animeUrl = buildUrl(server, "search/anime", { keyword: title, anime: title });
    var epUrl = buildUrl(server, "search/episodes", { anime: title, episode: params.episode || "" });

    console.log("[Miska] 并发搜索: " + animeUrl + " | " + epUrl);

    var animeData = null;
    var epData = null;
    try {
        var responses = await Promise.all([
            Widget.http.get(animeUrl, { headers: getHeaders() }),
            Widget.http.get(epUrl, { headers: getHeaders() })
        ]);
        animeData = responses[0] ? responses[0].data : null;
        epData = responses[1] ? responses[1].data : null;
    } catch (e) {
        console.log("[Miska] 搜索请求异常: " + e);
        throw new Error("搜索请求失败: " + (e.message || "网络错误"));
    }

    // 用 animeTitle 去重合并
    var merged = {};
    var key;

    // search/anime: 提供 bangumiId
    if (animeData && animeData.animes) {
        for (var i = 0; i < animeData.animes.length; i++) {
            var item = animeData.animes[i];
            key = (item.animeTitle || "").trim();
            if (key) {
                merged[key] = {
                    animeId: item.animeId,
                    bangumiId: item.bangumiId,
                    animeTitle: item.animeTitle,
                    imageUrl: item.imageUrl || "",
                    type: item.type || "",
                    typeDescription: item.typeDescription || "",
                    episodeCount: item.episodeCount || 0,
                    rating: item.rating || 0,
                    startDate: item.startDate || "",
                    year: item.year || 0
                };
            }
        }
    }

    // search/episodes: 提供分集列表
    if (epData && epData.animes) {
        for (var j = 0; j < epData.animes.length; j++) {
            var epItem = epData.animes[j];
            key = (epItem.animeTitle || "").trim();
            if (key && merged[key]) {
                // 已存在，补充分集数量和 animeId
                if (!merged[key].animeId && epItem.animeId) {
                    merged[key].animeId = epItem.animeId;
                }
                if (epItem.episodes) {
                    merged[key].episodeCount = epItem.episodes.length;
                }
            } else if (key) {
                merged[key] = {
                    animeId: epItem.animeId,
                    bangumiId: null,
                    animeTitle: epItem.animeTitle,
                    imageUrl: epItem.imageUrl || "",
                    type: epItem.type || "",
                    typeDescription: epItem.typeDescription || "",
                    episodeCount: (epItem.episodes || []).length,
                    rating: 0,
                    startDate: "",
                    year: 0
                };
            }
        }
    }

    var keys = Object.keys(merged);
    var animes = [];
    for (var k = 0; k < keys.length; k++) {
        var m = merged[keys[k]];
        animes.push({
            id: m.animeId != null ? String(m.animeId) : "",
            title: m.animeTitle || "",
            posterPath: m.imageUrl || "",
            type: m.type || params.type || "tv",
            mediaType: m.type || params.type || "tv",
            description: m.typeDescription || "",
            rating: m.rating || 0,
            releaseDate: m.startDate || "",
            animeId: m.animeId,
            bangumiId: m.bangumiId,
            episodeCount: m.episodeCount || 0
        });
    }

    console.log("[Miska] 搜索到 " + animes.length + " 个番剧（去重合并后）");

    if (animes.length === 0) {
        return { animes: [] };
    }

    return { animes: animes };
}

/**
 * 获取番剧详情（分集列表）
 * @returns {Array} episodes 数组
 */
async function getDetailById(params) {
    var server = params.server || "";
    if (!server) {
        throw new Error("请配置 Miska 服务器地址");
    }

    var animeId = params.animeId;
    if (!animeId) {
        console.log("[Miska] getDetailById: 缺少 animeId");
        return [];
    }

    // bangumi 端点要求 "A{animeId}" 格式
    var animeIdStr = String(animeId);
    var bangumiId = animeIdStr.charAt(0) === "A" ? animeIdStr : "A" + animeIdStr;

    var url = buildUrl(server, "bangumi/" + bangumiId);
    console.log("[Miska] 获取番剧详情: " + url);

    var response;
    try {
        response = await Widget.http.get(url, { headers: getHeaders() });
    } catch (e) {
        console.log("[Miska] getDetailById 请求异常: " + e);
        return [];
    }

    if (!response) {
        return [];
    }

    var data = response.data;
    if (!data || !data.bangumi || !data.bangumi.episodes) {
        console.log("[Miska] 获取分集失败: bangumiId=" + bangumiId);
        return [];
    }

    console.log("[Miska] 获取到 " + data.bangumi.episodes.length + " 个分集");
    return data.bangumi.episodes;
}

/**
 * 获取弹幕内容
 * @returns {object} 弹幕响应数据（含 comments 数组）
 */
async function getCommentsById(params) {
    var server = params.server || "";
    if (!server) {
        throw new Error("请配置 Miska 服务器地址");
    }

    var commentId = params.commentId;
    if (!commentId) {
        return null;
    }

    var url = buildUrl(server, "comment/" + commentId, {
        withRelated: "true",
        chConvert: "0"
    });

    console.log("[Miska] 获取弹幕: " + url);

    var response;
    try {
        response = await Widget.http.get(url, { headers: getHeaders() });
    } catch (e) {
        console.log("[Miska] getCommentsById 请求异常: " + e);
        return null;
    }

    if (!response) {
        return null;
    }

    var data = response.data;
    if (!data || !data.comments) {
        if (data && data.count === 0) {
            console.log("[Miska] 弹幕尚未入库 (episodeId=" + commentId + ")，Miska 后台可能正在下载");
        } else {
            console.log("[Miska] 获取弹幕失败: episodeId=" + commentId);
        }
        return null;
    }

    var comments = data.comments;
    console.log("[Miska] 获取到 " + comments.length + " 条弹幕 (episodeId=" + commentId + ")");

    // 屏蔽词过滤
    var blockKeywords = parseBlockKeywords(params.blockKeywords || "");
    if (blockKeywords.length > 0) {
        var before = comments.length;
        comments = comments.filter(function(c) {
            return !isBlocked(c.m, blockKeywords);
        });
        if (comments.length < before) {
            console.log("[Miska] 屏蔽词过滤: " + before + " → " + comments.length);
        }
    }

    // 数量限制
    var maxCount = parseInt(params.maxCount) || 0;
    if (maxCount > 0 && comments.length > maxCount) {
        comments = limitComments(comments, maxCount);
        console.log("[Miska] 数量限制: 截取至 " + comments.length + " 条");
    }

    data.comments = comments;
    return data;
}
