const status = document.getElementById('copy-status');
let clearStatus;
document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy);
    const text = source instanceof HTMLTextAreaElement ? source.value : source.textContent;
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = '已复制';
    } catch {
      const box = document.createElement('textarea');
      box.value = text; box.setAttribute('aria-label', '待复制的文案');
      button.after(box); box.focus(); box.select();
      if (document.execCommand('copy')) { box.remove(); button.focus(); status.textContent = '已复制'; }
      else status.textContent = '请复制已选中的文本';
    }
    clearTimeout(clearStatus);
    clearStatus = setTimeout(() => { status.textContent = ''; }, 2400);
  });
});
function revealHash() {
  const target = document.getElementById(location.hash.slice(1));
  if (target?.classList.contains('document')) target.querySelector('details').open = true;
}
window.addEventListener('hashchange', revealHash);
revealHash();
if (location.protocol === 'file:') {
  const download = document.querySelector('.actions .primary');
  download.removeAttribute('download');
  download.href = '#images';
  download.textContent = '查看已解压的配图';
  document.querySelector('a[href="/"]').href = '../../index.html';
}
