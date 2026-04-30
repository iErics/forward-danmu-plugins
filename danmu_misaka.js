// Miska 弹幕插件
WidgetMetadata = {
    id: "danmu_misaka",
    title: "Miska 弹幕",
    version: "1.0.0",
    requiredVersion: "0.0.2",
    description: "从 Miska 弹幕服务器获取弹幕数据",
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

// 辅助函数
function buildUrl(server, path, query) {
    var base = server.replace(/\/+$/, "");
    var url = base + "/api/v2/" + path;
    if (!query) return url;
    var parts = [];
    var keys = Object.keys(query);
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i], v = query[k];
        if (v != null && v !== "") parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    }
    if (parts.length) url += "?" + parts.join("&");
    return url;
}

function getHeaders() {
    return {
        "Content-Type": "application/json",
        "User-Agent": "ForwardWidgets/1.0.0"
    };
}

// searchDanmu: 并发搜索两个端点，按标题去重合并
async function searchDanmu(params) {
    var server = params.server, title = (params.title || "").trim();
    if (!server || !title) return { animes: [] };

    var headers = getHeaders();
    var animeUrl = buildUrl(server, "search/anime", { keyword: title, anime: title });
    var epUrl = buildUrl(server, "search/episodes", { anime: title, episode: params.episode || "" });

    console.log("[Miska] 并发搜索");
    var animeData = null, epData = null;
    try {
        var responses = await Promise.all([
            Widget.http.get(animeUrl, { headers: headers }),
            Widget.http.get(epUrl, { headers: headers })
        ]);
        animeData = responses[0] ? responses[0].data : null;
        epData = responses[1] ? responses[1].data : null;
    } catch (e) {
        console.log("[Miska] 搜索异常: " + e);
        return { animes: [] };
    }

    // 按标题去重合并
    var merged = {};
    if (animeData && animeData.animes) {
        for (var i = 0; i < animeData.animes.length; i++) {
            var item = animeData.animes[i], key = (item.animeTitle || "").trim();
            if (key) merged[key] = item;
        }
    }
    if (epData && epData.animes) {
        for (var j = 0; j < epData.animes.length; j++) {
            var epItem = epData.animes[j], key = (epItem.animeTitle || "").trim();
            if (key && !merged[key]) merged[key] = epItem;
        }
    }

    var animes = [];
    var mkeys = Object.keys(merged);
    for (var k = 0; k < mkeys.length; k++) {
        animes.push(merged[mkeys[k]]);
    }

    console.log("[Miska] 搜索到 " + animes.length + " 个番剧");
    return { animes: animes };
}

// getDetailById: 获取番剧分集列表
async function getDetailById(params) {
    var server = params.server, animeId = params.animeId;
    if (!server || !animeId) return [];

    var animeIdStr = String(animeId);
    var bangumiId = animeIdStr.charAt(0) === "A" ? animeIdStr : "A" + animeIdStr;

    try {
        var response = await Widget.http.get(
            buildUrl(server, "bangumi/" + bangumiId),
            { headers: getHeaders() }
        );
        if (response && response.data && response.data.bangumi) {
            return response.data.bangumi.episodes;
        }
    } catch (e) {
        console.log("[Miska] getDetailById 异常: " + e);
    }
    return [];
}

// getCommentsById: 获取弹幕内容
async function getCommentsById(params) {
    var server = params.server, commentId = params.commentId;
    if (!server || !commentId) return null;

    try {
        var response = await Widget.http.get(
            buildUrl(server, "comment/" + commentId, { withRelated: "true", chConvert: "0" }),
            { headers: getHeaders() }
        );
        if (!response || !response.data) return null;

        var data = response.data;

        // 屏蔽词过滤
        var keywords = (params.blockKeywords || "").trim();
        if (keywords && data.comments) {
            var list = keywords.split(/[,，]/).map(function(k) { return k.trim(); }).filter(function(k) { return k; });
            if (list.length > 0) {
                var before = data.comments.length;
                data.comments = data.comments.filter(function(c) {
                    for (var i = 0; i < list.length; i++) {
                        if (c.m && c.m.indexOf(list[i]) !== -1) return false;
                    }
                    return true;
                });
                console.log("[Miska] 屏蔽过滤: " + before + " → " + data.comments.length);
            }
        }

        // 数量限制
        var maxCount = parseInt(params.maxCount) || 0;
        if (maxCount > 0 && data.comments && data.comments.length > maxCount) {
            var step = data.comments.length / maxCount;
            var result = [], acc = 0;
            for (var i = 0; i < data.comments.length; i++) {
                acc += 1;
                if (acc >= step) { result.push(data.comments[i]); acc -= step; }
            }
            if (result.length > 0 && result[0] !== data.comments[0]) result[0] = data.comments[0];
            var last = data.comments.length - 1;
            if (result.length > 1 && result[result.length - 1] !== data.comments[last]) result[result.length - 1] = data.comments[last];
            data.comments = result;
            console.log("[Miska] 截取至 " + data.comments.length + " 条");
        }

        return data;
    } catch (e) {
        console.log("[Miska] getCommentsById 异常: " + e);
        return null;
    }
}
