#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { connectToExistingChrome } from '../src/browser.mjs';

const DEFAULT_LIST = 'lists/frame_1_software_full_stack.txt';
const DEFAULT_COUNT = 10;

function parseArgs(){
  const out = { list: DEFAULT_LIST, count: DEFAULT_COUNT };
  for(let i=2;i<process.argv.length;i++){
    const a = process.argv[i];
    if(a.startsWith('--list=')) out.list = a.split('=')[1];
    if(a.startsWith('--count=')) out.count = parseInt(a.split('=')[1],10);
  }
  if(process.env.MANUAL_APPLY_LIST) out.list = process.env.MANUAL_APPLY_LIST;
  if(process.env.MANUAL_APPLY_COUNT) out.count = parseInt(process.env.MANUAL_APPLY_COUNT,10);
  if(!out.count || Number.isNaN(out.count)) out.count = DEFAULT_COUNT;
  return out;
}

async function readList(file){
  const txt = await fs.readFile(file, 'utf8');
  // lines starting with '-' are urls
  const lines = txt.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const urls = lines.filter(l=>l.startsWith('- ')).map(l=>l.slice(2).trim());
  return urls;
}

async function loadApplied(){
  try{
    const raw = await fs.readFile('applied.json','utf8');
    return JSON.parse(raw);
  }catch(e){ return {}; }
}

async function saveApplied(obj){
  await fs.writeFile('applied.json', JSON.stringify(obj, null, 2), 'utf8');
}

async function sleep(ms){ return new Promise(res=>setTimeout(res, ms)); }

async function main(){
  const args = parseArgs();
  console.log('Manual apply opener — list:', args.list, 'count:', args.count);

  const absList = path.resolve(args.list);
  const urls = await readList(absList);
  console.log('Found', urls.length, 'candidates in list');

  const applied = await loadApplied();

  // filter out ones we already have any entry for
  const remaining = urls.filter(u=>!applied[u]);
  console.log('Remaining to open:', remaining.length);

  if(remaining.length === 0){
    console.log('No remaining URLs to open. Exiting.');
    return;
  }

  // connect to chrome (must be running with --remote-debugging-port=9222)
  console.log('Connecting to Chrome (ensure Chrome is running with --remote-debugging-port=9222)');
  let browser;
  try{
    browser = await connectToExistingChrome();
  }catch(e){
    console.error('Could not connect to Chrome:', e && e.message ? e.message : e);
    console.error('Start Chrome with: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222');
    process.exit(1);
  }

  let opened = 0;
  for(const url of remaining){
    if(opened >= args.count) break;
    try{
      console.log(`Opening [${opened+1}/${args.count}] ${url}`);
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (compatible; manual-apply-opener/1.0)');
      // open the page in a new tab and wait until the user closes it
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e=>{ console.warn('Navigation warning:', e && e.message ? e.message : e); });

      // record a provisional entry so we don't re-open if restarted
      applied[url] = { ts: new Date().toISOString(), status: 'opened' };
      await saveApplied(applied);

      // poll for the tab to be closed by the user
      console.log('Tab opened. Close the tab when you have submitted the application to continue.');
      while(true){
        // pages() is supported; if page is closed, page.isClosed() will be true or pages list will not include it
        const isClosed = page.isClosed ? page.isClosed() : false;
        if(isClosed) break;
        await sleep(1000);
      }

      // user closed the tab; mark as completed
      applied[url] = { ts: new Date().toISOString(), status: 'manual-submitted' };
      await saveApplied(applied);
      opened += 1;
      console.log(`Marked submitted (${opened}/${args.count}).`);
      // short delay before opening next
      await sleep(500);
    }catch(e){
      console.error('Error during manual open loop for', url, e && e.message ? e.message : e);
      // mark as error so we skip next time
      applied[url] = { ts: new Date().toISOString(), status: 'error', error: String(e).slice(0,300) };
      await saveApplied(applied);
    }
  }

  try{ await browser.disconnect(); }catch(_){ }
  console.log('Done. Opened', opened, 'applications.');
}

main().catch(e=>{ console.error(e); process.exit(1); });
