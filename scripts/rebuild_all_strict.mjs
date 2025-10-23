#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

const FRAMES = [
  { id: 1, name: 'Software / Full-Stack' },
  { id: 2, name: 'Mobile Development' },
  { id: 3, name: 'Data Engineering / Analytics' },
  { id: 4, name: 'Internal Tools / Platform' },
  { id: 5, name: 'Research / Emerging Tech' },
  { id: 6, name: 'Cloud / DevOps' }
];

function slug(name){
  return name.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
}

async function loadAccurate(){
  try{
    const raw = await fs.readFile('jobs_by_resume_frame_accurate_partial.json','utf8');
    const parsed = JSON.parse(raw);
    if(Array.isArray(parsed)) return parsed;
  }catch(e){ }
  throw new Error('Could not load jobs_by_resume_frame_accurate_partial.json — run the accurate pass first');
}

function scoreForFrame(entry, frameId){
  if(!Array.isArray(entry.frameScores)) return 0;
  const fs = entry.frameScores.find(f=>f.id===frameId);
  return fs ? fs.score : 0;
}

const MIN_SCORE = 2; // require at least this many keyword hits for strict inclusion
const MOBILE_KEYWORDS = ['mobile','ios','android','react native','swift','kotlin','flutter','objective-c','jetpack','compose','expo'];

function hasMobileHint(entry){
  const t = `${entry.title||''} ${entry.snippet||''} ${entry.url||''}`.toLowerCase();
  return MOBILE_KEYWORDS.some(k=> t.includes(k));
}

async function main(){
  console.log('Rebuilding all lists with tightened strictness from accurate JSON...');
  const acc = await loadAccurate();

  // normalize entries and compute max score
  for(const e of acc){
    e._maxScore = Array.isArray(e.frameScores) ? Math.max(...e.frameScores.map(f=>f.score)) : 0;
  }

  await fs.mkdir('lists', { recursive: true });

  for(const frame of FRAMES){
    const chosen = acc.filter(e=> Array.isArray(e.assigned) && e.assigned.includes(frame.id) && e._maxScore>=MIN_SCORE && scoreForFrame(e, frame.id) === e._maxScore );
    // for mobile frame (2) additionally require an explicit mobile keyword hint
    const finalChosen = frame.id === 2 ? chosen.filter(hasMobileHint) : chosen;
    // dedupe by url preserving order
    const seen = new Set();
    const uniq = [];
    for(const c of chosen){ if(!seen.has(c.url)){ seen.add(c.url); uniq.push(c); } }

    const outLines = [];
    outLines.push(`Jobs for frame ${frame.id} - ${frame.name}`);
    outLines.push('');
  for(const r of uniq){
      const assignedText = Array.isArray(r.assigned) && r.assigned.length ? r.assigned.join(', ') : '';
      const sn = (r.snippet||'').replace(/\s+/g,' ').trim();
      outLines.push(`- ${r.url}`);
      outLines.push(`  Use resume: ${frame.id} - ${frame.name}`);
      outLines.push(`  Assigned: ${assignedText}`);
      outLines.push(`  Snippet: ${sn.slice(0,400)}`);
      outLines.push('');
    }

    const fname = `lists/frame_${frame.id}_${slug(frame.name)}.txt`;
    await fs.writeFile(fname, outLines.join('\n'), 'utf8');
    console.log('Wrote', fname, 'with', uniq.length, 'entries');
  }

  console.log('All lists rebuilt strictly.');
}

main().catch(e=>{ console.error(e && e.message ? e.message : e); process.exit(1); });
