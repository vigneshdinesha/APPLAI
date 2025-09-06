export function buildKeywordSet(profile){
  const kws = new Set();
  const add = v => Array.isArray(v) ? v.forEach(s=>kws.add(String(s).toLowerCase())) : kws.add(String(v).toLowerCase());
  if(profile.skills){
    (profile.skills.programming_languages||[]).forEach(add);
    (profile.skills.technologies||[]).forEach(add);
  }
  ["software","intern","internship","new grad","backend","frontend","full stack","ml","data","distributed","systems","react","postgres","dotnet",".net","python","java"]
    .forEach(add);
  return kws;
}

export function isRelevant(url, snippet, kwset){
  const hay = (url + " " + snippet).toLowerCase();

  // Hard block non-job domains
  const BLOCK = /(discord\.gg|chromewebstore\.google\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|medium\.com|github\.com|docs\.google\.com)/i;
  if (BLOCK.test(hay)) return false;

  // Allow only ATS or known careers sites
  const ATS = /(greenhouse\.io|boards\.greenhouse|lever\.co|myworkdayjobs\.com|workdayjobs\.com|ashbyhq\.com|smartrecruiters\.com|icims\.com)/i;
  const COMPANY = /(careers?\.(google|stripe|roblox)\.com|google\.com\/about\/careers|stripe\.com\/jobs|roblox\.com\/(jobs|careers))/i;
  const domainOk = ATS.test(hay) || COMPANY.test(hay);
  if (!domainOk) return false;

  // Light keyword check (keeps good matches; prevents generic links)
  const hits = Array.from(kwset).filter(k => hay.includes(k)).length;
  return hits >= 1;
}
