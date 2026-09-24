import { taskIcon } from "./task-icons";

// Keep the native control as the form's source of truth, but render the menu in
// Chromium's top layer so Windows/macOS use the same layout and keyboard rules.
export class TaskSelects {
  private current?: HTMLSelectElement;
  private trigger?: HTMLButtonElement;
  private popup?: HTMLElement;
  private active = "";
  private query = "";

  constructor(private root: HTMLElement) {
    window.addEventListener("resize", () => this.position());
    root.addEventListener("scroll", () => this.position(), true);
    document.addEventListener("pointerdown", event => {
      const target = event.target as Node;
      if (this.popup && !this.popup.contains(target) && !this.trigger?.contains(target)) this.close(false);
    });
  }

  capture() {
    return this.current && this.popup?.matches(":popover-open")
      ? { id: this.current.id, query: this.query, active: this.active, scroll: this.popup.querySelector(".select-options")!.scrollTop }
      : undefined;
  }

  mount(state?: ReturnType<TaskSelects["capture"]>): void {
    this.close(false);
    this.root.querySelectorAll<HTMLSelectElement>("select").forEach((select, index) => {
      if (!select.id) select.id = `select-${select.form?.id || "page"}-${select.name || index}`;
      const wrapper = document.createElement("div");
      wrapper.className = "select-field";
      select.before(wrapper);
      wrapper.append(select);
      select.classList.add("select-source");
      select.tabIndex = -1;
      select.setAttribute("aria-hidden", "true");
      const button = document.createElement("button");
      button.type = "button";
      button.id = `${select.id}-trigger`;
      button.className = "select-trigger";
      button.setAttribute("aria-haspopup", "listbox");
      button.setAttribute("aria-expanded", "false");
      const label = select.getAttribute("aria-label") || select.labels?.[0]?.textContent || "选择选项";
      select.setAttribute("aria-label", label);
      const sync = () => {
        const option = select.selectedOptions[0];
        const text = option?.dataset.label || option?.textContent || "请选择…";
        button.innerHTML = `${select.name === "profileId" ? taskIcon("browser") : select.dataset.modelPicker ? taskIcon("spark") : ""}<span class="select-value"></span>${taskIcon("chevron")}`;
        button.querySelector(".select-value")!.textContent = text;
        button.title = option?.textContent || text;
        button.setAttribute("aria-label", `${label}：${text}`);
        button.disabled = select.disabled;
        const unavailable = option?.disabled && !!select.value;
        button.classList.toggle("selection-unavailable", !!unavailable);
        select.setCustomValidity(unavailable ? `这个浏览器暂不可用：${option?.dataset.description || "请先连接或选择空闲浏览器"}。` : "");
      };
      sync();
      select.addEventListener("change", sync);
      button.addEventListener("click", () => this.current === select ? this.close() : this.open(select, button));
      button.addEventListener("keydown", event => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault(); this.open(select, button);
          this.move(event.key === "End" || event.key === "ArrowUp" ? -1 : 1, true);
        }
      });
      select.labels && [...select.labels].forEach(label => { label.htmlFor = button.id; });
      wrapper.append(button);
    });
    if (state) {
      const select = document.getElementById(state.id) as HTMLSelectElement | null;
      const trigger = document.getElementById(`${state.id}-trigger`) as HTMLButtonElement | null;
      if (select && trigger && !select.disabled) {
        this.query = state.query; this.active = state.active;
        this.open(select, trigger, true);
        this.popup!.querySelector(".select-options")!.scrollTop = state.scroll;
      }
    }
  }

  close(focus = true): void {
    const trigger = this.trigger;
    this.current = undefined; this.trigger = undefined;
    if (this.popup) { this.popup.remove(); this.popup = undefined; }
    trigger?.setAttribute("aria-expanded", "false");
    trigger?.removeAttribute("aria-controls");
    if (focus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

  private open(select: HTMLSelectElement, trigger: HTMLButtonElement, restore = false): void {
    this.close(false);
    this.current = select; this.trigger = trigger;
    if (!restore) { this.query = ""; this.active = select.value; }
    const popup = document.createElement("div");
    popup.className = "select-popover";
    popup.id = "task-select-popover";
    popup.setAttribute("popover", "auto");
    const label = select.getAttribute("aria-label") || trigger.getAttribute("aria-label") || "选择选项";
    popup.innerHTML = '<div class="select-search-wrap"><input class="select-search" type="search" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="task-select-options" autocomplete="off" spellcheck="false"></div><div class="select-options" id="task-select-options" role="listbox"></div>';
    const input = popup.querySelector<HTMLInputElement>("input")!;
    input.placeholder = select.name === "profileId" ? "搜索浏览器…" : "搜索选项…";
    input.setAttribute("aria-label", label); input.value = this.query;
    popup.querySelector("[role=listbox]")!.setAttribute("aria-label", label);
    this.popup = popup;
    if (select.name === "profileId") {
      const footer = document.createElement("div"); footer.className = "model-menu-footer";
      const connect = document.createElement("button"); connect.type = "button"; connect.className = "model-service-link";
      connect.textContent = "连接系统 Chrome →";
      connect.addEventListener("click", () => { this.close(false); select.dispatchEvent(new CustomEvent("native-browser-settings", { bubbles: true })); });
      footer.append(connect); popup.append(footer);
    }
    if (select.dataset.modelPicker) {
      input.placeholder = "搜索模型，或输入模型 ID…";
      input.maxLength = 200;
      const footer = document.createElement("div"); footer.className = "model-menu-footer";
      const status = document.createElement("p"); status.className = "model-menu-status"; status.setAttribute("role", "status");
      status.textContent = select.dataset.status || "选择当前服务的模型，或直接输入模型 ID。";
      const settings = document.createElement("button"); settings.type = "button"; settings.className = "model-service-link";
      settings.textContent = "模型服务设置 →";
      settings.addEventListener("click", () => { this.close(false); select.dispatchEvent(new CustomEvent("model-settings", { bubbles: true })); });
      footer.append(status, settings); popup.append(footer);
    }
    document.body.append(popup);
    trigger.setAttribute("aria-expanded", "true");
    trigger.setAttribute("aria-controls", popup.id);
    popup.addEventListener("toggle", event => { if ((event as ToggleEvent).newState === "closed" && this.popup === popup) this.close(false); });
    input.addEventListener("input", () => { this.query = input.value; this.active = ""; this.options(); });
    popup.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.target instanceof HTMLButtonElement && !["Escape", "Tab"].includes(event.key)) return;
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); this.move(event.key === "ArrowUp" || event.key === "End" ? -1 : 1, ["Home", "End"].includes(event.key));
      } else if (event.key === "Enter") { event.preventDefault(); this.choose(this.active); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); }
      else if (event.key === "Tab") {
        if ((select.dataset.modelPicker || select.name === "profileId") && ((event.target === input && !event.shiftKey) || (event.target instanceof HTMLButtonElement && event.shiftKey))) return;
        // Restore the tab origin, then let the browser advance naturally.
        this.close();
      }
    });
    popup.addEventListener("click", event => {
      const row = (event.target as Element).closest<HTMLElement>("[data-value]");
      if (row && row.getAttribute("aria-disabled") !== "true") this.choose(row.dataset.value!);
    });
    this.options(); popup.showPopover(); this.position(); this.highlight(); input.focus({ preventScroll: true });
    if (select.dataset.modelPicker) select.dispatchEvent(new CustomEvent("model-menu-open", { bubbles: true }));
  }

  private options(): void {
    if (!this.current || !this.popup) return;
    const list = this.popup.querySelector<HTMLElement>(".select-options")!;
    list.replaceChildren();
    const options = [...this.current.options].filter(option =>
      (!this.current!.required || option.value) && (option.textContent || "").toLocaleLowerCase().includes(this.query.toLocaleLowerCase().trim()));
    const custom = this.query.trim();
    if (this.current.dataset.modelPicker && custom && custom.length <= 200 && ![...this.current.options].some(option => option.value === custom)) {
      const option = new Option(custom, custom);
      option.dataset.label = `使用模型：${custom}`;
      option.dataset.description = "请确认当前服务支持此模型 ID";
      options.push(option);
    }
    for (const [index, option] of options.entries()) {
      const row = document.createElement("div");
      row.className = "select-option"; row.id = `task-option-${index}`;
      row.setAttribute("role", "option"); row.dataset.value = option.value;
      row.setAttribute("aria-selected", String(option.selected));
      row.setAttribute("aria-disabled", String(option.disabled));
      const copy = document.createElement("span"); copy.className = "select-option-copy";
      const name = document.createElement("span"); name.className = "select-option-name";
      name.textContent = option.dataset.label || option.textContent;
      copy.append(name);
      if (option.dataset.description) {
        const status = document.createElement("small"); status.textContent = option.dataset.description;
        copy.append(status);
      }
      row.append(copy);
      if (option.selected) row.insertAdjacentHTML("beforeend", taskIcon("check"));
      list.append(row);
    }
    if (!options.length) {
      const empty = document.createElement("p"); empty.className = "select-empty";
      empty.textContent = this.query ? "没有匹配的选项，试试其他关键词。" : "暂无可用选项，请先添加或连接浏览器。";
      empty.setAttribute("role", "status"); list.append(empty);
    }
    if (!options.some(option => option.value === this.active && !option.disabled)) this.active = options.find(option => !option.disabled)?.value || "";
    this.highlight();
  }

  private move(direction: number, edge = false): void {
    const rows = [...this.popup!.querySelectorAll<HTMLElement>('[role=option]:not([aria-disabled=true])')];
    if (!rows.length) return;
    const index = rows.findIndex(row => row.dataset.value === this.active);
    const next = edge ? direction > 0 ? 0 : rows.length - 1 : (index + direction + rows.length) % rows.length;
    this.active = rows[next].dataset.value!; this.highlight();
  }

  private highlight(): void {
    const input = this.popup!.querySelector("input")!;
    input.removeAttribute("aria-activedescendant");
    this.popup!.querySelectorAll<HTMLElement>("[role=option]").forEach(row => {
      const active = row.dataset.value === this.active && row.getAttribute("aria-disabled") !== "true";
      row.classList.toggle("is-active", active);
      if (active) { input.setAttribute("aria-activedescendant", row.id); row.scrollIntoView({ block: "nearest" }); }
    });
  }

  private choose(value: string): void {
    const select = this.current;
    let option = select && [...select.options].find(option => option.value === value && !option.disabled);
    if (!option && select?.dataset.modelPicker && value.trim() && value.length <= 200) { option = new Option(value, value); select.add(option); }
    if (!select || !option) return;
    select.value = value;
    const id = select.id;
    this.close();
    select.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById(`${id}-trigger`)?.focus({ preventScroll: true });
  }

  private position(): void {
    if (!this.popup || !this.trigger) return;
    const rect = this.trigger.getBoundingClientRect();
    if (rect.bottom < 56 || rect.top > window.innerHeight) { this.close(false); return; }
    const width = Math.min(Math.max(rect.width, 320), window.innerWidth - 24);
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const up = below < 360 && above > below;
    const height = Math.min(360, Math.max(120, up ? above : below));
    Object.assign(this.popup.style, {
      width: `${width}px`, maxHeight: `${height}px`,
      left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
      top: up ? "auto" : `${rect.bottom + 6}px`,
      bottom: up ? `${window.innerHeight - rect.top + 6}px` : "auto"
    });
  }
}
