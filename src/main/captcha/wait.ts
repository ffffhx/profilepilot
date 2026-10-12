import { randomUUID } from "node:crypto";
import type { CaptchaBrowser } from "./browser";
import { CaptchaError } from "./provider";

// Serialized into the page. Only credential presence leaves the browser, never
// a token value. A navigation/new document ends the wait instead of restarting it.
export function captchaResponseState(input: { id: string; initial: boolean; selector?: string }): any {
  const w = window as any;
  if (input.initial) w.__profilepilotCaptchaWaitV1 = { id: input.id, url: location.href };
  const state = w.__profilepilotCaptchaWaitV1;
  if (state?.id !== input.id || state.url !== location.href) return { status: "page_changed" };
  const kinds: Record<string, string> = {
    'h-captcha-response': 'hcaptcha', 'g-recaptcha-response': 'recaptcha',
    'cf-turnstile-response': 'turnstile', 'mtcaptcha-verifiedtoken': 'mtcaptcha'
  };
  const selector = Object.keys(kinds).flatMap(name => [`input[name="${name}"]`, `textarea[name="${name}"]`]).join(', ');
  let roots: Element[];
  try { roots = input.selector ? Array.from(document.querySelectorAll(input.selector)) : [document.documentElement]; }
  catch { return { status: "invalid_selector" }; }
  let fields = [...new Set(roots.flatMap(root => root.matches(selector) ? [root] : Array.from(root.querySelectorAll(selector))))] as (HTMLInputElement | HTMLTextAreaElement)[];
  // hCaptcha emits a compatibility alias. Sharing a form (or having no form)
  // does not establish that two fields belong to the same widget.
  const hcaptcha = fields.filter(f => f.name === "h-captcha-response");
  fields = fields.filter(f => f.name !== "g-recaptcha-response" || !hcaptcha.some(h => {
    const widget = h.closest('.h-captcha, [data-hcaptcha-widget-id]');
    if (widget && widget === f.closest('.h-captcha, [data-hcaptcha-widget-id]')) return true;
    const suffix = h.id?.startsWith('h-captcha-response-') ? h.id.slice('h-captcha-response-'.length) : '';
    return suffix && f.id === `g-recaptcha-response-${suffix}` && h.parentElement && h.parentElement === f.parentElement;
  }));
  if (fields.length > 1) return { status: "ambiguous", fields: fields.length };
  if (!fields.length) return { status: state.field ? "challenge_changed" : "not_detected" };
  const field = fields[0];
  if (state.field && (state.field !== field || state.name !== field.name || state.fieldId !== field.id || state.parent !== field.parentElement || state.form !== field.form)) return { status: "challenge_changed" };
  state.field = field;
  state.name = field.name;
  state.fieldId = field.id;
  state.parent = field.parentElement;
  state.form = field.form;
  // Do not inspect providers' JS objects or export credentials. A response can
  // predate this command; it establishes neither a fresh solve nor acceptance.
  return { status: field.value.trim() ? "response_present" : "pending", kind: kinds[field.name] };
}

export async function waitForCaptchaResponse(browser: CaptchaBrowser, options: {
  timeout: number; selector?: string; now?: () => number; sleep?: (ms: number) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const now = options.now || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = now(), id = randomUUID();
  let initial = true;
  for (;;) {
    const input = { id, initial, selector: options.selector };
    const result = await browser.evaluate(`(${captchaResponseState.toString()})(${JSON.stringify(input)})`);
    initial = false;
    if (!result || !['response_present', 'pending', 'not_detected', 'page_changed', 'challenge_changed', 'ambiguous', 'invalid_selector'].includes(result.status)) throw new CaptchaError('CAPTCHA_EVALUATION_FAILED', '验证码等待未返回有效状态。', 75);
    if (result.status === 'invalid_selector') throw new CaptchaError('CAPTCHA_INVALID_ARGUMENTS', '--selector 不是有效的 CSS 选择器。', 64);
    const elapsedMs = now() - started;
    const timedOut = ['pending', 'not_detected'].includes(result.status) && elapsedMs >= options.timeout;
    if (timedOut || !['pending', 'not_detected'].includes(result.status)) {
      const notes: Record<string, string> = {
        response_present: '检测到验证码响应；它可能在等待前已存在，不能证明本次解题或网站已通过。请观察网站或服务端结果。',
        pending: '响应字段仍为空，验证结果未知；不表示答案被拒绝，不要自动重放提交。',
        not_detected: '主文档或所选范围内没有支持的响应字段；可能是 iframe、其他验证码或结果页，不能判断通过或失败。',
        page_changed: '等待期间页面已变化，已停止等待；请重新观察页面，不能据此判断验证通过。',
        challenge_changed: '等待期间响应字段已移除、替换或改变归属，已停止等待；请重新观察题目和结果。',
        ambiguous: '存在多个无法确认归属的响应字段；请观察页面并用 --selector 指定一个验证码范围。'
      };
      // Only emit known metadata even if an unexpected property is returned by
      // the page/transport. No credential or page text belongs in this result.
      return { status: result.status, ...(['hcaptcha', 'recaptcha', 'turnstile', 'mtcaptcha'].includes(result.kind) ? { kind: result.kind } : {}),
        ...(result.status === 'ambiguous' && Number.isSafeInteger(result.fields) && result.fields > 1 ? { fields: result.fields } : {}),
        elapsedMs, timedOut, verified: false, next: 'observe', note: notes[result.status] };
    }
    await sleep(Math.min(250, Math.max(0, options.timeout - elapsedMs)));
  }
}
