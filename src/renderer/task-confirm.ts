export function confirmTaskAction(title: string, description: string, confirmLabel?: string): Promise<boolean> {
  return new Promise(resolve => {
    const origin = document.activeElement as HTMLElement | null;
    const dialog = document.createElement("dialog");
    dialog.className = "task-confirm";
    dialog.setAttribute("aria-labelledby", "task-confirm-title");
    dialog.setAttribute("aria-describedby", "task-confirm-description");
    dialog.innerHTML = '<form method="dialog"><h2 id="task-confirm-title"></h2><p id="task-confirm-description"></p><div class="actions"><button value="cancel" autofocus>取消</button><button class="danger" value="confirm" data-confirm-action>确认删除</button></div></form>';
    dialog.querySelector("h2")!.textContent = title;
    dialog.querySelector("p")!.textContent = description;
    if (title.includes("断开")) dialog.querySelector("[data-confirm-action]")!.textContent = "确认断开";
    if (confirmLabel) dialog.querySelector("[data-confirm-action]")!.textContent = confirmLabel;
    dialog.addEventListener("close", () => {
      const confirmed = dialog.returnValue === "confirm";
      dialog.remove();
      if (origin?.isConnected) origin.focus({ preventScroll: true });
      resolve(confirmed);
    }, { once: true });
    document.body.append(dialog); dialog.showModal();
  });
}
