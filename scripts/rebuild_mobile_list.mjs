#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

const OUT = 'lists/frame_2_mobile_development.txt';
const ACC = 'jobs_by_resume_frame_accurate_partial.json';
const SOURCE_LIST = 'lists/frame_2_mobile_development.txt';

const MOBILE_KEYWORDS = ['mobile','ios','android','react native','react-native','swift','kotlin','flutter','objective-c','objectivec','xamarin','swiftui','jetpack','compose','cordova','ionic','expo'];

function containsKeyword(text){
  const t = (text||'').toLowerCase();
  return MOBILE_KEYWORDS.some(k=> t.includes(k));
}

async function loadAccurate(){
  try{
    const raw = await fs.readFile(ACC,'utf8');
    const parsed = JSON.parse(raw);
    if(Array.isArray(parsed)) return parsed;
  }catch(e){}
  return null;
}

async function readListUrls(file){
  try{
    const txt = await fs.readFile(file,'utf8');
    return txt.split(/\r?\n/).map(l=>l.trim()).filter(Boolean).filter(l=>l.startsWith('- ')).map(l=>l.slice(2).trim());
  }catch(e){ return []; }
}

async function main(){
  console.log('Rebuilding mobile list — strong mobile filter');
  const acc = await loadAccurate();
  const fromList = await readListUrls(SOURCE_LIST);

  const chosen = new Map(); // url -> entry

  if(acc){
    for(const e of acc){
      try{
        const url = e.url;
        const text = [e.title || '', e.company || '', e.snippet || '', url].join(' ');
        const assignedHas2 = Array.isArray(e.assigned) && e.assigned.includes(2);
        if(assignedHas2 || containsKeyword(text)){
          chosen.set(url, { url, title: e.title || '', company: e.company || '', snippet: (e.snippet||'').replace(/\s+/g,' ').trim(), assigned: e.assigned || [] });
        }
      }catch(_){ }
    }
    console.log('Selected', chosen.size, 'entries from accurate JSON');
  }

  // also include any entries from the existing list that contain mobile keywords (covers cases where accurate JSON missing)
  for(const u of fromList){
    if(chosen.has(u)) continue;
    try{
      const short = u;
      if(containsKeyword(short)){
        chosen.set(u, { url: u, title: '', company: '', snippet: '', assigned: [2] });
      }
    }catch(_){ }
  }

  // fallback: if we still have very few mobile entries, relax to include any entry whose URL path contains "mobile" or "ios" or "android"
  if(chosen.size < 6){
    console.log('Few results (<6). Scanning entire accurate JSON for URL-based mobile hints...');
    if(acc){
      for(const e of acc){
        if(chosen.has(e.url)) continue;
        const u = (e.url||'').toLowerCase();
        if(u.includes('/mobile') || u.includes('/ios') || u.includes('/android') || u.includes('mobile-') || u.includes('ios-') || u.includes('android-')){
          chosen.set(e.url, { url: e.url, title: e.title||'', company: e.company||'', snippet: (e.snippet||'').replace(/\s+/g,' ').trim(), assigned: e.assigned||[] });
        }
      }
    }
  }

  // produce ordered array
  const out = Array.from(chosen.values());

  // write file
  const lines = [];
  lines.push('Jobs for frame 2 - Mobile Development');
  lines.push('');
  for(const r of out){
    const assignedText = Array.isArray(r.assigned) && r.assigned.length ? r.assigned.map(id=>`${id}`).join(', ') : '';
    lines.push(`- ${r.url}`);
    lines.push(`  Use resume: 2 - Mobile Development`);
    lines.push(`  Assigned: ${assignedText}`);
    const sn = (r.snippet||'').slice(0,400).replace(/\n/g,' ');
    lines.push(`  Snippet: ${sn}`);
    lines.push('');
  }

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, lines.join('\n'), 'utf8');
  console.log('Wrote', OUT, 'with', out.length, 'mobile-focused entries');
}

main().catch(e=>{ console.error(e); process.exit(1); });
