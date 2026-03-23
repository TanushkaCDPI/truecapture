// TrueCapture service worker
// Tab capture is handled directly in popup.js via chrome.tabCapture.capture()
// This service worker is kept minimal as required by MV3.
chrome.runtime.onInstalled.addListener(() => {
  console.log('TrueCapture installed');
});
