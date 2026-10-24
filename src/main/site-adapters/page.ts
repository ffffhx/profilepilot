import type { SitePlan, SiteResult } from "./catalog";

/** Runs entirely in the selected tab's MAIN world. No Node network client,
 * cookie export, remote crawler, arbitrary endpoint or user-supplied code. */
export async function readSitePage(plan: SitePlan): Promise<SiteResult> {
  const { operation: op, params: p } = plan;
  const result: SiteResult = { version: 1, operation: op, status: "ok",
    source: { url: location.href, method: "browser-fetch", checkedAt: new Date().toISOString() }, effective: p,
    items: [], pagination: { next: null, hasMore: false }, completeness: { scope: "requested-page", complete: true, reasons: [] } };
  const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { siteCode: code }); };
  const access = (origin: string) => {
    if (plan.access?.blockedOrigins?.includes(origin) || plan.access?.allowedOrigins?.length && !plan.access.allowedOrigins.includes(origin)) fail("ACCESS_BLOCKED", "此来源被任务的网站访问设置限制。");
  };
  const partial = (reason: string) => { result.status = "partial"; result.completeness.complete = false; result.completeness.reasons.push(reason); };
  let remainingOnPage = false;
  const array = (v: any): any[] => Array.isArray(v) ? v : fail("SCHEMA_CHANGED", "网站返回结构与适配器预期不符。");
  const text = (v: any): string => {
    if (v == null) return "";
    const doc = new DOMParser().parseFromString(String(v), "text/html");
    doc.querySelectorAll("script,style").forEach(e => e.remove());
    return (doc.body.textContent || "").trim();
  };
  const json = (raw: string) => JSON.parse(raw.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token =>
    token[0] !== '"' && /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token));
  const pageMore = (hasMore: boolean | null, next: Record<string, unknown> | null) => { result.pagination = { hasMore, next }; };
  const fetchText = async (url: string, headers?: Record<string, string>) => {
    const target = new URL(url, location.href);
    access(target.origin);
    const allowed = new Set([...plan.hosts, ...(op.startsWith("bilibili.") ? ["api.bilibili.com"] : [])]);
    if (target.protocol !== "https:" || !allowed.has(target.hostname) || target.username || target.password || target.port) fail("ORIGIN_MISMATCH", "接口不属于当前网站。");
    const response = await fetch(target.href, { credentials: "include", headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) fail([401, 403, 412, 429].includes(response.status) ? "ACCESS_BLOCKED" : "HTTP_ERROR", `网站返回 HTTP ${response.status}。`);
    if (!allowed.has(new URL(response.url).hostname)) fail("ACCESS_BLOCKED", "请求被重定向到其他网站，请检查当前页面。");
    access(new URL(response.url).origin);
    const raw = await response.text();
    if (raw.length > 8000000) fail("RESPONSE_TOO_LARGE", "网站返回过大，请缩小读取范围。");
    return raw;
  };
  const fetchJson = async (url: string) => {
    const raw = await fetchText(url);
    try { return json(raw); } catch { return fail("NOT_JSON", "网站未返回 JSON，可能需要登录或验证；请查看当前页面。"); }
  };
  const endpoint = (base: string, args: Record<string, any>) => base + "?" + new URLSearchParams(Object.entries(args).filter(([,v]) => v !== undefined).map(([k,v]) => [k, String(v)]));
  const checkCode = (d: any) => { if (d.code !== 0) fail("ACCESS_BLOCKED", `网站拒绝请求（${String(d.code)}）：${text(d.message || d.msg || "请查看当前页面")}`); return d; };
  const list = (items: any[]) => {
    const start = p.itemOffset || 0, end = start + (p.limit ?? items.length);
    result.items = items.slice(start, end);
    if (items.length > end) { partial("结果受 limit 限制；未返回的记录仍在本页中。"); remainingOnPage = p.itemOffset !== undefined; }
  };
  const href = (value: any, base = location.href) => { try { const u = new URL(String(value || ""), base); return ["https:", "http:"].includes(u.protocol) ? u.href : ""; } catch { return ""; } };
  const walk = (root: any, key: string): any[] => {
    const found: any[] = [], pending = [root]; let visited = 0;
    while (pending.length && visited++ < 50000) { const v = pending.pop(); if (!v || typeof v !== "object") continue; if (v[key]) found.push(v[key]);
      for (const [k, child] of Object.entries(v)) if (k !== key && child && typeof child === "object") pending.push(child); }
    return found;
  };
  try {
    access(location.origin);
    if (!plan.hosts.includes(location.hostname) || location.protocol !== "https:") fail("ORIGIN_MISMATCH", "当前页面已离开适配器网站；停止读取。");
    if (/passport|\/sorry|\/antispider/i.test(location.pathname) || !plan.reuseOrigin && /\/signin|\/login/.test(location.pathname)) fail("ACCESS_BLOCKED", "当前页面要求登录或验证。");
    if (op === "boss.search") {
      const d = checkCode(await fetchJson(endpoint("/wapi/zpgeek/search/joblist.json", { scene: 1, query: p.query, city: p.city, page: p.page, pageSize: p.limit })));
      const jobs = array(d.zpData?.jobList);
      list(jobs.map(j => ({ id: String(j.encryptJobId), securityId: j.securityId, title: text(j.jobName), salary: j.salaryDesc,
        company: j.brandName, city: j.cityName, district: j.areaDistrict, experience: j.jobExperience, degree: j.jobDegree,
        skills: j.skills || [], benefits: j.welfareList || [], industry: j.brandIndustry, companySize: j.brandScaleName,
        url: `https://www.zhipin.com/job_detail/${j.encryptJobId}.html` })));
      const more = typeof d.zpData.hasMore === "boolean" ? d.zpData.hasMore : Number.isFinite(d.zpData.totalCount) ? p.page * p.limit < d.zpData.totalCount : null;
      pageMore(more, more === false ? null : { ...p, page: p.page + 1 });
    } else if (op === "boss.detail") {
      const d = checkCode(await fetchJson(endpoint("/wapi/zpgeek/job/detail.json", { securityId: p.securityId }))).zpData;
      if (!d?.jobInfo?.postDescription) fail("SCHEMA_CHANGED", "未取得岗位正文。");
      if (d.jobInfo.encryptId && d.jobInfo.encryptId !== p.id) fail("RESULT_MISMATCH", "详情与请求岗位不一致。");
      result.items = [{ id: p.id, title: d.jobInfo.jobName, salary: d.jobInfo.salaryDesc, description: text(d.jobInfo.postDescription),
        experience: d.jobInfo.experienceName, degree: d.jobInfo.degreeName, address: d.jobInfo.address,
        company: d.brandComInfo?.brandName, status: d.jobInfo.status, url: `https://www.zhipin.com/job_detail/${p.id}.html` }];
    } else if (op.startsWith("bilibili.")) {
      if (op === "bilibili.search") {
        const d = checkCode(await fetchJson(endpoint("https://api.bilibili.com/x/web-interface/wbi/search/type", { search_type: "video", keyword: p.query, page: p.page, page_size: p.limit, order: p.sort }))).data;
        list(array(d?.result).filter(v => v.type === "video" || v.bvid).map(v => ({ id: v.bvid, title: text(v.title), author: v.author, description: text(v.description),
          duration: v.duration, views: v.play, publishedAt: v.pubdate, url: `https://www.bilibili.com/video/${v.bvid}` })));
        const more = Number.isFinite(d.numPages) ? p.page < d.numPages : null;
        pageMore(more, more === false ? null : { ...p, page: p.page + 1 });
      } else {
        const v = checkCode(await fetchJson(endpoint("https://api.bilibili.com/x/web-interface/view", { bvid: p.id }))).data;
        if (v?.bvid !== p.id) fail("RESULT_MISMATCH", "未获得对应视频。");
        if (op === "bilibili.detail") result.items = [{ id: v.bvid, aid: String(v.aid), title: v.title, description: v.desc, author: v.owner?.name,
          durationSeconds: v.duration, publishedAt: v.pubdate, stats: v.stat, parts: v.pages?.map((a: any) => ({ page: a.page, title: a.part, durationSeconds: a.duration })), url: `https://www.bilibili.com/video/${v.bvid}` }];
        else {
          const d = checkCode(await fetchJson(endpoint("https://api.bilibili.com/x/v2/reply", { type: 1, oid: v.aid, pn: p.page, ps: p.limit, sort: p.sort === "hot" ? 2 : 0 }))).data;
          const map = (r: any): any => ({ id: String(r.rpid_str || r.rpid), parentId: String(r.parent_str || r.parent || "0"), author: r.member?.uname,
            text: r.content?.message, likes: r.like, replyCount: r.rcount, replies: (r.replies || []).map(map), publishedAt: r.ctime });
          list(array(d?.replies ?? (d?.page?.count === 0 ? [] : undefined)).map(map));
          const more = typeof d.page?.count === "number" ? p.page * p.limit < d.page.count : null;
          pageMore(more, more === false ? null : { ...p, page: p.page + 1 });
          result.completeness.scope = "top-level-comment-page";
          if (result.items.some(r => r.replyCount > r.replies.length)) partial("楼中楼只包含接口返回的预览，尚未读取全部回复。");
        }
      }
    } else if (op === "zhihu.hot") {
      const d = await fetchJson(endpoint("/api/v3/feed/topstory/hot-lists/total", { limit: p.limit }));
      list(array(d.data).map((r: any, index: number) => ({ rank: index + 1, id: String(r.target?.id), title: r.target?.title,
        excerpt: text(r.target?.excerpt), heat: r.detail_text, answers: r.target?.answer_count, url: `https://www.zhihu.com/question/${r.target?.id}` })));
      result.completeness.scope = "requested-hot-list";
    } else if (op === "zhihu.search") {
      const d = await fetchJson(endpoint("/api/v4/search_v3", { q: p.query, t: "general", offset: p.offset, limit: p.limit }));
      list(array(d.data).filter(v => v.type === "search_result").map(v => { const o = v.object || {}, kind = o.type;
        return { id: String(o.id), kind, title: text(o.title || o.question?.title), excerpt: text(o.excerpt || v.highlight?.description),
          author: o.author?.name, votes: o.voteup_count, url: kind === "answer" ? `https://www.zhihu.com/question/${o.question?.id}/answer/${o.id}` : kind === "article" ? `https://zhuanlan.zhihu.com/p/${o.id}` : kind === "question" ? `https://www.zhihu.com/question/${o.id}` : href(o.url) }; }));
      const more = typeof d.paging?.is_end === "boolean" ? !d.paging.is_end : null;
      let offset = p.offset + p.limit;
      if (d.paging?.next) { const candidate = Number(new URL(d.paging.next, location.href).searchParams.get("offset")); if (Number.isInteger(candidate) && candidate > p.offset) offset = candidate; }
      pageMore(more, more === false ? null : { ...p, offset });
    } else if (op === "smzdm.search") {
      const raw = await fetchText(endpoint("/ajax/", { c: "youhui", s: p.query, p: p.page, v: "b" }), { "X-Requested-With": "XMLHttpRequest" });
      if (/probe\.js|访问过于频繁|安全验证|验证码/.test(raw)) fail("ACCESS_BLOCKED", "优惠搜索要求验证。");
      const doc = new DOMParser().parseFromString(raw, "text/html"), rows = [...doc.querySelectorAll("li.feed-row-wide, .feed-row-wide")];
      if (!rows.length && !/暂无|没有找到|无相关|没有更多/.test(text(raw))) fail("SCHEMA_CHANGED", "未识别到优惠列表或明确的空结果标记。");
      list(rows.map(r => { const a = r.querySelector<HTMLAnchorElement>("h5 a, h3 a, .feed-block-title a"), extras = r.querySelector(".feed-block-extras");
        const timestamp = extras ? [...extras.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent || "").join(" ").trim() : "";
        return {
        title: a?.textContent?.trim(), url: href(a?.getAttribute("href"), "https://www.smzdm.com/"), priceText: r.querySelector(".z-highlight, .feed-block-price")?.textContent?.trim(),
        mall: extras?.querySelector("a, span")?.textContent?.trim(), publishedAt: timestamp || r.querySelector(".feed-block-time")?.textContent?.trim(),
        description: r.querySelector(".feed-block-descripe, .feed-block-describe")?.textContent?.trim(), kind: "deal", priceVerified: false }; }));
      pageMore(rows.length ? null : false, rows.length ? { ...p, page: p.page + 1, itemOffset: 0 } : null);
    } else if (op === "reddit.search") {
      const d = await fetchJson(endpoint(p.subreddit ? `/r/${p.subreddit}/search.json` : "/search.json", { q: p.query, restrict_sr: p.subreddit ? "on" : undefined, sort: p.sort, t: p.time, after: p.cursor, limit: p.limit, raw_json: 1 }));
      list(array(d.data?.children).filter(v => v.kind === "t3").map(({data: r}) => ({ id: r.id, fullname: r.name, title: r.title, subreddit: r.subreddit,
        author: r.author, score: r.score, commentCount: r.num_comments, publishedAt: r.created_utc, excerpt: r.selftext?.slice(0, 500),
        url: href(r.permalink, "https://www.reddit.com"), linkedUrl: href(r.url) })));
      pageMore(Boolean(d.data.after), d.data.after ? { ...p, cursor: d.data.after } : null);
    } else if (op === "reddit.thread") {
      const d = await fetchJson(endpoint(`/comments/${p.id}.json`, { limit: p.limit, depth: p.depth, raw_json: 1 }));
      const post = d?.[0]?.data?.children?.[0]?.data;
      if (!post || post.id !== p.id) fail("RESULT_MISMATCH", "未获得对应帖子。");
      let count = 0, omitted = 0;
      const comments = (children: any[], depth: number): any[] => children.flatMap(c => {
        if (c.kind === "more") { omitted += c.data?.count || 1; return []; }
        if (c.kind !== "t1") return [];
        if (depth > p.depth || count >= p.limit) { omitted++; return []; }
        count++; const r = c.data;
        return [{ id: r.name, parentId: r.parent_id, author: r.author, text: r.body, score: r.score, publishedAt: r.created_utc, depth,
          replies: comments(r.replies?.data?.children || [], depth + 1) }];
      });
      const tree = comments(array(d?.[1]?.data?.children), 1);
      result.items = [{ id: post.id, title: post.title, text: post.selftext, author: post.author, subreddit: post.subreddit,
        score: post.score, commentCount: post.num_comments, url: href(post.permalink, "https://www.reddit.com"), comments: tree, returnedComments: count, omittedCommentsAtLeast: omitted }];
      result.completeness.scope = "post-and-requested-comment-tree";
      if (omitted || post.num_comments > count) { partial("评论树受数量、深度、折叠或删除限制，未宣称全部评论。"); pageMore(true, null); }
    } else if (op.startsWith("xiaohongshu.")) {
      result.source.method = "page-state"; result.completeness.scope = "currently-loaded-content";
      const w = window as any, app = (document.querySelector("#app") as any)?.__vue_app__, stores = app?.config?.globalProperties?.$pinia?._s;
      const unwrap = (v: any) => v?._value ?? v?.value ?? v;
      const initial = w.__INITIAL_STATE__;
      const store = (name: string) => stores?.get?.(name) || initial?.[name];
      if (op === "xiaohongshu.search") {
        if (new URL(location.href).searchParams.get("keyword") !== p.query) fail("RESULT_MISMATCH", "页面搜索词与请求不一致。");
        const search = store("search"), context = unwrap(search?.searchContext);
        if (context?.keyword && context.keyword !== p.query || search?.state === "loading") fail("NOT_READY", "搜索状态仍在切换，尚未读取新搜索词的结果。");
        if (["error", "failed"].includes(search?.state)) fail("ACCESS_BLOCKED", "页面搜索失败，请检查网站的登录或验证提示。");
        const sorts: Record<string, string> = { general: "general", latest: "time_descending", likes: "popularity_descending", comments: "comment_descending", collects: "collect_descending" };
        const applied = unwrap(search?.filterParams)?.find((f: any) => f.type === "sort_type")?.tags?.[0];
        if (applied && applied !== sorts[p.sort] || !applied && p.sort !== "general") fail("SORT_UNVERIFIED", "未能确认指定排序生效，未返回可能属于其他排序的列表。");
        result.effective = { ...p, sortVerified: Boolean(applied), filters: search?.filterParams ? JSON.parse(JSON.stringify(unwrap(search.filterParams))) : null };
        const data = unwrap(search?.feeds);
        if (Array.isArray(data) && !data.length && search?.state === "success" && search?.hasMore === false) { result.status = "empty"; return result; }
        if (!Array.isArray(data) || !data.length) {
          result.source.method = "dom";
          const cards = [...document.querySelectorAll("section.note-item")];
          if (!cards.length) fail(/登录/.test(document.body.innerText) ? "ACCESS_BLOCKED" : "NOT_READY", "尚未取得笔记列表，可能需要登录或等待页面加载。");
          list(cards.map(c => { const a = c.querySelector<HTMLAnchorElement>('a[href*="/explore/"], a[href*="/search_result/"]');
            const noteUrl = href(a?.getAttribute("href")).replace(/\/search_result\/([a-f0-9]{24})/, "/explore/$1"); return {
            title: c.querySelector(".title")?.textContent?.trim(), author: c.querySelector(".author .name")?.textContent?.trim(),
            likes: c.querySelector(".like-wrapper .count")?.textContent?.trim(), url: noteUrl }; }));
        } else list(data.filter(v => v.noteCard || v.note_card).map((v, index) => { const n = v.noteCard || v.note_card, title = n.displayTitle || n.display_title || n.title || null; return {
          id: String(v.id), rank: index + 1, title, titleStatus: title ? "present" : "missing", author: n.user?.nickname, likes: n.interactInfo?.likedCount ?? n.interact_info?.liked_count,
          kind: n.type, url: `https://www.xiaohongshu.com/explore/${v.id}?${new URLSearchParams({ xsec_token: v.xsecToken || v.xsec_token || "", xsec_source: "pc_search" })}` }; }));
        result.items = result.items.map((item, index) => ({ ...item, rank: item.rank ?? p.itemOffset + index + 1, title: item.title || null, titleStatus: item.title ? "present" : "missing" }));
        partial("返回当前已加载的搜索候选，未自动滚动读取全部搜索结果。titleStatus=missing 表示该候选没有可读标题，重复读取同一列表不能补出标题。");
        pageMore(typeof search?.hasMore === "boolean" ? search.hasMore : null, null);
      } else {
        const noteId = new URL(p.url).pathname.split("/").filter(Boolean).at(-1)!;
        if (!location.pathname.includes(noteId)) fail("RESULT_MISMATCH", "当前页面与请求笔记不一致。");
        const entry = unwrap(store("note")?.noteDetailMap)?.[noteId], n = unwrap(entry?.note);
        if (op === "xiaohongshu.detail") {
          if (n) result.items = [{ id: noteId, title: n.title, text: n.desc, author: n.user?.nickname, kind: n.type, publishedAt: n.time, stats: n.interactInfo, url: p.url }];
          else { result.source.method = "dom"; const content = document.querySelector("#detail-desc, .note-content #detail-desc"), title = document.querySelector("#detail-title");
            if (!content) fail("NOT_READY", "尚未取得笔记详情；请检查登录、链接有效性和页面加载状态。");
            result.items = [{ id: noteId, title: title?.textContent?.trim(), text: content!.textContent?.trim(), author: document.querySelector(".author-container .username")?.textContent?.trim(), url: p.url }]; }
        } else {
          const comments = unwrap(entry?.comments)?.list || unwrap(entry?.comments);
          if (Array.isArray(comments) && !comments.length) {
            if (unwrap(entry?.comments)?.firstRequestFinish === true && unwrap(entry?.comments)?.hasMore === false && document.querySelector(".no-comments")) {
              result.status = "empty"; result.completeness.scope = "visible-comment-list"; return result;
            }
            fail("NOT_READY", "评论尚未加载，等待页面评论列表。");
          }
          if (Array.isArray(comments)) list(comments.map(c => ({ id: c.id, text: c.content, author: c.userInfo?.nickname || c.user_info?.nickname,
            likes: c.likeCount ?? c.like_count, replies: (c.subComments || c.sub_comments || []).map((r: any) => ({ id: r.id, text: r.content, author: r.userInfo?.nickname || r.user_info?.nickname })) })));
          else { result.source.method = "dom"; const cards = [...document.querySelectorAll(".comment-item")];
            if (!cards.length) fail("NOT_READY", "未获得评论列表，不能将尚未加载当成无评论。");
            list(cards.map(c => ({ id: c.id, text: c.querySelector(".content")?.textContent?.trim(), author: c.querySelector(".name")?.textContent?.trim() }))); }
          partial("只返回已加载评论及回复，未验证全部评论。"); pageMore(null, null);
        }
      }
    } else if (op === "wechat.search") {
      const raw = await fetchText(endpoint("/weixin", { type: 2, query: p.query, page: p.page }));
      if (/antispider|访问过于频繁|请输入验证码/.test(raw)) fail("ACCESS_BLOCKED", "搜狗要求验证，请检查浏览器页面。");
      const doc = new DOMParser().parseFromString(raw, "text/html"), cards = [...doc.querySelectorAll(".news-list li")];
      if (!cards.length && !/没有找到|未找到|暂无相关/.test(text(raw))) fail("SCHEMA_CHANGED", "未识别到文章结果或明确的空结果提示。");
      list(cards.map(c => { const a = c.querySelector<HTMLAnchorElement>("h3 a"); return { title: text(a?.innerHTML), url: href(a?.getAttribute("href"), "https://weixin.sogou.com"),
        account: c.querySelector(".account")?.textContent?.trim(), excerpt: c.querySelector(".txt-info")?.textContent?.trim(), publishedAt: c.querySelector(".s-p")?.textContent?.trim(), kind: "wechat-article" }; }));
      const more = Boolean(doc.querySelector("#sogou_next")); pageMore(more, more ? { ...p, page: p.page + 1, itemOffset: 0 } : null);
    } else if (op === "wechat.article") {
      result.source.method = "dom"; result.completeness.scope = "article-text-range";
      if (location.hostname !== "mp.weixin.qq.com") fail("NOT_READY", "搜狗文章跳转尚未完成；请保留当前页面并检查跳转或验证提示。");
      const content = document.querySelector("#js_content"), title = document.querySelector("#activity-name");
      if (!content || !title) {
        if (/环境异常|完成验证|该内容已被|内容已删除|无法查看|访问过于频繁/.test(document.body.innerText)) fail("ACCESS_BLOCKED", "公众号页面提示验证或文章不可用，请查看当前页面。");
        fail("NOT_READY", "公众号跳转或正文仍在加载。");
      }
      const full = (content as HTMLElement).innerText?.trim() || content!.textContent?.trim() || "";
      if (!full) fail("NOT_READY", "公众号正文尚未加载。");
      const next = p.offset + p.textLimit;
      result.items = [{ title: title!.textContent?.trim(), account: document.querySelector("#js_name")?.textContent?.trim(), publishedAt: document.querySelector("#publish_time")?.textContent?.trim(),
        text: full.slice(p.offset, next), offset: p.offset, totalCharacters: full.length, url: location.href }];
      pageMore(next < full.length, next < full.length ? { ...p, url: location.href, offset: next } : null);
    } else if (op.startsWith("youtube.")) {
      result.source.method = "page-state";
      const w = window as any;
      if (op === "youtube.search") {
        if (new URL(location.href).searchParams.get("search_query") !== p.query) fail("RESULT_MISMATCH", "当前搜索词与请求不一致。");
        // Only the main search sections: exclude sidebar, ads and secondary recommendations.
        const sections = w.ytInitialData?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer;
        if (!sections) fail("NOT_READY", "YouTube 搜索数据尚未加载。");
        const videos = walk(sections.contents, "videoRenderer").reverse();
        const ytText = (v: any) => v?.simpleText || v?.runs?.map((r: any) => r.text).join("") || "";
        list(videos.map(v => ({ id: v.videoId, title: ytText(v.title), author: ytText(v.ownerText), duration: ytText(v.lengthText), views: ytText(v.viewCountText),
          publishedAt: ytText(v.publishedTimeText), url: `https://www.youtube.com/watch?v=${v.videoId}` })));
        if (!videos.length && !walk(sections.contents, "messageRenderer").length) fail("SCHEMA_CHANGED", "搜索结构已变化，未确认空结果。");
        result.completeness.scope = "loaded-search-page"; pageMore(walk(sections, "continuationItemRenderer").length > 0, null);
      } else {
        const player = w.ytInitialPlayerResponse || document.querySelector<any>("#movie_player")?.getPlayerResponse?.();
        const v = player?.videoDetails;
        if (!v || v.videoId !== p.id) fail("NOT_READY", "对应视频数据尚未加载或当前不可用。");
        if (op === "youtube.detail") result.items = [{ id: v.videoId, title: v.title, description: v.shortDescription, author: v.author, channelId: v.channelId,
          durationSeconds: Number(v.lengthSeconds), views: v.viewCount, isLive: v.isLiveContent, keywords: v.keywords || [], url: `https://www.youtube.com/watch?v=${v.videoId}` }];
        else {
          result.completeness.scope = "caption-segment-range";
          const transcriptRoot = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]') || document;
          const rendered = [...transcriptRoot.querySelectorAll("ytd-transcript-segment-renderer")].filter(r => !(r as any).data?.targetId || (r as any).data.targetId.startsWith(p.id + "."));
          const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          const footer = transcriptRoot.querySelector<any>("ytd-transcript-footer-renderer");
          const label = footer?.data?.languageMenu?.sortFilterSubMenuRenderer?.subMenuItems?.find((m: any) => m.selected)?.title || footer?.textContent?.trim();
          const normalize = (s: string) => s.normalize("NFKC").replace(/\s/g, "");
          const selectedTrack = tracks.find((t: any) => label && normalize(t.name?.simpleText || t.name?.runs?.map((r: any) => r.text).join("") || "") === normalize(label));
          if (rendered.length && (!p.language || selectedTrack?.languageCode === p.language)) {
            result.source.method = "dom";
            const seen = new Set<string>();
            const segments = rendered.map(r => { const stamp = r.querySelector(".segment-timestamp")?.textContent?.trim() || "";
              const parts = stamp.split(":").map(Number), data = (r as any).data;
              const startMs = data?.startMs !== undefined ? Number(data.startMs) : parts.reduce((total, n) => total * 60 + n, 0) * 1000;
              return { startMs, durationMs: data?.endMs !== undefined ? Number(data.endMs) - startMs : null,
                text: r.querySelector(".segment-text")?.textContent?.trim() || "" }; }).filter(r => {
                  const key = JSON.stringify(r); if (!r.text || !Number.isFinite(r.startMs) || seen.has(key)) return false; seen.add(key); return true;
                });
            if (!segments.length) fail("SCHEMA_CHANGED", "已展开的字幕结构已变化。");
            result.items = segments.slice(p.offset, p.offset + p.limit);
            result.effective = { ...p, languageLabel: label || null, language: selectedTrack?.languageCode || null, timingPrecision: (rendered[0] as any).data?.startMs !== undefined ? "milliseconds" : "displayed-seconds" };
            const more = p.offset + p.limit < segments.length;
            pageMore(more, more ? { ...p, offset: p.offset + p.limit } : null);
            return result;
          }
          if (!rendered.length && document.querySelector('ytd-continuation-item-renderer[panel-target-id="engagement-panel-searchable-transcript"][panel-content-visible]')) fail("NOT_READY", "页面文字稿仍在加载。");
          const track = p.language ? tracks.find((t: any) => t.languageCode === p.language) : tracks.find((t: any) => t.kind !== "asr") || tracks[0];
          if (!track) fail("CAPTIONS_UNAVAILABLE", p.language ? "未找到指定语言的现有字幕。" : "视频未提供可读取的现有字幕。");
          const u = new URL(track.baseUrl); u.searchParams.set("fmt", "json3");
          const raw = await fetchText(u.href); let segments: any[] = [];
          if (raw.trim()) { let data; try { data = json(raw); } catch { fail("SCHEMA_CHANGED", "字幕响应不是预期的 JSON。"); }
            segments = array(data.events).filter(e => Array.isArray(e.segs)).map(e => ({ startMs: e.tStartMs, durationMs: e.dDurationMs ?? null, text: e.segs.map((s: any) => s.utf8 || "").join("").trim() })).filter(s => s.text); }
          if (!segments.length) fail("NOT_READY", "字幕地址未返回内容，等待页面文字稿；若仍失败，请查看视频页是否有可用字幕。");
          result.items = segments.slice(p.offset, p.offset + p.limit); result.effective = { ...p, language: track.languageCode, autoGenerated: track.kind === "asr" };
          const more = p.offset + p.limit < segments.length; pageMore(more, more ? { ...p, language: track.languageCode, offset: p.offset + p.limit } : null);
        }
      }
    }
    if (remainingOnPage) pageMore(true, { ...p, itemOffset: p.itemOffset + p.limit });
    if (!result.items.length && result.status === "ok") result.status = "empty";
    return result;
  } catch (error: any) {
    const code = error.siteCode || (error.name === "TimeoutError" ? "FETCH_TIMEOUT" : "FETCH_FAILED");
    return { ...result, status: code === "ACCESS_BLOCKED" ? "blocked" : "error", items: [],
      completeness: { scope: result.completeness.scope, complete: false, reasons: [code] },
      error: { code, message: String(error.message || error).slice(0, 500) } };
  }
}
