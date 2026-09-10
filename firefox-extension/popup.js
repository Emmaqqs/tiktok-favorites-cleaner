document.getElementById("open").addEventListener("click", async () => {
  const status = document.getElementById("status");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !/^https:\/\/([^/]+\.)?tiktok\.com\//i.test(tab.url || "")) {
      status.textContent = "Abre primero TikTok en esta pestaña.";
      return;
    }
    await chrome.tabs.sendMessage(tab.id, { type: "TFC_OPEN_PANEL" });
    window.close();
  } catch (_) {
    status.textContent = "Recarga TikTok y vuelve a intentarlo.";
  }
});
