export function attachSmsInbox(header: HTMLElement): void {
  const open = document.createElement("button");
  open.className = "phone-text-button";
  open.textContent = "短信收件箱";
  header.append(open);
  open.addEventListener("click", () => {
    const dialog = document.createElement("dialog");
    dialog.className = "phone-connect-dialog phone-sms-dialog";
    dialog.setAttribute("aria-label", "短信收件箱");
    dialog.innerHTML = '<header><h2>短信收件箱</h2><button aria-label="关闭">×</button></header><div class="phone-sms-list" aria-live="polite">正在读取…</div>';
    const list = dialog.querySelector<HTMLElement>(".phone-sms-list")!;
    let revision = 0;
    const refresh = async () => {
      const version = ++revision;
      try {
        const messages = await window.phones.smsInbox();
        if (!dialog.open || version !== revision) return;
        list.replaceChildren();
        if (!messages.length) list.textContent = "暂无短信。在 Android 配套 App 首页打开「短信同步」，选择这台电脑即可接收新短信。";
        for (const sms of messages) {
          const article = document.createElement("article");
          const sender = document.createElement("strong");
          sender.textContent = sms.sender || "未知发送方";
          const meta = document.createElement("small");
          meta.textContent = [sms.deviceName, sms.simNumber && "SIM " + sms.simNumber, new Date(sms.receivedAt).toLocaleString()].filter(Boolean).join(" · ");
          const body = document.createElement("p");
          body.textContent = sms.message;
          article.append(sender, meta, body); list.append(article);
        }
      } catch { if (version === revision) list.textContent = "无法读取短信，请检查系统安全存储后重新打开。"; }
    };
    dialog.querySelector("button")!.addEventListener("click", () => dialog.close());
    document.body.append(dialog); dialog.showModal();
    const unsubscribe = window.phones.onSmsReceived(() => { void refresh(); });
    dialog.addEventListener("close", () => { unsubscribe(); dialog.remove(); }, { once: true });
    void refresh();
  });
}
