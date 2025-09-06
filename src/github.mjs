// Fetch Apply links from SpeedyApply 2026 list
const GH_README_API = "https://api.github.com/repos/speedyapply/2026-SWE-College-Jobs/contents/README.md";

export async function fetchReadmeMarkdown() {
  const res = await fetch(GH_README_API, {
    headers: { "User-Agent": "auto-apply-bot" }
  });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}`);
  }
  const json = await res.json();
  return Buffer.from(json.content, "base64").toString("utf8");
}

export function extractApplyLinks(md) {
  const out = new Set();

  // 1) Markdown image wrapped in link: [![Apply](...)](https://...)
  for (const m of md.matchAll(/\[!\[[^\]]*apply[^\]]*\]\((https?:\/\/[^\s)]+)\)/ig)) {
    out.add(m[1]);
  }

  // 2) Raw HTML form: <a href="..."><img alt="Apply"...></a>
  for (const m of md.matchAll(/<a\s+href="(https?:\/\/[^"]+)"[^>]*>\s*<img[^>]*alt="[^"]*apply[^"]*"[^>]*>\s*<\/a>/ig)) {
    out.add(m[1]);
  }

  // 3) Fallback: any ATS-looking URL mentioned anywhere (last resort)
  for (const m of md.matchAll(/https?:\/\/[^\s)\]]*(greenhouse\.io|lever\.co|myworkdayjobs\.com|workdayjobs\.com|ashbyhq\.com|smartrecruiters\.com)[^\s)\]]*/ig)) {
    out.add(m[0]);
  }

  return [...out];
}


export function snippetAround(md, url, window = 280) {
  const idx = md.indexOf(url);
  if (idx === -1) return "";
  const start = Math.max(0, idx - window);
  const end = Math.min(md.length, idx + window);
  return md.slice(start, end);
}
