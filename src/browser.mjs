import { connect } from "puppeteer-core";

async function getWsUrl() {
  const tries = [
    "http://127.0.0.1:9222/json/version",
    "http://localhost:9222/json/version"
  ];
  for (const url of tries) {
    try {
      const json = await fetch(url).then(r => r.json());
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
    } catch (_) {}
  }
  throw new Error("Couldn't reach Chrome at 127.0.0.1:9222 or localhost:9222. Start Chrome with --remote-debugging-port=9222.");
}

export async function connectToExistingChrome() {
  const ws = await getWsUrl();
  return connect({ browserWSEndpoint: ws, defaultViewport: null });
}
