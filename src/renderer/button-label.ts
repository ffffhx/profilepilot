const escape = (text: string): string => text.replace(/[&<>"']/g, value => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[value]!);

/** Both labels participate in sizing; only the current label is visible/named. */
export function renderButtonLabel(loading: boolean, idleLabel: string, loadingLabel: string): string {
  return `<span class="button-label" data-loading="${loading}"><span class="button-label-idle" aria-hidden="${loading}">${escape(idleLabel)}</span><span class="button-label-loading" aria-hidden="${!loading}"><span class="inline-spinner" aria-hidden="true"></span><span class="button-label-text">${escape(loadingLabel)}</span></span></span>`;
}

/** Update an already sized label without replacing the focused button. */
export function setButtonLoading(button: HTMLButtonElement, loading: boolean): void {
  const label = button.querySelector<HTMLElement>(".button-label");
  if (!label) return;
  label.dataset.loading = String(loading);
  label.querySelector(".button-label-idle")!.setAttribute("aria-hidden", String(loading));
  label.querySelector(".button-label-loading")!.setAttribute("aria-hidden", String(!loading));
  button.setAttribute("aria-busy", String(loading));
}
