import fs from 'fs/promises';
import { connectToExistingChrome } from '../src/browser.mjs';
import { fetchReadmeMarkdown, extractApplyLinks, snippetAround } from '../src/github.mjs';

const FRAMES = [
  { id: 1, name: 'Software / Full-Stack', keywords: ['full stack','full-stack','fullstack','backend','frontend','react','node','rails','django','spring','express','asp.net','dotnet','c#','java','python','typescript','javascript','sql','postgres','postgresql','mongodb'] },
  { id: 2, name: 'Mobile Development', keywords: ['mobile','ios','android','react native','react-native','expo','swift','kotlin','flutter'] },
  { id: 3, name: 'Data Engineering / Analytics', keywords: ['data','databricks','etl','spark','hadoop','pandas','numpy','scikit','analytics','data engineer','machine learning','ml','sql','postgresql'] },
  { id: 4, name: 'Internal Tools / Platform', keywords: ['internal tools','tooling','platform','sdk','developer tools','cli','observability','instrumentation','platform engineer'] },
  { id: 5, name: 'Research / Emerging Tech', keywords: ['research','r&d','research scientist','ml research','ai research','algorithms','computer vision','nlp','reinforcement'] },
  { id: 6, name: 'Cloud / DevOps', keywords: ['cloud','devops','sre','site reliability','aws','gcp','azure','kubernetes','k8s','docker','ci/cd','terraform','infrastructure'] }
];

function scoreTextAgainstFrame(text, frame){
  const t = (text||'').toLowerCase();
  return frame.keywords.reduce((n,k)=> n + (t.includes(k) ? 1 : 0), 0);
}

const sleep = (ms) => new Promise((res)=> setTimeout(res, ms));

function domainToCompany(url){
  try{
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./,'');
    const parts = host.split('.');
    // take second-level domain if possible
    if(parts.length>=2) return parts[parts.length-2];
    return host;
  }catch(e){ return '' }
}

function parseArgs(){
  const out = { limit: undefined };
  for(let i=2;i<process.argv.length;i++){
    const a = process.argv[i];
    if(a.startsWith('--limit=')) out.limit = parseInt(a.split('=')[1],10);
  }
  if(process.env.LIMIT) out.limit = parseInt(process.env.LIMIT,10);
  if(!out.limit || Number.isNaN(out.limit)) out.limit = 50; // default small run
  return out;
}

async function scrapeOne(page, url){
  const res = { url, title: '', company: '', description: '', snippet: '' };
  try{
  await page.setUserAgent('Mozilla/5.0 (compatible; auto-apply-bot/1.0)');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  // allow some late JS
  await sleep(400);
    const data = await page.evaluate(()=>{
      const title = document.title || '';
      const md = (document.querySelector('meta[name="description"]')||{}).content || (document.querySelector('meta[property="og:description"]')||{}).content || '';
      const ogSite = (document.querySelector('meta[property="og:site_name"]')||{})?.content || (document.querySelector('meta[name="og:site_name"]')||{})?.content || '';
      // pick a main region if available
      const main = (document.querySelector('main') || document.querySelector('article') || document.body);
      const text = main ? main.innerText : document.body.innerText;
      return { title, description: md, ogSite, text: (text||'').slice(0,4000) };
    });
    res.title = data.title.trim();
    res.description = data.description.trim();
    res.snippet = data.text.replace(/\s+/g,' ').trim().slice(0,2000);
    res.company = data.ogSite || domainToCompany(url);
  }catch(e){
    res.snippet = `ERROR: ${String(e).slice(0,300)}`;
  }
  return res;
}

async function main(){
  const args = parseArgs();
  console.log('Starting more accurate pass — limit:', args.limit);

  console.log('Fetching README and extracting links...');
  const md = await fetchReadmeMarkdown();
  const links = extractApplyLinks(md);
  console.log('Links found in README:', links.length);

  // resume support: if a partial JSON exists, load and skip already-processed URLs
  let results = [];
  try{
    const raw = await fs.readFile('jobs_by_resume_frame_accurate_partial.json', 'utf8');
    const parsed = JSON.parse(raw);
    if(Array.isArray(parsed) && parsed.length>0){
      results = parsed;
      console.log('Resuming from partial results — already processed:', results.length);
    }
  }catch(e){ /* no partial file, start fresh */ }

  const processed = new Set(results.map(r=>r.url));
  const remaining = links.filter(u=>!processed.has(u));
  const toProcess = remaining.slice(0, args.limit);
  console.log('Will process (this run):', toProcess.length, 'remaining total:', remaining.length);

  console.log('Connecting to existing Chrome (will fallback to launching one if needed)...');
  let browser;
  let launchedLocally = false;
  try{
    browser = await connectToExistingChrome();
  }catch(err){
    console.log('Could not connect to existing Chrome:', err.message || err);
    console.log('Falling back to launching a local Chrome via puppeteer-core (may require Chrome installed).');
    const puppeteer = await import('puppeteer-core');
    // common macOS chrome path; user can edit if different
    const defaultChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await puppeteer.launch({ executablePath: defaultChrome, headless: false, args: ['--no-sandbox','--disable-setuid-sandbox','--remote-debugging-port=9222'] });
    launchedLocally = true;
  }
  const finalResults = [];

  for(const url of toProcess){
    console.log('Visiting', url);
    let r = null;
    let page = null;
    try{
      // create a fresh page for each URL so a bad navigation doesn't poison subsequent navigations
      page = await browser.newPage();
      // keep user agent consistent
      await page.setUserAgent('Mozilla/5.0 (compatible; auto-apply-bot/1.0)');
      r = await scrapeOne(page, url);
    }catch(e){
      // log and attempt recovery; do not abort the whole run for a single-site failure
      console.error('Error scraping', url, e && e.message ? e.message : e);
      // if browser has disconnected or the page target was closed, try to relaunch/connect once
      try{
        const bad = String(e && e.message || e || '').toLowerCase();
        if(bad.includes('protocol error') || bad.includes('target closed') || bad.includes('closed') || bad.includes('cannot navigate')){
          console.log('Detected browser/page-level error, attempting to reconnect and continue...');
          try{ await browser.close(); }catch(_){ }
          try{
            // attempt to reconnect to an existing Chrome first
            browser = await connectToExistingChrome();
            console.log('Reconnected to existing Chrome');
          }catch(_err){
            // fallback to launching local Chrome
            try{
              const puppeteer = await import('puppeteer-core');
              const defaultChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
              browser = await puppeteer.launch({ executablePath: defaultChrome, headless: false, args: ['--no-sandbox','--disable-setuid-sandbox','--remote-debugging-port=9222'] });
              console.log('Launched local Chrome as fallback');
            }catch(innerErr){
              console.warn('Failed to relaunch browser:', innerErr && innerErr.message ? innerErr.message : innerErr);
            }
          }
        }
      }catch(_){ }
      r = { title: '', company: '', snippet: `ERROR: ${String(e).slice(0,300)}` };
    }finally{
      try{ if(page) await page.close(); }catch(_){ }
    }

    // ensure we have an object to score
    if(!r) r = { title: '', company: '', snippet: '' };

    // score
    const text = [r.title, r.description || '', r.snippet || '', url].join(' ');
    const frameScores = FRAMES.map(f => ({ id: f.id, name: f.name, score: scoreTextAgainstFrame(text, f) }));
    const maxScore = Math.max(...frameScores.map(fs=>fs.score));
    const assigned = maxScore > 0 ? frameScores.filter(fs=>fs.score===maxScore).map(fs=>fs.id) : [];
    const entry = { url, title: r.title || '', company: r.company || '', snippet: r.snippet || '', frameScores, assigned };
    finalResults.push(entry);
    // flush partial results so interruption doesn't lose everything
    try{
      await fs.writeFile('jobs_by_resume_frame_accurate_partial.json', JSON.stringify(results.concat(finalResults), null, 2), 'utf8');
    }catch(e){ /* non-fatal */ }

    // short pause to be polite
    await sleep(200);
  }

  try{ await page.close(); }catch(_){}
  try{
    if(launchedLocally){
      await browser.close();
    }else{
      try{ await browser.disconnect(); }catch(_){}
    }
  }catch(e){}

  const lines = [];
  lines.push('Jobs classified by resume frame (accurate pass)');
  lines.push('Frames:');
  for(const f of FRAMES) lines.push(`${f.id}. ${f.name}`);
  lines.push('');
  for(const r of results){
    const assignedText = r.assigned.length ? r.assigned.map(id=>`${id} (${FRAMES.find(f=>f.id===id).name})`).join(', ') : 'Unassigned';
    const breakdown = r.frameScores.map(fs=>`${fs.id}:${fs.score}`).join(' ');
    lines.push(`- ${r.url}`);
    lines.push(`  Title: ${r.title || ''}`);
    lines.push(`  Company: ${r.company || ''}`);
    lines.push(`  Assigned: ${assignedText}`);
    lines.push(`  Scores: ${breakdown}`);
    const sn = (r.snippet||'').replace(/\s+/g,' ').trim();
    lines.push(`  Snippet: ${sn.slice(0,400)}${sn.length>400? '...':''}`);
    lines.push('');
  }

  const out = lines.join('\n');
  await fs.writeFile('jobs_by_resume_frame_accurate.txt', out, 'utf8');
  console.log('Wrote jobs_by_resume_frame_accurate.txt with', results.length, 'entries');
}

main().catch(e=>{ console.error(e); process.exit(1); });
