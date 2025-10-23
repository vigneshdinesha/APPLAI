#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

const ACC = 'jobs_by_resume_frame_accurate_partial.json';
const OUT = 'lists/frame_1_software_full_stack_refined.txt';

const NEWGRAD_KEYWORDS = [
  'new grad','new-grad','newgraduate','new graduate','newly graduated','new graduate','entry level','entry-level','entrylevel','early career','recent graduate','graduate'
];

function containsNewGradHint(text){
  const t = (text||'').toLowerCase();
  return NEWGRAD_KEYWORDS.some(k=> t.includes(k));
}

function scoreForFrame(entry, id){
  if(!Array.isArray(entry.frameScores)) return 0;
  const f = entry.frameScores.find(x=>x.id===id);
  return f ? f.score : 0;
}

async function main(){
  console.log('Refining list 1 for new-grad SWE roles...');
  let acc;
  try{
    const raw = await fs.readFile(ACC,'utf8');
    acc = JSON.parse(raw);
  }catch(e){
    console.error('Accurate JSON not found or unreadable:', e && e.message); process.exit(1);
  }

  // select candidates: must be strongly software (frame 1) and have new-grad hint
  const candidates = [];
  for(const e of acc){
    try{
      const text = `${e.title||''} ${e.company||''} ${e.snippet||''} ${e.url||''}`;
      const assigned1 = Array.isArray(e.assigned) && e.assigned.includes(1);
      const score1 = scoreForFrame(e,1);
      const strongSoftware = assigned1 || score1>=2;
      if(!strongSoftware) continue;
      if(!containsNewGradHint(text)) continue;
      candidates.push(e);
    }catch(_){ }
  }

  // dedupe by url
  const seen = new Set();
  const uniq = [];
  for(const c of candidates){ if(!seen.has(c.url)){ seen.add(c.url); uniq.push(c); } }

  // format and write
  const lines = [];
  lines.push('Refined jobs for frame 1 - Software / Full-Stack (new-grad focused)');
  lines.push('');
  for(const r of uniq){
    const assignedText = Array.isArray(r.assigned) ? r.assigned.join(', ') : '';
    const sn = (r.snippet||'').replace(/\s+/g,' ').trim();
    lines.push(`- ${r.url}`);
    lines.push(`  Title: ${r.title || ''}`);
    lines.push(`  Company: ${r.company || ''}`);
    lines.push(`  Assigned: ${assignedText}`);
    lines.push(`  Snippet: ${sn.slice(0,400)}`);
    lines.push('');
  }

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, lines.join('\n'), 'utf8');
  console.log('Wrote', OUT, 'with', uniq.length, 'entries');
}

main().catch(e=>{ console.error(e && e.message ? e.message : e); process.exit(1); });
