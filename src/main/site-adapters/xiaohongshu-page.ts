import type { SitePlan } from "./catalog";

/** One synchronous page action per guarded host step. Uses the site's router
 * and filter controls; never replaces fetch/XHR or clears the site's feeds. */
export function prepareXiaohongshuSearch(plan: SitePlan, stage: "route" | "sort"): { state: "ready" | "performed" | "waiting" | "unavailable" } {
  if (plan.operation !== "xiaohongshu.search" || location.origin !== "https://www.xiaohongshu.com") return { state: "unavailable" };
  if (plan.access?.blockedOrigins?.includes(location.origin) || plan.access?.allowedOrigins?.length && !plan.access.allowedOrigins.includes(location.origin)) throw new Error("此来源被任务的网站访问设置限制。");
  const globals = document.querySelector<any>("#app")?.__vue_app__?.config?.globalProperties;
  const store = globals?.$pinia?._s?.get("search"), router = globals?.$router;
  const runtime = globalThis as any;
  const p = plan.params, nativeSort: Record<string, string> = { general: "general", latest: "time_descending", likes: "popularity_descending", comments: "comment_descending", collects: "collect_descending" };
  if (stage === "route") {
    if (location.pathname === "/search_result" && new URL(location.href).searchParams.get("keyword") === p.query) return { state: "ready" };
    if (!router?.push || typeof store?.mutateSearchValue !== "function" || typeof store?.$onAction !== "function") return { state: "unavailable" };
    // The site's search loader reads searchValue as well as the route. Updating
    // only the URL can request the previous keyword on current Xiaohongshu.
    store.mutateSearchValue(p.query);
    if (store.searchContext) store.searchContext.keyword = p.query;
    // Wait for the native loader to finish, so changing the keyword cannot make
    // old feeds look like new results. This observes Pinia actions, not network.
    const pending = { query: p.query, waiting: true, failed: false };
    runtime.__profilePilotXhsRoute = pending;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (failed = false) => { pending.waiting = false; pending.failed = failed; unsubscribe(); if (timer) clearTimeout(timer); };
    unsubscribe = store.$onAction(({ name, after, onError }: any) => {
      if (name === "fetchNotePageData") { after(() => finish()); onError(() => finish(true)); }
    });
    timer = setTimeout(() => finish(true), 12000);
    Promise.resolve(router.push({ path: "/search_result", query: { keyword: p.query, source: "web_search_result_notes" } })).catch(() => finish(true));
    return { state: "performed" };
  }
  if (!store) return { state: "unavailable" };
  const pending = runtime.__profilePilotXhsRoute;
  if (pending?.query === p.query && pending.failed) throw new Error("页面内搜索加载失败，未返回旧的搜索结果。");
  if (pending?.query === p.query && pending.waiting) return { state: "waiting" };
  if (store.state === "loading" || store.searchContext?.keyword !== p.query) return { state: "waiting" };
  const wanted = nativeSort[p.sort || "general"];
  const applied = store.filterParams?.find((f: any) => f.type === "sort_type")?.tags?.[0];
  if (applied === wanted) return { state: "ready" };
  const groups = store.filters, groupIndex = groups?.findIndex((g: any) => g.id === "sort_type");
  const tags = groups?.[groupIndex]?.filterTags, tagIndex = tags?.findIndex((t: any) => t.id === wanted);
  if (!(groupIndex >= 0) || !(tagIndex >= 0)) return { state: "unavailable" };
  const filter = document.querySelector<HTMLElement>(".filter");
  if (!filter) return { state: "unavailable" };
  const panel = filter.querySelector(".filter-panel");
  if (!panel) { filter.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true })); return { state: "waiting" }; }
  const button = panel.querySelectorAll(".filters")[groupIndex]?.querySelectorAll<HTMLElement>(".tags")[tagIndex];
  if (!button || button.textContent?.trim() !== tags[tagIndex].name || button.getBoundingClientRect().width <= 0) return { state: "unavailable" };
  // The native click handler manages request IDs, filtering, feeds and loading
  // state together. Calling searchNotes alone leaves those responsibilities out.
  button.click();
  filter.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
  return { state: "performed" };
}
