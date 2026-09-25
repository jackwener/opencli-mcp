/** A page handle is Chrome's tab id, stable across navigation for the tab's lifetime. */
export function pageId(tabId: number): string {
  if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error(`Invalid tab id: ${tabId}`);
  return String(tabId);
}

/** Resolve only a live tab. Session ownership is checked by the caller. */
export async function resolveTabId(page: string): Promise<number> {
  const tabId = Number(page);
  if (!Number.isSafeInteger(tabId) || tabId < 0 || String(tabId) !== page) throw new Error(`Invalid page handle: ${page}`);
  await chrome.tabs.get(tabId);
  return tabId;
}
