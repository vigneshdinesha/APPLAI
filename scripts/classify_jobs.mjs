import fs from 'fs/promises';
import { fetchReadmeMarkdown, extractApplyLinks, snippetAround } from '../src/github.mjs';
import profile from '../profile.json' assert { type: 'json' };

const FRAMES = [
  { id: 1, name: 'Software / Full-Stack', keywords: ['full stack','full-stack','fullstack','backend','frontend','react','node','rails','django','spring','express','asp.net','dotnet','c#','java','python','typescript','javascript','sql','postgres','postgresql','mongodb'] },
  { id: 2, name: 'Mobile Development', keywords: ['mobile','ios','android','react native','react-native','expo','swift','kotlin','flutter'] },
  { id: 3, name: 'Data Engineering / Analytics', keywords: ['data','databricks','etl','spark','hadoop','pandas','numpy','scikit','analytics','data engineer','machine learning','ml','sql','postgresql'] },
  { id: 4, name: 'Internal Tools / Platform', keywords: ['internal tools','tooling','platform','sdk','developer tools','cli','observability','instrumentation','platform engineer'] },
  { id: 5, name: 'Research / Emerging Tech', keywords: ['research','r&d','research scientist','ml research','ai research','algorithms','computer vision','nlp','reinforcement'] },
  { id: 6, name: 'Cloud / DevOps', keywords: ['cloud','devops','sre','site reliability','aws','gcp','azure','kubernetes','k8s','docker','ci/cd','terraform','infrastructure'] }
];

function scoreTextAgainstFrame(text, frame){
  const t = text.toLowerCase();
  return frame.keywords.reduce((n,k)=> n + (t.includes(k) ? 1 : 0), 0);
}

async function main(){
  console.log('Fetching README...');
  const md = await fetchReadmeMarkdown();
  console.log('Extract links...');
  const links = extractApplyLinks(md);
  console.log('Links found:', links.length);

  const results = [];
  for(const url of links){
    const snippet = snippetAround(md, url, 300);
    const text = (url + ' ' + snippet).toLowerCase();
    const frameScores = FRAMES.map(f => ({ id: f.id, name: f.name, score: scoreTextAgainstFrame(text, f) }));
    const maxScore = Math.max(...frameScores.map(fs=>fs.score));
    const assigned = maxScore > 0 ? frameScores.filter(fs=>fs.score===maxScore).map(fs=>fs.id) : [];
    results.push({ url, snippet, frameScores, assigned });
  }

  // Sort: assigned first by max score then score
  results.sort((a,b)=>{
    const aMax = a.frameScores.reduce((m,fs)=>Math.max(m,fs.score),0);
    const bMax = b.frameScores.reduce((m,fs)=>Math.max(m,fs.score),0);
    return bMax - aMax;
  });

  const lines = [];
  lines.push('Jobs classified by resume frame');
  lines.push('Frames:');
  for(const f of FRAMES) lines.push(`${f.id}. ${f.name}`);
  lines.push('');
  for(const r of results){
    const assignedText = r.assigned.length ? r.assigned.map(id=>`${id} (${FRAMES.find(f=>f.id===id).name})`).join(', ') : 'Unassigned';
    const breakdown = r.frameScores.map(fs=>`${fs.id}:${fs.score}`).join(' ');
    lines.push(`- ${r.url}`);
    lines.push(`  Assigned: ${assignedText}`);
    lines.push(`  Scores: ${breakdown}`);
    // include short snippet (one line)
    const sn = r.snippet.replace(/\s+/g,' ').trim();
    lines.push(`  Snippet: ${sn.slice(0,400)}${sn.length>400? '...':''}`);
    lines.push('');
  }

  const out = lines.join('\n');
  await fs.writeFile('jobs_by_resume_frame.txt', out, 'utf8');
  console.log('Wrote jobs_by_resume_frame.txt with', results.length, 'entries');
}

main().catch(e=>{ console.error(e); process.exit(1); });
