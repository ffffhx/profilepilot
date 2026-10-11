// This function is serialized into the current page's main world. Keep it
// self-contained; never pass provider credentials into the browser.
export function captchaPage(input: { mode: "detect" | "prepare" | "check" | "apply"; selector?: string; nonce?: string; id?: string; token?: string }): any {
  const w = window as any;
  const fail = (code: string, error: string) => ({ ok: false, code, error });
  const interstitial = Boolean(w._cf_chl_opt || document.querySelector('#challenge-running, #challenge-stage, form#challenge-form'));
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('.cf-turnstile[data-sitekey], .g-recaptcha[data-sitekey]'));
  const describe = (node: HTMLElement) => ({
    kind: node.classList.contains('cf-turnstile') ? 'turnstile' : 'recaptcha-v2',
    sitekey: node.getAttribute('data-sitekey') || '',
    action: node.getAttribute('data-action') || '', data: node.getAttribute('data-cdata') || '',
    callback: node.getAttribute('data-callback') || '',
    invisible: node.getAttribute('data-size') === 'invisible',
    responseName: node.getAttribute('data-response-field-name') || (node.classList.contains('cf-turnstile') ? 'cf-turnstile-response' : 'g-recaptcha-response')
  });
  if (input.mode === 'detect') return {
    ok: true, status: interstitial ? 'unsupported_challenge' : nodes.length ? 'detected' : 'not_detected',
    interstitial, widgets: nodes.map(describe),
    note: '自动处理仅支持当前主文档中带 data-sitekey 的独立 Turnstile / reCAPTCHA v2 组件；动态组件、跨域 iframe 和整页挑战可能需要专门适配。'
  };
  if (interstitial) return fail('CAPTCHA_UNSUPPORTED_CHALLENGE', '整页 Cloudflare 挑战需要专门适配；未提交付费任务。可使用 submit/result 处理已提取的服务商任务参数。');
  let store = w.__profilepilotCaptchaV1;
  let state = store?.ids?.get(input.id);
  if (input.mode === 'prepare') {
    let candidates = nodes;
    if (input.selector) {
      try { candidates = nodes.filter(node => node.matches(input.selector!)); }
      catch { return fail('CAPTCHA_INVALID_ARGUMENTS', 'selector 不是有效的 CSS 选择器。'); }
    }
    if (!candidates.length) return fail('CAPTCHA_NOT_DETECTED', '未找到支持自动处理的验证码组件；未提交付费任务。');
    if (candidates.length !== 1) return fail('CAPTCHA_AMBIGUOUS', '页面有多个验证码，请用 --selector 明确选择组件。');
    const node = candidates[0], info = describe(node);
    // Reject Enterprise/v3 rather than purchasing the wrong task type.
    if (info.kind === 'recaptcha-v2' && (document.querySelector('script[src*="recaptcha/enterprise.js"]') || node.hasAttribute('data-action'))) return fail('CAPTCHA_UNSUPPORTED_CHALLENGE', '此 reCAPTCHA 可能为 v3 / Enterprise；请使用 submit/result 明确任务类型。');
    const signature = JSON.stringify(info);
    if (!store?.nodes || !store?.ids) {
      store = { nodes: new WeakMap(), ids: new Map() };
      w.__profilepilotCaptchaV1 = store;
    }
    state = store.nodes.get(node);
    if (!state || state.node !== node || state.signature !== signature || state.url !== location.href) {
      if (state) store.ids.delete(state.id);
      state = { id: input.nonce, node, signature, url: location.href, info, applied: false };
      store.nodes.set(node, state);
      store.ids.set(state.id, state);
    }
  }
  if (!state || (input.id && state.id !== input.id) || !state.node.isConnected || state.url !== location.href || JSON.stringify(describe(state.node)) !== state.signature) return fail('CAPTCHA_PAGE_CHANGED', '页面或验证码已变化；旧结果不会写入，勿自动重新付费。');
  if (state.applied) return { ok: true, status: 'already_applied', id: state.id };
  if (state.applying) return fail('CAPTCHA_APPLY_UNCERTAIN', '上次填回已开始，但完成状态不明；请观察网页，勿重放。');
  const info = state.info;
  const root = state.node.closest('form') || document;
  // Only touch the selected widget's fields. Shared forms must be unambiguous.
  const matches = (container: ParentNode) => Array.from(container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).filter(n => n.name === info.responseName);
  let fields = matches(state.node);
  if (!fields.length && nodes.filter(n => (n.closest('form') || document) === root && describe(n).responseName === info.responseName).length === 1) fields = matches(root);
  let callback: Function | undefined, receiver: any = w;
  if (info.callback) {
    const parts = info.callback.split('.');
    if (parts.every((part: string) => /^[\w$]+$/.test(part) && !['__proto__', 'prototype', 'constructor'].includes(part))) {
      for (const part of parts.slice(0, -1)) receiver = receiver?.[part];
      if (typeof receiver?.[parts.at(-1)] === 'function') callback = receiver[parts.at(-1)];
    }
    if (!callback) return fail('CAPTCHA_CALLBACK_UNAVAILABLE', '验证码回调不可用；需要页面专门适配，未自动填回。');
  }
  if (!fields.length && !callback) return fail('CAPTCHA_CALLBACK_UNAVAILABLE', '未找到验证码响应字段或公开回调；未提交付费任务。');
  if (fields.some(field => Boolean(field.value))) return { ok: true, status: 'response_present', id: state.id };
  if (input.mode !== 'apply') return { ok: true, status: 'prepared', id: state.id, url: state.url, ...info };
  if (!input.token) return fail('CAPTCHA_RESPONSE_INVALID', '解题结果缺少 token。');
  state.applying = true; // set before events/callbacks, which may navigate or throw
  try {
    for (const field of fields) {
      const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, input.token);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (callback) callback.call(receiver, input.token);
    state.applied = true;
    return { ok: true, status: 'applied', id: state.id, fields: fields.length, callbackInvoked: Boolean(callback), verified: false };
  } catch { return fail('CAPTCHA_APPLY_UNCERTAIN', '凭证填回或回调执行未确认；请观察网页，勿重放。'); }
}

export const captchaExpression = (input: Parameters<typeof captchaPage>[0]): string => `(${captchaPage.toString()})(${JSON.stringify(input)})`;
