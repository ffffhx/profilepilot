// Only a desktop-created loopback invitation can reach this flow. Credentials
// are fetched by the extension, never exposed to the page or its scripts.
if (window === window.top && /^\/profilepilot-connect\/[a-f0-9]{48}$/.test(location.pathname)) {
  chrome.runtime.sendMessage({ method: 'onboarding' }).then(result => {
    if (result?.error) {
      document.querySelector('meta[http-equiv="refresh"]')?.remove();
      const note = document.createElement('p'); note.textContent = result.error; document.body.append(note);
    }
  }).catch(() => {});
}
