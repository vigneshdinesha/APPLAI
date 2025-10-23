import fs from 'fs/promises';
import { fetchReadmeMarkdown, extractApplyLinks, snippetAround } from '../src/github.mjs';
import profile from '../profile.json' assert { type: 'json' };

function keywordsFromProfile(p){
  const kw = new Set();
  (p.skills?.programming_languages||[]).forEach(s=>kw.add(s.toLowerCase()));
  (p.skills?.technologies||[]).forEach(s=>kw.add(s.toLowerCase()));
  p.experience?.forEach(e=>{ (e.title||'').split(/\W+/).forEach(t=>t && kw.add(t.toLowerCase())); (e.highlights||[]).forEach(h=>h.split(/\W+/).forEach(t=>t && kw.add(t.toLowerCase()))); });
  (p.projects||[]).forEach(pr=>{ (pr.stack||[]).forEach(s=>kw.add(s.toLowerCase())); (pr.name||'').split(/\W+/).forEach(t=>t && kw.add(t.toLowerCase())); });
  return [...kw].filter(Boolean);
}

async function main(){
  console.log('Fetching README from GitHub...');
  const md = await fetchReadmeMarkdown();
  console.log('Extracting apply links...');
  const links = extractApplyLinks(md);
  console.log('Found', links.length, 'links');
  const kws = keywordsFromProfile(profile).slice(0,200);
  const scored = links.map(url=>{
    const snippet = snippetAround(md, url, 280);
    const s = kws.reduce((acc,k)=> acc + (snippet.toLowerCase().includes(k) ? 1 : 0), 0);
    return { url, score: s, snippet };
  }).sort((a,b)=>b.score - a.score);
  const relevant = scored.filter(s=>s.score>0);
  const out = [
    `Profile keywords: ${kws.slice(0,80).join(', ')}`,
    '',
    'Relevant job links (scored):',
    ...relevant.map(r=>`${r.score} \t ${r.url}\n\n${r.snippet}\n---`)
  ].join('\n\n');
  await fs.writeFile('relevant_jobs.txt', out, 'utf8');
  console.log('Wrote relevant_jobs.txt with', relevant.length, 'entries');
}

main().catch(e=>{ console.error(e); process.exit(1); });
