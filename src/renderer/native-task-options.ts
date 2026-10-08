import type { CreateTaskInput } from "../shared/tasks";

export function nativeTaskOptions(): string {
  return `<div id="native-task-options" class="field" hidden><label for="native-target">系统 Chrome 的任务页面</label><select id="native-target" name="nativeTarget"><option value="current">当前页（默认）</option><option value="new">新建后台页</option></select><small>也可在 Chrome 侧边栏选择已有页面并带上选中文字。</small><label><input name="nativeConfirmActions" type="checkbox">本次任务在修改或提交前逐次确认</label><small>默认采用此 Profile 的网站设置；未设置限制时直接执行。</small></div>`;
}

export function nativeTaskInput(form: FormData): Pick<CreateTaskInput, "nativeTarget" | "nativeAccess"> {
  if (!String(form.get("profileId") || "").startsWith("native:")) return {};
  return { nativeTarget: { newTab: form.get("nativeTarget") === "new" }, ...(form.has("nativeConfirmActions") ? { nativeAccess: { confirmActions: true } } : {}) };
}
