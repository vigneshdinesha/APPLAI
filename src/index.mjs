import { loadProfile, loadApplied, saveApplied, MAX_PER_RUN } from "./config.mjs";
import { fetchReadmeMarkdown, extractApplyLinks, snippetAround } from "./github.mjs";
import { buildKeywordSet, isRelevant } from "./relevance.mjs";
import { connectToExistingChrome } from "./browser.mjs";
import { draftWhyCompany } from "./answerer.mjs";
import { fillCustomQuestions, createWorkdayAccount, signInWorkday, waitForEmailVerification } from "./formfill.mjs";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Small helper to log verbose when in single-URL debug mode
// attempt to load a local .env file for convenient reuse of credentials
try{
  // lazy require so the package is optional
  /* eslint-disable no-undef */
  const dotenv = await import('dotenv').catch(()=>null);
  if(dotenv && dotenv.config) dotenv.config();
}catch(_){ /* optional */ }

const onlyArg = process.argv.find(a => a.startsWith("--only="));
const VERBOSE = Boolean(onlyArg);

function parseOnlyUrl(){
  if(!onlyArg){
    // fallback to DEFAULT_WORKDAY_URL from env if present
    const def = process.env.DEFAULT_WORKDAY_URL || process.env.WORKDAY_URL || null;
    if(def) return def;
    return null;
  }
  try{ return new URL(onlyArg.split("=")[1]).toString(); }catch(_){ return onlyArg.split("=")[1]; }
}


async function waitForSubmission(page, ms = 180_000) {
  const deadline = Date.now() + ms;
  const PHRASES = [
    "thank you for applying",
    "application submitted",
    "we've received your application",
    "we have received your application",
    "has been submitted",
    "thanks for your application",
    "submission confirmation"
  ];
  while (Date.now() < deadline) {
    try {
      // 1) ATS-specific quick checks in page DOM
      const atsOk = await page.evaluate(() => {
        // Greenhouse: look for thank-you container or .application-submitted
        if (document.querySelector('.application-submitted, .thanks, #submissionConfirmation')) return true;
        // Lever: common confirmation area
        if (document.querySelector('[data-qa="application-confirmation"], .lever-application-complete')) return true;
        // Workday: check for confirmation text or review/thank-you sections
        if (/application submitted|we have received your application|thank you for applying/i.test(document.body?.innerText || '')) return true;
        return false;
      });
      if (VERBOSE) console.log('waitForSubmission: atsOk=', atsOk);
      if (atsOk) return true;

      // 2) Generic phrase search fallback
      const ok = await page.evaluate((phrases) => {
        const t = (document.body?.innerText || "").toLowerCase();
        return phrases.some(p => t.includes(p));
      }, PHRASES);
      if (ok) return true;

      // 3) URL / navigation-based confirmation: some ATS redirect to a /thank-you or /confirmation path
      const href = page.url().toLowerCase();
      if (/thank-you|thankyou|confirmation|application-submitted|application-complete|success/.test(href)){
        if(VERBOSE) console.log('waitForSubmission: url indicates confirmation', href);
        return true;
      }

      // 4) check visible frames for confirmation text (iCIMS often embeds)
      try{
        const frameOk = await page.evaluate(() => {
          const phrases = ['thank you for applying','application submitted','we have received your application','thanks for your application'];
          for(const f of Array.from(document.querySelectorAll('iframe'))){
            try{
              const d = f.contentDocument || f.contentWindow?.document;
              if(!d) continue;
              const t = (d.body?.innerText || '').toLowerCase();
              if(phrases.some(p => t.includes(p))) return true;
            }catch(_){/* cross-origin or not accessible */}
          }
          return false;
        });
        if(frameOk) return true;
      }catch(_){/* ignore frame checks if cross-origin */}
    } catch (_) {}
    await sleep(2500);
  }
  return false;
}

async function saveDiagnostics(page, tag){
  try{
    const now = new Date().toISOString().replace(/[:.]/g,'-');
    const root = path.resolve(process.cwd(), 'diagnostics');
    await mkdir(root, { recursive: true });
    const base = `${now}-${tag}`;
    const imgPath = path.join(root, base + '.png');
    const htmlPath = path.join(root, base + '.html');
    try{ await page.screenshot({ path: imgPath, fullPage: true }); }catch(e){ /* ignore */ }
    try{ const html = await page.content(); await writeFile(htmlPath, html, 'utf8'); }catch(e){ /* ignore */ }
    console.log(`Saved diagnostics: ${imgPath} ${htmlPath}`);
    return { imgPath, htmlPath };
  }catch(e){ console.log('saveDiagnostics failed', String(e)); }
}

// Try to enter the application flow (click apply / reveal form).
async function tryEnterApplication(page, ms = 10_000){
  const deadline = Date.now() + ms;
  const applyKeywords = ['apply for this job online','apply now','apply','start application','apply for this job','apply for this job online'];
  while(Date.now() < deadline){
    try{
      // 1) top-level document
      const topRes = await page.evaluate((keywords) => {
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return !!(r.width && r.height) && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };
        const candidates = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]'));
        for(const el of candidates){
          try{
            const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
            if(!text) continue;
            if(keywords.some(k => text.includes(k)) && isVisible(el)){ el.click(); return {clicked:true, text}; }
          }catch(_){ }
        }
        // look for form presence (sign we're in the app flow)
        if(document.querySelector('form[action*="apply"], form[id*="apply"], form[class*="apply"], [data-qa*="application"]')) return {form:true};
        return {clicked:false};
      }, applyKeywords);
      if(topRes.form) return true;
      if(topRes.clicked) { await sleep(800); return true; }

      // 2) frames
      const frames = page.frames();
      for(const f of frames){
        try{
          const fRes = await f.evaluate((keywords) => {
            const isVisible = (el) => {
              const r = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return !!(r.width && r.height) && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
            };
            const candidates = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]'));
            for(const el of candidates){
              try{
                const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
                if(!text) continue;
                if(keywords.some(k => text.includes(k)) && isVisible(el)){ el.click(); return {clicked:true, text}; }
              }catch(_){ }
            }
            if(document.querySelector('form[action*="apply"], form[id*="apply"], form[class*="apply"], [data-qa*="application"]')) return {form:true};
            return {clicked:false};
          }, applyKeywords);
          if(fRes.form) return true;
          if(fRes.clicked){ await sleep(800); return true; }
        }catch(_){ /* cross-origin frames may be inaccessible */ }
      }
    }catch(_){ }
    await sleep(600);
  }
  return false;
}

// Find an element by text (regex) across light DOM and shadow DOM; return center coords and outerHTML
async function findElementCenterByTextAcrossShadow(page, regexString){
  return await page.evaluate((regexString) => {
    const re = new RegExp(regexString,'i');
    const results = [];
    function inspect(root){
      try{
        const nodes = Array.from(root.querySelectorAll('a,button,input,div,span,[role="button"]'));
        for(const n of nodes){
          try{
            const text = (n.innerText || n.value || n.getAttribute('aria-label') || '').trim();
            if(text && re.test(text)){
              const r = n.getBoundingClientRect();
              results.push({ x: r.left + r.width/2, y: r.top + r.height/2, width: r.width, height: r.height, outer: (n.outerHTML||'').slice(0,400), text: text.slice(0,200) });
              if(results.length>=1) return true;
            }
          }catch(_){ }
        }
        // recurse shadow roots
        const all = Array.from(root.querySelectorAll('*'));
        for(const el of all){
          try{
            if(el.shadowRoot){ if(inspect(el.shadowRoot)) return true; }
          }catch(_){ }
        }
      }catch(_){ }
      return false;
    }
    inspect(document);
    return results[0] || null;
  }, regexString);
}

// Try to inject Workday client scripts into the page to force the client to hydrate #root
async function injectWorkdayScripts(page){
  try{
    // run in-page to read window.workday and append the same scripts the page expects
    const ok = await page.evaluate(() => {
      try{
        if(!window.workday) return false;
        const cdn = window.workday.cdnEndpoint ? ('https://' + window.workday.cdnEndpoint) : 'https://wd5.myworkdaycdn.com';
        const clientOrigin = window.workday.clientOrigin || cdn;
        function add(src){
          try{
            const s = document.createElement('script');
            s.src = src;
            // ensure it's treated as a normal script so it runs immediately
            s.defer = false;
            s.async = false;
            s.setAttribute('crossorigin','anonymous');
            document.head.appendChild(s);
            return true;
          }catch(e){ return false; }
        }
        // load shared vendors and jobs assets (as the page would)
        const shared = (clientOrigin.replace(/\/$/, '') + '/wday/asset/uic-shared-vendors/shared-vendors.min.js');
        const jobs = (cdn.replace(/\/$/, '') + '/wday/asset/candidate-experience-jobs/cx-jobs.min.js');
        add(shared);
        add(jobs);
        // also try analytics which some tenants rely on to finish boot
        const analytics = (clientOrigin.replace(/\/$/, '') + '/wday/asset/client-analytics/uxInsights.min.js');
        add(analytics);
        return true;
      }catch(e){ return false; }
    });
    return Boolean(ok);
  }catch(e){ if(VERBOSE) console.log('injectWorkdayScripts outer error', String(e)); return false; }
}

// Exhaustive scan for an 'Apply' CTA across shadow DOM, main document and all frames.
// Tries multiple strategies and returns an object { clicked, method, info }
async function scanAndClickApply(page, ms = 10000){
  const deadline = Date.now() + ms;
  const tryClickAt = async (x,y) => {
    try{
      await page.mouse.move(x, y, { steps: 6 });
      await sleep(60);
      await page.mouse.down();
      await sleep(30);
      await page.mouse.up();
      return true;
    }catch(e){ return false; }
  };

  // 1) Shadow DOM search (high confidence)
  try{
    const hit = await findElementCenterByTextAcrossShadow(page, 'apply|apply now|apply for this job|start application|apply-online|apply for this job');
    if(hit){
      const ok = await tryClickAt(hit.x, hit.y);
      return { clicked: Boolean(ok), method: 'shadow-dom', info: hit };
    }
  }catch(e){ if(VERBOSE) console.log('scanAndClickApply shadow error', String(e)); }

  // 2) Search frames for visible apply-like elements using XPath
  try{
    const frames = page.frames();
    for(const f of frames){
      try{
        const candidate = await f.evaluate(() => {
          try{
            const nodes = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit],[role="button"]'));
            const re = /apply|apply now|apply for this job|start application|apply-online|applyfor/i;
            for(const n of nodes){
              try{
                const text = (n.innerText || n.value || n.getAttribute('aria-label') || '').toLowerCase();
                if(re.test(text)){
                  try{ n.scrollIntoView({block:'center'}); n.click(); return { found:true, clicked:true }; }catch(e){
                    const r = n.getBoundingClientRect(); return { found:true, clicked:false, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, outer: (n.outerHTML||'').slice(0,800) };
                  }
                }
              }catch(_){ }
            }
          }catch(_){ }
          return { found:false };
        });
        if(candidate && candidate.found){
          if(candidate.clicked) return { clicked:true, method:'frame-evaluate-click', frame: f.url() };
          if(candidate.rect){ const ok = await tryClickAt(candidate.rect.x + candidate.rect.width/2, candidate.rect.y + candidate.rect.height/2); if(ok) return { clicked:true, method:'frame-evaluate-mouse', frame: f.url(), rect: candidate.rect }; }
        }
      }catch(_){ /* ignore cross-origin frames or evaluate errors */ }
    }
  }catch(e){ if(VERBOSE) console.log('scanAndClickApply frames error', String(e)); }

  // 3) Top-level page XPath search
  try{
    const pageCandidate = await page.evaluate(() => {
      try{
        const nodes = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit],[role="button"]'));
        const re = /apply|apply now|apply for this job|start application|apply-online|applyfor/i;
        for(const n of nodes){
          try{
            const text = (n.innerText || n.value || n.getAttribute('aria-label') || '').toLowerCase();
            if(re.test(text)){
              try{ n.scrollIntoView({block:'center'}); n.click(); return { found:true, clicked:true }; }catch(e){ const r = n.getBoundingClientRect(); return { found:true, clicked:false, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, outer: (n.outerHTML||'').slice(0,800) }; }
            }
          }catch(_){ }
        }
      }catch(_){ }
      return { found:false };
    });
    if(pageCandidate && pageCandidate.found){
      if(pageCandidate.clicked) return { clicked:true, method:'page-evaluate-click' };
      if(pageCandidate.rect){ const ok = await tryClickAt(pageCandidate.rect.x + pageCandidate.rect.width/2, pageCandidate.rect.y + pageCandidate.rect.height/2); if(ok) return { clicked:true, method:'page-evaluate-mouse', rect: pageCandidate.rect }; }
    }
  }catch(e){ if(VERBOSE) console.log('scanAndClickApply page-xpath error', String(e)); }

  // 4) Anchor href heuristics: look for links whose hrefs point to known ATS or contain apply tokens
  try{
    const href = await page.$$eval('a[href]', (nodes) => {
      const patterns = ['apply','icims','myworkday','greenhouse','lever','smartrecruiters','apply-online','candidate-experience','applyfor'];
      for(const n of nodes){
        try{
          const h = n.href || '';
          const txt = (n.innerText || n.getAttribute('aria-label') || '').toLowerCase();
          if(patterns.some(p => h.toLowerCase().includes(p) || txt.includes(p))) return h;
        }catch(_){ }
      }
      return null;
    });
    if(href){
      // try clicking the anchor element first to preserve handlers
      const clicked = await page.evaluate((pattern, href) => {
        try{
          const nodes = Array.from(document.querySelectorAll('a[href]'));
          const el = nodes.find(n => (n.href || '').includes(href) || /(apply|apply-online|icims|myworkday|greenhouse|lever|smartrecruiters|applyfor)/i.test(n.href || '') );
          if(!el) return false;
          el.scrollIntoView({block:'center'});
          el.click();
          return true;
        }catch(e){ return false; }
      }, href);
      if(clicked){
        // wait briefly for navigation/new tab
        await sleep(700);
        return { clicked: true, method: 'anchor-click', href };
      }
      // fallback to goto
      try{ await page.setExtraHTTPHeaders({ referer: page.url() }); }catch(_){ }
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(()=>{});
      try{ await page.setExtraHTTPHeaders({}); }catch(_){ }
      return { clicked: true, method: 'anchor-goto', href };
    }
  }catch(e){ if(VERBOSE) console.log('scanAndClickApply anchor error', String(e)); }

  // 5) Bruteforce scan: walk all elements and look for any text/label containing 'apply'
  try{
    const brute = await page.evaluate(() => {
      function isVisible(el){
        try{
          const style = window.getComputedStyle(el);
          if(style && (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity||1)===0)) return false;
          const rects = el.getClientRects();
          if(!rects || rects.length === 0) return false;
          // ensure at least one rect has area
          for(const r of rects){ if(r.width>0 && r.height>0) return true; }
        }catch(_){ }
        return false;
      }
      const needle = 'apply';
      const nodes = Array.from(document.querySelectorAll('*'));
      for(const n of nodes){
        try{
          const text = ((n.innerText || n.getAttribute('aria-label') || n.getAttribute('title') || n.getAttribute('alt') || '') + '').toLowerCase().trim();
          if(!text) continue;
          if(text.includes(needle)){
            // find clickable ancestor
            const clickable = n.closest('a,button,[role="button"],input[type="button"],input[type="submit"]') || n;
            if(!isVisible(clickable)) continue;
            const r = clickable.getBoundingClientRect();
            return { cx: r.left + r.width/2, cy: r.top + r.height/2, outer: (clickable.outerHTML||'').slice(0,800), href: clickable.href || null, tag: clickable.tagName };
          }
        }catch(_){ }
      }
      return null;
    });
    if(brute){
      if(VERBOSE) console.log('scanAndClickApply brute candidate:', brute);
      // first try to dispatch events in-page on the element matched by outerHTML (best-effort)
      const triedInPage = await page.evaluate((outer) => {
        try{
          const el = Array.from(document.querySelectorAll('*')).find(e => (e.outerHTML||'').slice(0,800) === outer);
          if(!el) return false;
          const evInit = { bubbles:true, cancelable:true, composed:true };
          el.dispatchEvent(new PointerEvent('pointerover', evInit));
          el.dispatchEvent(new PointerEvent('pointerenter', evInit));
          el.dispatchEvent(new PointerEvent('pointerdown', { ...evInit, pointerId:1, isPrimary:true }));
          el.dispatchEvent(new PointerEvent('pointerup', { ...evInit, pointerId:1, isPrimary:true }));
          el.dispatchEvent(new MouseEvent('click', evInit));
          return true;
        }catch(e){ return false; }
      }, brute.outer).catch(()=>false);
      if(triedInPage){ await sleep(400); return { clicked:true, method:'brute-evaluate', info: brute }; }
      // fallback to puppeteer mouse at center
      const ok = await tryClickAt(brute.cx, brute.cy);
      if(ok) return { clicked:true, method:'brute-mouse', info: brute };
    }
  }catch(e){ if(VERBOSE) console.log('scanAndClickApply brute error', String(e)); }

  // 5) No candidate found
  return { clicked:false };
}

// When a modal like 'Start Your Application' appears, pick the best option.
// Preference order: Autofill with Resume -> Use My Last Application -> Apply Manually -> generic Apply
async function chooseApplyModalOption(page, ms = 8000){
  const deadline = Date.now() + ms;
  const choices = [
    { key: 'autofill', regex: 'autofill|autofill with resume|autofill resume' },
    { key: 'use-last', regex: 'use my last application|use my last|use last application' },
    { key: 'manual', regex: 'apply manually|apply manually|apply without resume' },
    { key: 'apply', regex: '\\bapply\\b|apply now|continue' }
  ];

  while(Date.now() < deadline){
    try{
      // 1) shadow-aware finder for each pattern
      for(const c of choices){
        const hit = await findElementCenterByTextAcrossShadow(page, c.regex).catch(()=>null);
        if(hit){
          // Try an in-page text-aware click first: DOM click -> pointer dispatch -> pass coords back for puppeteer click
          const clickResult = await page.evaluate((regex) => {
            try{
              const re = new RegExp(regex, 'i');
              function isVisible(el){
                try{
                  const r = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return !!(r.width && r.height) && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
                }catch(_){ return false; }
              }
              // prefer interactive elements
              const candidates = Array.from(document.querySelectorAll('button,a,[role="button"],input'));
              let el = candidates.find(n => { try{ const txt = (n.innerText||n.value||n.getAttribute('aria-label')||'').trim(); return txt && re.test(txt) && isVisible(n); }catch(_){ return false; } });
              if(!el){
                // fallback: scan all elements
                const all = Array.from(document.querySelectorAll('*'));
                el = all.find(n => { try{ const txt = (n.innerText||n.getAttribute('aria-label')||'').trim(); return txt && re.test(txt) && isVisible(n); }catch(_){ return false; } });
              }
              if(!el) return { ok: false };
              el.scrollIntoView({ block: 'center' });
              // try native click
              try{ el.click(); return { ok: true, method: 'dom-click' }; }catch(_){ }
              // try dispatching pointer/mouse events
              try{
                const ev = { bubbles: true, cancelable: true, composed: true };
                el.dispatchEvent(new PointerEvent('pointerover', ev));
                el.dispatchEvent(new PointerEvent('pointerenter', ev));
                el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, ev, { pointerId: 1, isPrimary: true })));
                el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, ev, { pointerId: 1, isPrimary: true })));
                el.dispatchEvent(new MouseEvent('click', ev));
                return { ok: true, method: 'pointer-dispatch' };
              }catch(_){ }
              // last resort: return center coords so puppeteer can click
              try{ const r = el.getBoundingClientRect(); return { ok: false, coords: { x: r.left + r.width/2, y: r.top + r.height/2 }, outer: (el.outerHTML||'').slice(0,800) }; }catch(_){ return { ok: false }; }
            }catch(e){ return { ok: false }; }
          }, c.regex).catch(()=>({ ok: false }));

          if(clickResult.ok){ return { chosen: c.key, info: Object.assign({}, hit, { method: clickResult.method || 'dom' }) }; }
          // if page returned coords, use puppeteer to click there
          if(clickResult.coords && typeof clickResult.coords.x === 'number'){
            try{ await page.mouse.move(clickResult.coords.x, clickResult.coords.y, { steps: 6 }); await sleep(60); await page.mouse.down(); await sleep(30); await page.mouse.up(); return { chosen: c.key, info: Object.assign({}, hit, { method: 'coords-click', rect: clickResult.coords, outer: clickResult.outer }) }; }catch(_){ /* fallthrough */ }
          }
          // fallback: click at the hit center
          try{ await page.mouse.move(hit.x, hit.y, { steps: 6 }); await sleep(60); await page.mouse.down(); await sleep(30); await page.mouse.up(); }catch(_){ }
          return { chosen: c.key, info: hit };
        }
      }

      // 2) top-level DOM scan for matching buttons
      const top = await page.evaluate(() => {
        try{
          const nodes = Array.from(document.querySelectorAll('button,a,input[type=button],input[type=submit],[role="button"]'));
          return nodes.map(n => ({ text: (n.innerText||n.value||n.getAttribute('aria-label')||'').slice(0,200), outer: (n.outerHTML||'').slice(0,800), rect: (n.getBoundingClientRect? { x: n.getBoundingClientRect().left, y: n.getBoundingClientRect().top, width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height } : null) }));
        }catch(e){ return []; }
      });
      if(Array.isArray(top) && top.length){
        for(const c of choices){
          const found = top.find(t => new RegExp(c.regex, 'i').test(t.text));
          if(found){
            const clicked = await page.evaluate((outer) => {
              try{ const el = Array.from(document.querySelectorAll('*')).find(e => (e.outerHTML||'').slice(0,800) === outer); if(!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; }catch(e){ return false; }
            }, found.outer).catch(()=>false);
            if(!clicked && found.rect){ try{ await page.mouse.move(found.rect.x + found.rect.width/2, found.rect.y + found.rect.height/2, { steps: 6 }); await sleep(60); await page.mouse.down(); await sleep(30); await page.mouse.up(); }catch(_){ } }
            return { chosen: c.key, info: found };
          }
        }
      }
    }catch(e){ if(VERBOSE) console.log('chooseApplyModalOption outer', String(e)); }
    await sleep(300);
  }
  return { chosen: 'none' };
}


function parseCompanyFromUrl(u){
  try{
    const host = new URL(u).hostname.replace(/^www\./,"");
    // try to extract company-ish part
    const parts = host.split(".");
    return parts[0].replace(/boards|careers|jobs|gh|lever|workday|myworkdayjobs|ashby|smartrecruiters/i,"").toUpperCase() || host.toUpperCase();
  }catch(_){ return "the company"; }
}

async function main(){
  const profile = loadProfile();
  const applied = loadApplied();

  const md = await fetchReadmeMarkdown();
  const links = extractApplyLinks(md);

  const kwset = buildKeywordSet(profile);

  const candidates = links
    .filter(u => !applied[u])
    .map(u => ({ url: u, snippet: snippetAround(md, u) }))
    .filter(({ url, snippet }) => isRelevant(url, snippet, kwset))
    .slice(0, MAX_PER_RUN);

  if (candidates.length === 0) {
    console.log("No relevant, new links found. (Extractor now handles image buttons + ATS fallbacks.)");
    return; // <-- early exit BEFORE connecting to Chrome
  }

  console.log(`Found ${links.length} apply links; attempting up to ${candidates.length}.`);

  const browser = await connectToExistingChrome();


  let done = 0;
  for(const {url, snippet} of candidates){
    console.log("\n==> Opening:", url);
    let page;
    // if true, we won't auto-close this page at the end of the try/finally so you can finish manually
    let leaveOpen = false;
    try{
      page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
      // Wait for client-rendered content (Workday uses JS to populate #root).
      // Retry reload a couple times before marking unavailable because the client scripts sometimes load slowly.
      const ROOT_WAIT_MS = 10_000;
      const RELOAD_RETRIES = 2;
      const RELOAD_BACKOFF_MS = 1200;
      let rootPopulated = false;
      try{
        await page.waitForFunction(() => {
          const r = document.querySelector('#root');
          return !!(r && r.childElementCount && r.childElementCount > 0);
        }, { timeout: ROOT_WAIT_MS });
        rootPopulated = true;
      }catch(_){
        // try reloading a few times with short backoff
        for(let i=0;i<RELOAD_RETRIES && !rootPopulated;i++){
          if(VERBOSE) console.log(`root empty; retry reload ${i+1}/${RELOAD_RETRIES}`);
          await sleep(RELOAD_BACKOFF_MS * (i+1));
          try{ await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }); }catch(_){ }
          try{
            await page.waitForFunction(() => {
              const r = document.querySelector('#root');
              return !!(r && r.childElementCount && r.childElementCount > 0);
            }, { timeout: 7000 });
            rootPopulated = true;
            break;
          }catch(_){ /* continue */ }
        }
      }
      if(!rootPopulated){
        if(VERBOSE) console.log('root remained empty after retries; saving diagnostics and marking unavailable');
        // try injecting Workday client scripts and wait a bit for hydration
        try{
          if(VERBOSE) console.log('root empty: attempting to inject Workday scripts to force hydrate');
          const injected = await injectWorkdayScripts(page);
          if(injected){
            if(VERBOSE) console.log('injected workday scripts; waiting for #root to populate');
            try{
              await page.waitForFunction(() => {
                const r = document.querySelector('#root');
                return !!(r && r.childElementCount && r.childElementCount > 0);
              }, { timeout: 10000 });
              rootPopulated = true;
            }catch(_){ /* ignore */ }
          }
        }catch(e){ if(VERBOSE) console.log('injectWorkdayScripts failed', String(e)); }

        if(!rootPopulated){
          try{ await saveDiagnostics(page, 'root-empty'); }catch(_){ }
          applied[url] = { ts: new Date().toISOString(), status: 'unavailable' };
          saveApplied(applied);
          leaveOpen = true;
          continue;
        }
      }
      // After the page is populated, run a deep scan for 'Apply' CTAs and attempt a click
      try{
        const scanRes = await scanAndClickApply(page, 12000);
        if(VERBOSE) console.log('scanAndClickApply result:', scanRes);
        // if we clicked and page navigated to a new flow, give it a short moment
        if(scanRes && scanRes.clicked) await sleep(900);
      }catch(e){ if(VERBOSE) console.log('scanAndClickApply outer error', String(e)); }
      // Verbose diagnostic: collect up to 8 candidate anchors/buttons that look like apply CTAs
      if(VERBOSE){
        try{
          const cands = await page.evaluate(() => {
            const out = [];
            const nodes = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]'));
            const re = /apply|apply now|apply for this job|start application|apply-online|icims/i;
            for(const n of nodes){
              try{
                const text = (n.innerText || n.value || n.getAttribute('aria-label') || '').trim();
                const href = n.href || n.getAttribute('data-href') || null;
                const cls = n.className || '';
                const id = n.id || '';
                if(re.test(text) || re.test(href || '') || /apply/.test(cls) || /apply/.test(id)){
                  const r = n.getBoundingClientRect ? n.getBoundingClientRect() : { x:0,y:0,width:0,height:0 };
                  const outer = (n.outerHTML || '').replace(/\s+/g,' ').slice(0,400);
                  out.push({ text: text.slice(0,120), href, cls: cls.toString().slice(0,120), id: id.toString().slice(0,80), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, outer });
                }
                if(out.length >= 8) break;
              }catch(_){ }
            }
            return out;
          });
          console.log('VERBOSE: apply candidates:', JSON.stringify(cands, null, 2));
          	  if(Array.isArray(cands) && cands.length === 0){
            	// no visible candidates: attempt to inject Workday scripts (if present) and re-scan once
            	try{
            	  if(VERBOSE) console.log('VERBOSE: no apply candidates found — attempting Workday script inject + re-scan');
            	  const injected = await injectWorkdayScripts(page);
            	  if(injected){
            	    await sleep(1200);
            	    const rescanned = await page.evaluate(() => {
            	      const out = [];
            	      const nodes = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]'));
            	      const re = /apply|apply now|apply for this job|start application|icims/i;
            	      for(const n of nodes){
            	        try{
            	          const text = (n.innerText || n.value || n.getAttribute('aria-label') || '').trim();
            	          const href = n.href || n.getAttribute('data-href') || null;
            	          if(re.test(text) || re.test(href || '') || /apply/.test(n.className||'') || /apply/.test(n.id||'')){
            	            const r = n.getBoundingClientRect ? n.getBoundingClientRect() : { x:0,y:0,width:0,height:0 };
            	            out.push({ text: text.slice(0,120), href, cls: (n.className||'').toString().slice(0,120), id: (n.id||'').toString().slice(0,80), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, outer: (n.outerHTML||'').slice(0,400) });
            	          }
            	        }catch(_){ }
            	        if(out.length>=8) break;
            	      }
            	      return out;
            	    });
            	    console.log('VERBOSE: rescanned apply candidates after inject:', JSON.stringify(rescanned, null, 2));
            	    if(Array.isArray(rescanned) && rescanned.length === 0){
            	      try{ await saveDiagnostics(page, 'no-candidates'); }catch(e){ console.log('failed to save no-candidates diagnostics', String(e)); }
            	    }
            	  } else {
            	    try{ await saveDiagnostics(page, 'no-candidates'); }catch(e){ console.log('failed to save no-candidates diagnostics', String(e)); }
            	  }
            	}catch(e){ console.log('failed to inject/rescan', String(e)); try{ await saveDiagnostics(page, 'no-candidates'); }catch(_){ } }
          	}
        }catch(e){ console.log('VERBOSE: failed to collect apply candidates', String(e)); }
      }
      // Shadow-DOM aware search+click for 'apply' text (high-confidence attempt)
      try{
        const shadowHit = await findElementCenterByTextAcrossShadow(page, 'apply|apply now|apply for this job|start application');
        if(shadowHit){
          if(VERBOSE) console.log('shadow-dom-apply candidate:', shadowHit);
          try{
            await page.mouse.move(shadowHit.x, shadowHit.y, { steps: 6 });
            await sleep(60);
            await page.mouse.down();
            await sleep(40);
            await page.mouse.up();
            await sleep(700);
          }catch(e){ if(VERBOSE) console.log('shadow-dom mouse click error', String(e)); }
        }
      }catch(e){ if(VERBOSE) console.log('shadow-dom search error', String(e)); }
      // Text/XPath based click fallback: target Workday/iCIMS buttons that require real user events
      try{
        const clickedByText = await (async () => {
          const texts = ['apply for this job online','apply now','apply','start application','apply for this job'];
          for(const t of texts){
            try{
              const xp = `//button[contains(translate(normalize-space(string(.)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${t}')] | //a[contains(translate(normalize-space(string(.)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${t}')]`;
              const nodes = await page.$x(xp);
              if(nodes.length){
                const el = nodes[0];
                try{
                  const box = await el.boundingBox();
                  if(box){
                    if(VERBOSE) console.log('clickByText: moving to', box);
                    await page.mouse.move(box.x + box.width/2, box.y + box.height/2, { steps: 8 });
                    await sleep(60);
                    await page.mouse.down();
                    await sleep(40);
                    await page.mouse.up();
                  }else{
                    // fallback to DOM click
                    await el.evaluate(e => { e.scrollIntoView({block:'center'}); e.click(); });
                  }
                  // small wait for navigation or dynamic load
                  await sleep(700);
                  return true;
                }catch(e){ if(VERBOSE) console.log('clickByText element click error', String(e)); }
              }
            }catch(_){ }
          }
          return false;
        })();
        if(VERBOSE) console.log('text-xpath-apply-click:', clickedByText);
      }catch(e){ if(VERBOSE) console.log('text-xpath-apply-click outer error', String(e)); }
      // Try to click a visible 'Apply' button by matching visible elements' text or class/id
      try{
        // 1) try top-level visible apply buttons/controls
        const res = await page.evaluate(() => {
          const keywords = ['apply for this job online','apply now','apply','start application','submit application','apply for this job'];
          const isVisible = (el) => {
            const r = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return !!(r.width && r.height) && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
          };
          const candidates = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]'));
          for (const el of candidates) {
            try{
              const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
              if (!text) continue;
              if (keywords.some(k => text.includes(k))) { if(isVisible(el)){ el.click(); return {clicked:true, by:'text', text}; } }
            }catch(_){/* ignore */}
          }
          for (const el of candidates){
            try{
              const cls = (el.className || '').toString().toLowerCase();
              const id = (el.id || '').toString().toLowerCase();
              if ((cls.includes('apply') || id.includes('apply')) && isVisible(el)) { el.click(); return {clicked:true, by:'attr', cls, id}; }
            }catch(_){/* ignore */}
          }
          return {clicked:false};
        });
        if(VERBOSE) console.log('apply-click-attempt:', res);
        if(!res.clicked){
          // 2) follow anchor hrefs that look like apply links (common for iCIMS where CTA is an anchor)
          const href = await page.$$eval('a[href]', (nodes) => {
            const good = nodes.map(n => n.href).find(h => /apply|icims|apply-online|applyfor/.test(h));
            return good || null;
          });
          if(href){
            if(VERBOSE) console.log('attempting to click apply anchor (preferred) for href:', href);
            const pagesBefore = await browser.pages();
            // try to click the anchor element in-page so site JS runs and referrer/handlers are preserved
            const clickInfo = await page.evaluate((pattern) => {
              try{
                const re = new RegExp(pattern);
                const nodes = Array.from(document.querySelectorAll('a[href]'));
                const el = nodes.find(n => re.test(n.href) || re.test(n.getAttribute('data-href') || '') || n.href.includes('#'));
                if(!el) return {clicked:false};
                el.scrollIntoView({block:'center'});
                el.click();
                return {clicked:true, href: el.href, target: el.target || ''};
              }catch(e){ return {clicked:false}; }
            }, 'apply|icims|apply-online|applyfor');

            if(clickInfo.clicked){
              // wait briefly for either a new tab to open or the current page to navigate
              const beforeCount = pagesBefore.length;
              let newPage = null;
              const start = Date.now();
              while(Date.now() - start < 5000){
                const pagesNow = await browser.pages();
                if(pagesNow.length > beforeCount){
                  newPage = pagesNow.find(p => !pagesBefore.includes(p));
                  break;
                }
                // if the same page navigated, break early
                const nowUrl = page.url();
                if(nowUrl && nowUrl !== href && nowUrl !== url) break;
                await sleep(300);
              }
              if(newPage){
                page = newPage;
                await page.bringToFront().catch(()=>{});
                await sleep(800);
              } else {
                // try to wait for navigation on the current page
                await page.waitForNavigation({ timeout: 8000, waitUntil: 'domcontentloaded' }).catch(()=>{});
              }
            } else {
              // attempt a real user-like mouse click as some sites only respond to mouse events
              if(VERBOSE) console.log('attempting user-simulated mouse click for apply anchor');
              try{
                const clickResult = await page.evaluate((pattern) => {
                  try{
                    const re = new RegExp(pattern);
                    const nodes = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]'));
                    const el = nodes.find(n => {
                      const href = n.href || '';
                      const text = (n.innerText || n.value || '').toLowerCase();
                      return re.test(href) || /apply/.test(text) || /apply/.test(n.className || '') || /apply/.test(n.id || '');
                    });
                    if(!el) return { found: false };
                    el.scrollIntoView({block:'center'});
                    // try dispatching pointer events & click to emulate a trusted user event
                    try{
                      const rect = el.getBoundingClientRect();
                      const evInit = { bubbles:true, cancelable:true, composed:true };
                      el.dispatchEvent(new PointerEvent('pointerover', evInit));
                      el.dispatchEvent(new PointerEvent('pointerenter', evInit));
                      el.dispatchEvent(new PointerEvent('pointerdown', { ...evInit, pointerId:1, isPrimary:true }));
                      el.dispatchEvent(new PointerEvent('pointerup', { ...evInit, pointerId:1, isPrimary:true }));
                      el.dispatchEvent(new MouseEvent('click', evInit));
                      return { found: true, method: 'pointer', cx: rect.left + rect.width/2, cy: rect.top + rect.height/2, href: el.href || null };
                    }catch(e){
                      // return center coords so we can do a physical mouse click from puppeteer
                      const r = el.getBoundingClientRect();
                      return { found: true, method: 'coords', cx: r.left + r.width/2, cy: r.top + r.height/2, href: el.href || null };
                    }
                  }catch(e){ return { found:false }; }
                }, 'apply|icims|apply-online|applyfor');
                if(clickResult.found){
                  if(clickResult.method === 'coords' && typeof clickResult.cx === 'number'){
                    await page.mouse.move(clickResult.cx, clickResult.cy, { steps: 8 });
                    await sleep(60);
                    await page.mouse.down();
                    await sleep(40);
                    await page.mouse.up();
                  }
                  // wait for possible navigation or new tab
                  const beforeCount2 = pagesBefore.length;
                  const start2 = Date.now();
                  let newPage2 = null;
                  while(Date.now() - start2 < 5000){
                    const pagesNow = await browser.pages();
                    if(pagesNow.length > beforeCount2){
                      newPage2 = pagesNow.find(p => !pagesBefore.includes(p));
                      break;
                    }
                    const nowUrl = page.url();
                    if(nowUrl && nowUrl !== href && nowUrl !== url) break;
                    await sleep(300);
                  }
                  if(newPage2){ page = newPage2; await page.bringToFront().catch(()=>{}); }
                  else { await page.waitForNavigation({ timeout: 8000, waitUntil: 'domcontentloaded' }).catch(()=>{}); }
                } else {
                  if(VERBOSE) console.log('no element found for user click fallback');
                }
                // if the in-page attempts didn't navigate and we have an anchor href, try window.open as last resort
                if(!(await page.url()) || (await page.url()) === url){
                  try{
                    const opened = await page.evaluate((pattern, fallbackHref) => {
                      const re = new RegExp(pattern);
                      const nodes = Array.from(document.querySelectorAll('a[href]'));
                      const el = nodes.find(n => re.test(n.href) || (fallbackHref && n.href.includes(fallbackHref)));
                      if(el){ window.open(el.href, '_blank'); return true; }
                      return false;
                    }, 'apply|icims|apply-online|applyfor', href);
                    if(opened){
                      // wait for new tab
                      const start3 = Date.now();
                      while(Date.now() - start3 < 5000){
                        const pagesNow = await browser.pages();
                        if(pagesNow.length > pagesBefore.length){
                          const newPage3 = pagesNow.find(p => !pagesBefore.includes(p));
                          if(newPage3){ page = newPage3; await page.bringToFront().catch(()=>{}); break; }
                        }
                        await sleep(200);
                      }
                    }
                  }catch(_){ }
                }
              }catch(e){ if(VERBOSE) console.log('mouse-simulated-click failed', String(e)); }
              
              // fallback to direct navigation if no clickable anchor was found
              if(VERBOSE) console.log('no clickable anchor found, falling back to goto for', href);
              try{
                // set a lightweight Referer header to mimic navigation from the JD page
                await page.setExtraHTTPHeaders({ referer: url });
              }catch(_){ }
              await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(()=>{});
              try{ await page.setExtraHTTPHeaders({}); }catch(_){ }
            }

            // detect obvious 'service is unavailable' or empty pages and retry once before giving up
            let unavailable = false;
            try{
              const txt = await page.evaluate(() => (document.body?.innerText || '').toLowerCase());
              if(!txt || txt.includes('service is unavailable') || txt.trim().length < 50) unavailable = true;
            }catch(_){ }
            if(unavailable){
              if(VERBOSE) console.log('apply target looks blank/unavailable; retrying once');
              await sleep(1200);
              try{ await page.reload({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(()=>{}); }catch(_){ }
              try{
                const txt2 = await page.evaluate(() => (document.body?.innerText || '').toLowerCase());
                if(!txt2 || txt2.includes('service is unavailable') || txt2.trim().length < 50) unavailable = true; else unavailable = false;
              }catch(_){ }
            }
            if(unavailable){
              console.log('Apply link target appears unavailable; leaving tab open for manual retry.');
              await saveDiagnostics(page, 'unavailable');
              applied[url] = { ts: new Date().toISOString(), status: 'unavailable' };
              saveApplied(applied);
              leaveOpen = true;
              continue;
            }

            // try to enter the application flow on the new page (sometimes a fragment or embedded form)
            try{ await tryEnterApplication(page, 10_000); }catch(_){ }
          }
        }

        // 3) if still not navigated, search inside frames (some CTS embed the form)
        if(!res.clicked){
          const frames = page.frames();
          for(const f of frames){
            try{
              const fRes = await f.evaluate(() => {
                const keywords = ['apply for this job online','apply now','apply','start application'];
                const isVisible = (el) => {
                  const r = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return !!(r.width && r.height) && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
                };
                const candidates = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]'));
                for (const el of candidates) {
                  try{
                    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
                    if (!text) continue;
                    if (keywords.some(k => text.includes(k)) && isVisible(el)) { el.click(); return {clicked:true, text}; }
                  }catch(_){/* ignore */}
                }
                return {clicked:false};
              });
              if(fRes && fRes.clicked){ if(VERBOSE) console.log('clicked inside frame', f.url()); break; }
            }catch(_){/* cross-origin frames may throw; ignore */}
          }
        }

        await sleep(1200);
      }catch(e){ if(VERBOSE) console.log('apply-click-error', String(e)); }

      // If an intermediary modal like 'Start Your Application' appeared, try to choose the best option
      try{
        const modalChoice = await chooseApplyModalOption(page, 8000).catch(()=>({ chosen: 'none' }));
        if(VERBOSE) console.log('chooseApplyModalOption result:', modalChoice);
        if(modalChoice && modalChoice.chosen && modalChoice.chosen !== 'none') {
          // give the page a moment to progress after modal selection
          await sleep(700);
          // also watch for navigation or a new tab opened by the modal click; give it a bit more time
          const beforePages = await browser.pages();
          const startNav = Date.now();
          let newPage = null;
          while(Date.now() - startNav < 3000){
            const pagesNow = await browser.pages();
            if(pagesNow.length > beforePages.length){
              newPage = pagesNow.find(p => !beforePages.includes(p));
              break;
            }
            // check if the current page navigated to a different URL (some modals replace location)
            try{ const nowUrl = page.url(); if(nowUrl && nowUrl !== url) break; }catch(_){ }
            await sleep(250);
          }
          if(newPage){
            if(VERBOSE) console.log('Modal click opened a new tab; switching to new page for create-account handling');
            page = newPage;
            await page.bringToFront().catch(()=>{});
            await sleep(900);
          } else {
            // ensure dynamic content has time to render after modal; some tenants load the full create-account UI slowly
            await sleep(1200);
          }
        }
      }catch(e){ if(VERBOSE) console.log('chooseApplyModalOption outer error', String(e)); }

      // Immediately check whether a Create Account form appeared in the modal or page after modal choice
      try{
        const acctFormNow = await page.evaluate(() => {
          try{
            const text = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
            if(text.includes('create account') || text.includes('create my account') || text.includes('verify your email') || text.includes('password requirements')) return true;
            // explicit checks for Workday identifiers
            if(document.querySelector('[data-automation-id*="createAccount"]') || document.querySelector('[data-automation-id*="create-account"]') || document.querySelector('[data-automation-id*="createAccountSubmit"]') ) return true;
            const hasPwd = !!document.querySelector('input[type="password"]');
            const hasEmail = !!Array.from(document.querySelectorAll('input')).find(i => ((i.getAttribute('placeholder')||i.getAttribute('aria-label')||'').toLowerCase().includes('email') || i.type === 'email' || (i.getAttribute('data-automation-id')||'').toLowerCase().includes('email')));
            return hasPwd && hasEmail;
          }catch(_){ return false; }
        });
        if(acctFormNow){
          const email = process.env.WORKDAY_EMAIL || process.env.WORKDAY_USER || null;
          const password = process.env.WORKDAY_PASSWORD || process.env.WORKDAY_PASS || null;
          if(VERBOSE) console.log('Detected create-account after modal; WORKDAY creds present?', !!email, !!password);
          if(email && password){
            if(VERBOSE) console.log('Detected create-account form after modal; attempting account creation (env credentials).');
            const acctRes = await createWorkdayAccount(page, { email, password });
            if(VERBOSE) console.log('createWorkdayAccount after modal result:', acctRes);
            if(acctRes && acctRes.ok && acctRes.clicked){
                await sleep(1200);
                // honor any next-step hints from createWorkdayAccount
                if(acctRes.next === 'verify-email'){
                  if(VERBOSE) console.log('createWorkdayAccount signaled verify-email; will poll for verification for a short timeout');
                  try{ await saveDiagnostics(page, 'verify-email-after-create'); }catch(_){ }
                  // Wait for the user to click the verification link (or for mailbox automation) for up to 3 minutes
                  const verified = await waitForEmailVerification(page, 3 * 60 * 1000, 7000).catch(()=>false);
                  if(verified){
                    if(VERBOSE) console.log('Email verification appeared to complete; attempting sign-in');
                    try{ const signRes = await signInWorkday(page, { email, password }); if(VERBOSE) console.log('signInWorkday after verification result:', signRes); await sleep(1200); }catch(e){ if(VERBOSE) console.log('signInWorkday after verification failed', String(e)); }
                  } else {
                    if(VERBOSE) console.log('Email verification did not complete within timeout; leaving page open for manual verification');
                    applied[url] = { ts: new Date().toISOString(), status: 'verify_email' };
                    saveApplied(applied);
                    leaveOpen = true;
                    continue;
                  }
                }
                if(acctRes.next === 'sign-in'){
                  if(VERBOSE) console.log('createWorkdayAccount signaled sign-in; attempting signInWorkday');
                  try{
                    const signRes = await signInWorkday(page, { email, password });
                    if(VERBOSE) console.log('signInWorkday after create result:', signRes);
                    await sleep(1200);
                  }catch(e){ if(VERBOSE) console.log('signInWorkday after create failed', String(e)); }
                } else {
                  // generic fallback: try sign-in anyway
                  try{ const signRes = await signInWorkday(page, { email, password }); if(VERBOSE) console.log('signInWorkday fallback after create result:', signRes); await sleep(1200); }catch(_){ }
                }
            }
          } else {
            if(VERBOSE) console.log('Create-account form appeared but no WORKDAY_EMAIL/WORKDAY_PASSWORD present; leaving open.');
            try{ await saveDiagnostics(page, 'create-account-no-creds-after-modal'); }catch(_){ }
            applied[url] = { ts: new Date().toISOString(), status: 'needs_account' };
            saveApplied(applied);
            leaveOpen = true;
            continue;
          }
        }
      }catch(e){ if(VERBOSE) console.log('create-account-after-modal detection error', String(e)); }

      // Detect Workday 'Create Account' page and attempt to create an account if credentials are provided via env
      try{
        const createDetected = await page.evaluate(() => {
          try{
            const text = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
            if(text.includes('create account') || text.includes('create my account') || text.includes('password requirements')) return true;
            if(document.querySelector('[data-automation-id*="createAccount"]') || document.querySelector('[data-automation-id*="create-account"]') || document.querySelector('[data-automation-id*="createAccountSubmit"]')) return true;
            const btn = Array.from(document.querySelectorAll('button,input[type=submit],input[type=button]')).find(b => ((b.innerText||b.value||'').toLowerCase().includes('create account') || (b.getAttribute('data-automation-id')||'').toLowerCase().includes('create')));
            if(btn) return true;
            const hasPwd = !!document.querySelector('input[type="password"]');
            const hasEmail = !!Array.from(document.querySelectorAll('input')).find(i => ((i.getAttribute('placeholder')||i.getAttribute('aria-label')||'').toLowerCase().includes('email') || i.type === 'email' || (i.getAttribute('data-automation-id')||'').toLowerCase().includes('email')));
            if(hasPwd && hasEmail) return true;
            return false;
          }catch(_){ return false; }
        });
        if(createDetected){
          const email = process.env.WORKDAY_EMAIL || process.env.WORKDAY_USER || null;
          const password = process.env.WORKDAY_PASSWORD || process.env.WORKDAY_PASS || null;
          if(VERBOSE) console.log('Detected create-account page; WORKDAY creds present?', !!email, !!password);
          if(email && password){
            if(VERBOSE) console.log('Detected create-account page; attempting account creation (using env credentials).');
            const acctRes = await createWorkdayAccount(page, { email, password });
            if(VERBOSE) console.log('createWorkdayAccount result:', { ok: !!acctRes && !!acctRes.ok, clicked: !!acctRes && !!acctRes.clicked, reason: acctRes && acctRes.reason ? acctRes.reason : undefined, error: acctRes && acctRes.error ? 'yes' : undefined });
            await sleep(1200);
            // if account creation clicked a button, give the flow a chance to progress
            if(acctRes){
              if(acctRes.next === 'verify-email'){
                if(VERBOSE) console.log('createWorkdayAccount signaled verify-email (page flow); saving diagnostics and leaving open');
                try{ await saveDiagnostics(page, 'verify-email'); }catch(_){ }
                applied[url] = { ts: new Date().toISOString(), status: 'verify_email' };
                saveApplied(applied);
                leaveOpen = true;
                continue;
              }
              if(acctRes.next === 'sign-in'){
                if(VERBOSE) console.log('createWorkdayAccount signaled sign-in (page flow); attempting signInWorkday');
                try{ const signRes2 = await signInWorkday(page, { email, password }); if(VERBOSE) console.log('signInWorkday after create (page flow) result:', signRes2); await sleep(1200); }catch(_){ if(VERBOSE) console.log('signInWorkday failed after create (page flow)'); }
              } else if(acctRes.ok && acctRes.clicked){
                // generic fallback: try sign-in after a click
                await sleep(1500);
                try{ const signRes2 = await signInWorkday(page, { email, password }); if(VERBOSE) console.log('signInWorkday after create (page flow) result:', signRes2); await sleep(1200); }catch(_){ }
              }
            }
          } else {
            if(VERBOSE) console.log('Create-account detected but no WORKDAY_EMAIL/WORKDAY_PASSWORD env vars; leaving open for manual creation.');
            try{ await saveDiagnostics(page, 'create-account-no-creds'); }catch(_){ }
            applied[url] = { ts: new Date().toISOString(), status: 'needs_account' };
            saveApplied(applied);
            leaveOpen = true;
            continue;
          }
        }
      }catch(e){ if(VERBOSE) console.log('workday create-account detection error', String(e)); }

      // Detect sign-in / account requirement before proceeding (common on Workday/iCIMS etc.)
      try{
        const needsLogin = await page.evaluate(() => {
          const u = location.href.toLowerCase();
          if (u.includes('login') || u.includes('signin') || u.includes('log-in')) return true;
          if (document.querySelector('input[type="password"], form[action*="/account"], form[action*="/login"]')) return true;
          const body = (document.body?.innerText || '').toLowerCase();
          if (/sign in to|please sign in|sign in required|create account to apply/.test(body)) return true;
          return false;
        });
        if(needsLogin){
          console.log('Login required on this page; leaving tab open for manual sign-in.');
          await saveDiagnostics(page, 'login_required');
            // try to auto-sign-in if we have credentials
            const email = process.env.WORKDAY_EMAIL || process.env.WORKDAY_USER || null;
            const password = process.env.WORKDAY_PASSWORD || process.env.WORKDAY_PASS || null;
            if(email && password){
              if(VERBOSE) console.log('Attempting to auto-sign-in using WORKDAY_EMAIL via signInWorkday');
              try{
                const signRes = await signInWorkday(page, { email, password });
                if(VERBOSE) console.log('signInWorkday result:', signRes);
                // give a moment for navigation after sign-in
                await sleep(1200);
                // re-evaluate whether still needs login
                const stillNeeds = await page.evaluate(() => {
                  const body = (document.body?.innerText || '').toLowerCase();
                  return (/sign in to|please sign in|sign in required|create account to apply/.test(body));
                });
                if(stillNeeds){ console.log('Auto sign-in did not advance; leaving tab open for manual sign-in.'); leaveOpen = true; applied[url] = { ts: new Date().toISOString(), status: "login_required" }; saveApplied(applied); continue; }
                // otherwise continue the apply flow
              }catch(e){ if(VERBOSE) console.log('signInWorkday failed', String(e)); leaveOpen = true; applied[url] = { ts: new Date().toISOString(), status: "login_required" }; saveApplied(applied); continue; }
            } else {
              applied[url] = { ts: new Date().toISOString(), status: "login_required" };
              saveApplied(applied);
              leaveOpen = true;
              continue;
            }
        }
      }catch(_){/* non-fatal */}

      // detect obvious CAPTCHA
      const hasCaptcha = await page.$("iframe[src*='recaptcha'], div.g-recaptcha, div#captcha, input[name='captcha']");
      if(hasCaptcha){
        console.log("CAPTCHA detected; skipping and marking for manual.");
    await saveDiagnostics(page, 'captcha');
    applied[url] = { ts: new Date().toISOString(), status: "captcha" };
    saveApplied(applied);
        await page.close();
        continue;
      }

      // try to read some JD text from the page
      let jdText = "";
      try{
        jdText = await page.evaluate(() => {
          const prefer = document.querySelector("[data-testid*='job'],[data-qa*='job'],article,main,section");
          const node = prefer || document.body;
          return node?.innerText?.slice(0, 1500) || "";
        });
      }catch(_){}

      const company = parseCompanyFromUrl(url);
      const role = /intern/i.test(snippet) ? "software engineering internship" : "internship";

      const { text: whyTxt } = await draftWhyCompany({ company, role, jd: jdText, profile });

      // try to fill
      const filled = await fillCustomQuestions(page, { company, role, profile, answerWhyCompany: whyTxt });
      if(filled.filled){
        console.log("Filled a 'Why us' style field.");
      } else {
        console.log("No custom question field found.");
      }

    const submitted = await waitForSubmission(page, 180_000);

    applied[url] = {
      ts: new Date().toISOString(),
      status: submitted ? "submitted" : "attempted",
      answer: filled.filled ? "why-company" : "none"
    };
  if(!submitted){ await saveDiagnostics(page, 'no-submit'); }
  saveApplied(applied);
    done++;

    // Only close the tab if we detected a successful submit; otherwise leave it open for you to finish.
    if (submitted) {
      await page.close().catch(() => {});
    }

    } catch (err){
      console.error("Error on", url, err.message);
      applied[url] = { ts: new Date().toISOString(), status: "error", error: String(err) };
      saveApplied(applied);
    } finally {
      // don't close the page if we intentionally left it open for manual work
      if (!leaveOpen) {
        await page?.close()?.catch(()=>{});
      }
      // polite pacing
      await sleep(3000 + Math.random()*2000);
    }
  }

  console.log(`\nRun finished. Opened ${done} pages.`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
