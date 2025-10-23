import { setTimeout as sleep } from "node:timers/promises";

// Heuristics to find and fill 'Why us' style questions
export async function fillCustomQuestions(page, {company, role, profile, answerWhyCompany}){
  // Wait a bit for dynamic forms
  await sleep(2500);
  const fields = await page.$$eval("textarea, input[type='text'], div[contenteditable='true']", nodes => {
    function labelFor(el){
      // try aria-label / placeholder / nearby label
      const aria = el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
      let label = aria;
      // find <label for=id>
      const id = el.getAttribute("id");
      if(id){
        const lab = document.querySelector(`label[for='${id}']`);
        if(lab) label += " " + lab.innerText;
      }
      // search parent text
      const parentText = el.closest("div,fieldset,section")?.innerText?.slice(0,220) || "";
      return (label + " " + parentText).toLowerCase();
    }
    return nodes.map(n => ({ tag: n.tagName, label: labelFor(n) }));
  });

  const whyIdx = fields.findIndex(f => /(what excites|why.*(us|company|join)|interest.*company|why.*role)/i.test(f.label || ""));
  if(whyIdx === -1) return { filled: false, reason: "no-field" };

  const text = answerWhyCompany;
  // fill the first matching field
  await page.evaluate((text) => {
    const candidates = Array.from(document.querySelectorAll("textarea, input[type='text'], div[contenteditable='true']"));
    function getLabel(el){
      const aria = el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
      let label = aria;
      const id = el.getAttribute("id");
      if(id){
        const lab = document.querySelector(`label[for='${id}']`);
        if(lab) label += " " + lab.innerText;
      }
      const parentText = el.closest("div,fieldset,section")?.innerText?.slice(0,220) || "";
      return (label + " " + parentText).toLowerCase();
    }
    const target = candidates.find(n => /(what excites|why.*(us|company|join)|interest.*company|why.*role)/i.test(getLabel(n)));
    if(!target) return false;
    if(target.tagName === "DIV" && target.getAttribute("contenteditable")==="true"){
      target.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
    }else{
      target.focus();
      // try React-friendly native setter
      try{
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if(setter) setter.call(target, text); else target.value = text;
      }catch(e){ target.value = text; }
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  }, text);

  return { filled: true };
}

// Try to find and click a visible 'Continue' or 'Next' button on Workday pages
export async function clickWorkdayContinue(page, timeout = 8000){
  const deadline = Date.now() + timeout;
  const inPageClicker = () => {
    try{
      const keywords = [/^continue$/i, /\bnext\b/i, /save and continue/i, /continue to profile/i, /continue to application/i];
      const candidates = Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit], [role="button"]'));
      for(const el of candidates){
        try{
          const txt = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
          if(!txt) continue;
          if(keywords.some(re => re.test(txt))){
            const r = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if(!(r.width && r.height) || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
            el.scrollIntoView({ block: 'center' });
            try{ el.click(); return true; }catch(_){ try{ const ev = { bubbles:true, cancelable:true, composed:true }; el.dispatchEvent(new PointerEvent('pointerdown', ev)); el.dispatchEvent(new PointerEvent('pointerup', ev)); el.dispatchEvent(new MouseEvent('click', ev)); return true; }catch(_){ /* ignore */ } }
          }
        }catch(_){ }
      }
    }catch(_){ }
    return false;
  };

  while(Date.now() < deadline){
    try{
      // 1) try top-level document
      const clickedTop = await page.evaluate(inPageClicker).catch(()=>false);
      if(clickedTop) return true;

      // 2) try all frames (some Workday tenants render the CTA inside frames)
      const frames = page.frames();
      for(const f of frames){
        try{
          const r = await f.evaluate(inPageClicker).catch(()=>false);
          if(r) return true;
        }catch(_){ /* cross-origin frames */ }
      }

      // 3) fallback: find candidate element and click by coordinates
      const coords = await page.evaluate(() => {
        try{
          const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], input[type=button], input[type=submit]'));
          const pri = nodes.find(n => /(primary|wd-primary|continue|next|submit)/i.test(n.className || '') || /(primary|continue|next|submit)/i.test(n.id || '') || /(continue|next|save and continue)/i.test((n.innerText||n.value||'').toLowerCase()));
          if(pri){ const r = pri.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; }
        }catch(_){ }
        return null;
      }).catch(()=>null);
      if(coords && typeof coords.x === 'number'){
        try{ await page.mouse.move(coords.x, coords.y, { steps: 6 }); await sleep(60); await page.mouse.down(); await sleep(30); await page.mouse.up(); return true; }catch(_){ }
      }
    }catch(_){ }
    await sleep(400);
  }
  return false;
}

// Minimal implementation to create a Workday account: set email/password and click create
export async function createWorkdayAccount(page, { email, password } = {}){
  try{
    await page.evaluate(() => { window.__workday_debug = window.__workday_debug || {}; window.__workday_debug.createAttempt = (window.__workday_debug.createAttempt||0) + 1; }).catch(()=>{});

    let didClick = false;
    let wroteEmail = false;
    let wrotePassword = false;
    let wroteVerify = false;
    let didCheck = false;

    const frames = page.frames();
    for(const f of frames){
      try{
        // set email (best-effort) - include data-automation-id and text inputs
        const rEmail = await f.evaluate((em) => {
          try{
            const sel = 'input[data-automation-id="email" i], input[type=email], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i], input[type=text][autocomplete="email"], input[type=text]';
            const el = document.querySelector(sel) || null;
            if(!el) return false;
            const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if(s) s.call(el, em); else el.value = em;
            el.focus(); el.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
            return true;
          }catch(_){ return false; }
        }, email).catch(()=>false);
        wroteEmail = wroteEmail || Boolean(rEmail);

        // set primary password
        const rPwd = await f.evaluate((pw) => {
          try{
            const el = document.querySelector('input[type=password]') || Array.from(document.querySelectorAll('input')).find(i => ((i.placeholder||'')+ (i.name||'') + (i.id||'')).toLowerCase().includes('password')) || null;
            if(!el) return false;
            const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if(s) s.call(el, pw); else el.value = pw;
            el.focus(); el.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
            return true;
          }catch(_){ return false; }
        }, password).catch(()=>false);
        wrotePassword = wrotePassword || Boolean(rPwd);

        // set verify/confirm (try second password field or named confirm)
        const rVerify = await f.evaluate((pw) => {
          try{
            const pwInputs = Array.from(document.querySelectorAll('input[type=password]'));
            if(pwInputs.length > 1){ const second = pwInputs[1]; const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set; if(s) s.call(second, pw); else second.value = pw; second.focus(); second.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true})); second.dispatchEvent(new Event('change',{bubbles:true})); return true; }
            const el = Array.from(document.querySelectorAll('input')).find(i => /confirm|verify/.test((i.name||'') + (i.id||'') + (i.placeholder||'')));
            if(el){ const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set; if(s) s.call(el, pw); else el.value = pw; el.focus(); el.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; }
            return false;
          }catch(_){ return false; }
        }, password).catch(()=>false);
        wroteVerify = wroteVerify || Boolean(rVerify);

        // try checkbox inputs with nearby label text (robust, with small retry)
        let rCheck = false;
        for(let attempt=0; attempt<3 && !rCheck; attempt++){
          rCheck = await f.evaluate(() => {
            try{
              const cands = Array.from(document.querySelectorAll('input[type=checkbox]'));
              for(const cb of cands){
                try{
                  const txt = ((cb.getAttribute('aria-label')||'') + ' ' + (cb.name||'') + ' ' + (cb.id||'') + ' ' + (cb.closest('label')?.innerText||'') + ' ' + (cb.closest('div,fieldset,form')?.innerText||'')).toLowerCase();
                  if(/terms|consent|agree|accept|privacy|conditions/.test(txt)){
                    if(!cb.checked){
                      try{ cb.click(); }catch(e){ try{ cb.checked = true; cb.dispatchEvent(new Event('change',{bubbles:true})); }catch(_){} }
                    }
                    return Boolean(cb.checked);
                  }
                }catch(_){ }
              }
            }catch(_){ }
            return false;
          }).catch(()=>false);
          if(!rCheck) await sleep(300);
        }
        didCheck = didCheck || Boolean(rCheck);

        // fallback: role-based toggles (aria-checked or role=checkbox)
        if(!didCheck){
          const rRole = await f.evaluate(() => {
            try{
              const role = Array.from(document.querySelectorAll('[role=checkbox],[aria-checked]')).find(rb => {
                try{ const t = (rb.getAttribute('aria-label')||rb.innerText||'').toLowerCase(); return /terms|consent|agree|accept|privacy|conditions/.test(t); }catch(_){ return false; }
              });
              if(role){ try{ role.click(); return true; }catch(e){ try{ role.setAttribute('aria-checked','true'); role.dispatchEvent(new Event('change',{bubbles:true})); return true; }catch(_){ } } }
            }catch(_){ }
            return false;
          }).catch(()=>false);
          didCheck = didCheck || Boolean(rRole);
        }

        // final fallback: click 'I agree' style buttons
        if(!didCheck){
          let rAgree = false;
          for(let attempt=0; attempt<2 && !rAgree; attempt++){
            rAgree = await f.evaluate(() => {
              try{
                const nodes = Array.from(document.querySelectorAll('button,a,input[type=button],input[type=submit]'));
                const btn = nodes.find(b => {
                  try{ const t = ((b.innerText||'') + ' ' + (b.getAttribute('data-automation-id')||'')).toLowerCase(); return /\bi agree\b|accept|agree and continue|accept terms|i have read and agree|agree to the terms/.test(t); }catch(_){ return false; }
                });
                if(btn){ try{ btn.click(); return true; }catch(e){ try{ btn.dispatchEvent(new MouseEvent('click',{bubbles:true})); return true; }catch(_){ } } }
              }catch(_){ }
              return false;
            }).catch(()=>false);
            if(!rAgree) await sleep(250);
          }
          didCheck = didCheck || Boolean(rAgree);
        }

        // try clicking Create/Register (robust: overlay click_filter, data-automation-id, role buttons)
        let rBtn = false;
        try{
          rBtn = await f.evaluate(() => {
            try{
              const sel = 'button,input[type=button],input[type=submit],[role="button"],[data-automation-id]';
              const nodes = Array.from(document.querySelectorAll(sel));
              const prioritize = nodes.find(b => {
                try{
                  const t = ((b.innerText||b.value||'') + ' ' + (b.getAttribute('aria-label')||'') + ' ' + (b.getAttribute('data-automation-id')||'') + ' ' + (b.id||'')).toLowerCase();
                  if(/create account|create my account|register|create my|create account/.test(t)) return true;
                  if((b.getAttribute('data-automation-id')||'').toLowerCase().includes('click_filter')) return true;
                  if((b.getAttribute('data-automation-id')||'').toLowerCase().includes('createaccount') || (b.getAttribute('data-automation-id')||'').toLowerCase().includes('create')) return true;
                  if((b.id||'').toLowerCase().includes('create')) return true;
                }catch(_){ }
                return false;
              });
              const target = prioritize || nodes.find(n => /create|register/.test((n.innerText||n.value||n.id||'').toLowerCase()));
              if(target){
                try{ target.click(); return true; }catch(e){
                  try{ target.dispatchEvent(new MouseEvent('click',{bubbles:true})); return true; }catch(_){
                    try{ target.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); target.dispatchEvent(new PointerEvent('pointerup',{bubbles:true})); target.dispatchEvent(new MouseEvent('click',{bubbles:true})); return true; }catch(__){ return false; }
                  }
                }
              }
            }catch(_){ }
            return false;
          }).catch(()=>false);
        }catch(_){ rBtn = false; }

        // if DOM click didn't work but there's a visible candidate, try coordinate click as a last resort
        if(!rBtn){
          try{
            // First, attempt a top-level click on the click_filter overlay (often used by Workday)
            try{ const topClicked = await page.evaluate(() => {
                try{
                  const cf = document.querySelector('[data-automation-id="click_filter"], [data-automation-id="click-filter"]');
                  if(cf){ try{ cf.click(); return true; }catch(_){ try{ cf.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); cf.dispatchEvent(new PointerEvent('pointerup',{bubbles:true})); cf.dispatchEvent(new MouseEvent('click',{bubbles:true})); return true; }catch(__){} } }
                }catch(_){ }
                return false;
              }).catch(()=>false);
              if(topClicked){ rBtn = true; }
            }catch(_){ }
            if(!rBtn){
              const coords = await f.evaluate(() => {
              try{
                const nodes = Array.from(document.querySelectorAll('button,input[type=button],input[type=submit],[role="button"],[data-automation-id]'));
                const cand = nodes.find(b => { try{ const t = ((b.innerText||b.value||'') + ' ' + (b.getAttribute('data-automation-id')||'')).toLowerCase(); return /create account|create my account|register|create my|create account/.test(t) || (b.getAttribute('data-automation-id')||'').toLowerCase().includes('click_filter') || (b.id||'').toLowerCase().includes('create'); }catch(_){ return false; } });
                if(!cand) return null;
                const r = cand.getBoundingClientRect(); if(!(r.width&&r.height)) return null; return { x: r.left + r.width/2, y: r.top + r.height/2 };
              }catch(_){ return null; }
            }).catch(()=>null);
            if(coords && typeof coords.x === 'number'){
              await page.mouse.move(coords.x, coords.y, { steps: 6 }); await sleep(60); await page.mouse.down(); await sleep(30); await page.mouse.up(); rBtn = true;
            }
            }
          }catch(_){ }
        }
        didClick = didClick || Boolean(rBtn);

        if(rEmail || rPwd || rVerify || rBtn) await sleep(600);
      }catch(_){ }
    }

    // If no create/register click was detected inside frames, try top-level document
    if(!didClick){
      try{
        const topClicked = await page.evaluate(() => {
          try{
            const sel = '[data-automation-id="createAccountSubmitButton"], [data-automation-id="click_filter"], button, input[type=button], input[type=submit], [role="button"]';
            const nodes = Array.from(document.querySelectorAll(sel));
            // Prefer explicit automation id or clearly labelled button
            const candidate = nodes.find(n => {
              try{
                const t = ((n.innerText||n.value||'') + ' ' + (n.getAttribute && n.getAttribute('data-automation-id')||'') + ' ' + (n.id||'')).toLowerCase();
                if((n.getAttribute && (n.getAttribute('data-automation-id')||'').toLowerCase().includes('create')) || /create account|create my account|register|create my|create account/.test(t)) return true;
                if((n.getAttribute && (n.getAttribute('data-automation-id')||'').toLowerCase().includes('click_filter'))) return true;
              }catch(_){ }
              return false;
            }) || nodes.find(n => /create|register/.test((n.innerText||n.value||n.id||'').toLowerCase()));
            if(candidate){
              try{ candidate.scrollIntoView({block:'center'}); }catch(_){ }
              try{ candidate.click(); return true; }catch(e){ try{ candidate.dispatchEvent(new MouseEvent('click',{bubbles:true})); return true; }catch(_){ return false; } }
            }
          }catch(_){ }
          return false;
        }).catch(()=>false);
        if(topClicked) didClick = true;
      }catch(_){ }
    }

    // If still not clicked, try coordinate click on top-level visible candidate
    if(!didClick){
      try{
        const coords = await page.evaluate(() => {
          try{
            const nodes = Array.from(document.querySelectorAll('[data-automation-id="createAccountSubmitButton"], [data-automation-id="click_filter"], button, input[type=button], input[type=submit], [role="button"]'));
            const cand = nodes.find(n => { try{ const t = ((n.innerText||n.value||'') + ' ' + (n.getAttribute && n.getAttribute('data-automation-id')||'') + ' ' + (n.id||'')).toLowerCase(); return /create account|create my account|register|create my|create account/.test(t) || (n.getAttribute && (n.getAttribute('data-automation-id')||'').toLowerCase().includes('click_filter')) || (n.id||'').toLowerCase().includes('create'); }catch(_){ return false; } });
            if(!cand) return null;
            const r = cand.getBoundingClientRect(); if(!(r.width && r.height)) return null; return { x: r.left + r.width/2, y: r.top + r.height/2 };
          }catch(_){ return null; }
        }).catch(()=>null);
        if(coords && typeof coords.x === 'number'){
          try{ await page.mouse.move(coords.x, coords.y, { steps: 6 }); await sleep(60); await page.mouse.down(); await sleep(30); await page.mouse.up(); didClick = true; }catch(_){ }
        }
      }catch(_){ }
    }

    // record debug info
    await page.evaluate((we,wp,wv,wc) => { window.__workday_debug = window.__workday_debug || {}; window.__workday_debug.createWrote = { email: we, password: wp, verify: wv, checked: wc }; }, wroteEmail, wrotePassword, wroteVerify, didCheck).catch(()=>{});

    const body = await page.evaluate(() => (document.body?.innerText || '').toLowerCase()).catch(()=>'');
    if(/verify your email|check your email|verify/i.test(body)) return { ok:true, clicked: didClick, next: 'verify-email', verified: wroteVerify, checked: didCheck };
    if(/sign in|sign-in|log in|login/.test(body) || (await page.evaluate(() => !!document.querySelector('input[type="password"]')))) return { ok:true, clicked: didClick, next: 'sign-in', verified: wroteVerify, checked: didCheck };
    return { ok: true, clicked: didClick, verified: wroteVerify, checked: didCheck };
  }catch(e){ return { ok:false, error: String(e) }; }
}

// Ensure the 'terms / I agree' checkbox (or equivalent) is selected.
// Tries top-level document and all same-origin frames, waits up to `timeout` ms for confirmation.
export async function ensureWorkdayCheckboxChecked(page, timeout = 3000){
  const deadline = Date.now() + timeout;
  const tryOnce = async (f) => {
    try{
      // prefer explicit checkbox inputs and their labels
      const ok = await f.evaluate(() => {
        try{
          // Tenant-specific quick path: Allegion Workday create-account checkbox
          try{
            const specific = document.querySelector('input[data-automation-id="createAccountCheckbox"], input#input-8');
            if(specific){
              // 1) try simple click
              try{ specific.click(); }catch(e){}
              // 2) force state + events
              try{ if(!specific.checked){ specific.checked = true; specific.dispatchEvent(new Event('input',{bubbles:true})); specific.dispatchEvent(new Event('change',{bubbles:true})); } }catch(_){ }
              // 3) click nearby visual wrapper if present (styled span/div used as checkbox UI)
              try{
                const wrap = specific.closest('div')?.querySelector('.css-15ws53q, .css-1ikf28c, span, div');
                if(wrap){ try{ wrap.click(); }catch(_){ try{ const r = wrap.getBoundingClientRect(); const ev = new MouseEvent('click',{bubbles:true}); wrap.dispatchEvent(ev); }catch(_){} } }
              }catch(_){ }
              // 4) final verification
              return Boolean(specific.checked || (specific.getAttribute && specific.getAttribute('aria-checked') === 'true'));
            }
            // label-based fallback for the same tenant (exact text match observed in diagnostics)
            const lab = Array.from(document.querySelectorAll('label')).find(l => /yes,? i have read and consent to the terms and conditions/i.test((l.innerText||'')));
            if(lab){
              try{ lab.click(); }catch(_){ try{ const target = document.getElementById(lab.htmlFor); if(target) { try{ target.click(); target.checked = true; target.dispatchEvent(new Event('change',{bubbles:true})); }catch(_){} } }catch(_){} }
              const t = lab.htmlFor ? document.getElementById(lab.htmlFor) : lab.querySelector('input[type=checkbox]');
              if(t) return Boolean(t.checked || (t.getAttribute && t.getAttribute('aria-checked') === 'true'));
            }
          }catch(_){ }
          const rx = /terms|consent|agree|accept|privacy|conditions/i;
          // 1) check visible checkbox inputs
          const cbs = Array.from(document.querySelectorAll('input[type=checkbox]'));
          for(const cb of cbs){
            try{
              const txt = ((cb.getAttribute('aria-label')||'') + ' ' + (cb.name||'') + ' ' + (cb.id||'') + ' ' + (cb.closest('label')?.innerText||'') + ' ' + (cb.closest('div,fieldset,form')?.innerText||'')).toLowerCase();
              if(rx.test(txt)){
                if(!cb.checked){ try{ cb.click(); }catch(e){ try{ cb.checked = true; cb.dispatchEvent(new Event('change',{bubbles:true})); }catch(_){} } }
                return Boolean(cb.checked);
              }
            }catch(_){ }
          }

          // 2) click <label> elements whose text matches and which reference a checkbox via 'for'
          const labs = Array.from(document.querySelectorAll('label'));
          for(const lab of labs){
            try{
              const t = (lab.innerText||'').toLowerCase();
              if(rx.test(t)){
                if(lab.htmlFor){ const target = document.getElementById(lab.htmlFor); if(target && target.type === 'checkbox'){ try{ lab.click(); }catch(e){ try{ target.click(); }catch(_){ } } return Boolean(target.checked); } }
                try{ lab.click(); }catch(_){ }
              }
            }catch(_){ }
          }

          // 3) role/aria toggles
          const roles = Array.from(document.querySelectorAll('[role=checkbox],[aria-checked]'));
          for(const r of roles){
            try{
              const t = ((r.getAttribute('aria-label')||r.innerText||'') + '').toLowerCase();
              if(rx.test(t)){
                try{ r.click(); }catch(e){ try{ r.setAttribute('aria-checked','true'); r.dispatchEvent(new Event('change',{bubbles:true})); }catch(_){} }
                const ac = r.getAttribute('aria-checked');
                if(ac === 'true' || ac === 'checked') return true;
              }
            }catch(_){ }
          }

          // 4) 'I agree' / Accept style buttons
          const nodes = Array.from(document.querySelectorAll('button,a,input[type=button],input[type=submit]'));
          const agree = nodes.find(b => { try{ const t = ((b.innerText||'') + ' ' + (b.getAttribute('data-automation-id')||'')).toLowerCase(); return /\bi agree\b|accept|agree and continue|accept terms|i have read and agree|agree to the terms/.test(t); }catch(_){ return false; } });
          if(agree){ try{ agree.click(); return true; }catch(_){ try{ agree.dispatchEvent(new MouseEvent('click',{bubbles:true})); return true; }catch(_){ } } }

          return false;
        }catch(_){ return false; }
      }).catch(()=>false);
      return Boolean(ok);
    }catch(_){ return false; }
  };

  // try top-level and each frame repeatedly until timeout
  while(Date.now() < deadline){
    try{
      // top-level
      const topOk = await tryOnce(page).catch(()=>false);
      if(topOk) return true;
      // frames
      const frames = page.frames();
      for(const f of frames){
        try{ const fOk = await tryOnce(f).catch(()=>false); if(fOk) return true; }catch(_){ }
      }
    }catch(_){ }
    await sleep(250);
  }
  return false;
}

// Minimal sign-in helper: set email/password and click sign-in
export async function signInWorkday(page, { email, password } = {}){
  try{
    await page.evaluate(() => { window.__workday_debug = window.__workday_debug || {}; window.__workday_debug.signInAttempt = (window.__workday_debug.signInAttempt||0) + 1; }).catch(()=>{});
    let clicked = false;
    let wroteEmail = false;
    let wrotePassword = false;
    const frames = page.frames();
    for(const f of frames){
      try{
        const res = await f.evaluate((em, pw) => {
          try {
            const out = {};
            function findInputByLabel(keyword){
              const labels = Array.from(document.querySelectorAll('label'));
              for(const lab of labels){
                try{ if((lab.innerText||'').toLowerCase().includes(keyword)){ if(lab.control) return lab.control; const inp = lab.querySelector('input'); if(inp) return inp; } }catch(_){ }
              }
              const inputs = Array.from(document.querySelectorAll('input'));
              for(const i of inputs){
                try{ const attrs = ((i.placeholder||'')+' '+(i.name||'')+' '+(i.id||'')).toLowerCase(); if(attrs.includes(keyword)) return i; }catch(_){ }
              }
              return null;
            }
            const emailEl = findInputByLabel('email') || Array.from(document.querySelectorAll('input')).find(i=>i.type==='email');
            if(emailEl && em){
              const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set;
              if(s) s.call(emailEl, em); else emailEl.value = em;
              emailEl.focus();
              emailEl.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true}));
              emailEl.dispatchEvent(new Event('change',{bubbles:true}));
              out.email = true;
            }
            const pwdEl = findInputByLabel('password') || Array.from(document.querySelectorAll('input[type="password"]'))[0];
            if(pwdEl && pw){
              const s2 = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set;
              if(s2) s2.call(pwdEl,pw); else pwdEl.value = pw;
              pwdEl.focus();
              pwdEl.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true}));
              pwdEl.dispatchEvent(new Event('change',{bubbles:true}));
              out.password = true;
            }
            const btn = Array.from(document.querySelectorAll('button,input[type=button],input[type=submit]')).find(b => {
              try{ const t = (b.innerText||b.value||'').toLowerCase(); return /sign in|sign-in|sign in|log in|login/.test(t) || (b.getAttribute('data-automation-id')||'').toLowerCase().includes('signin'); }catch(_){ return false; }
            });
            if(btn){
              try{ btn.click(); out.clicked = true; }
              catch(e){
                try{ btn.dispatchEvent(new MouseEvent('click',{bubbles:true})); out.clicked = true; }
                catch(_){ out.clicked = false; }
              }
            }
            return out;
          } catch(e) {
            return { err: String(e) };
          }
        }, email, password).catch(()=>({}));
        if(res.email) wroteEmail = true;
        if(res.password) wrotePassword = true;
        if(res.clicked) clicked = true;
        await f.evaluate((d) => { window.__workday_debug = window.__workday_debug || {}; window.__workday_debug.lastSignIn = d; }, res).catch(()=>{});
        if(wroteEmail || wrotePassword || clicked) await sleep(700);
      }catch(_){ }
    }
    await page.evaluate((we, wp) => { window.__workday_debug = window.__workday_debug || {}; window.__workday_debug.signInWrote = { email: we, password: wp }; }, wroteEmail, wrotePassword).catch(()=>{});
    return { ok: true, clicked };
  }catch(e){ return { ok:false, error: String(e) }; }
}

// Poll the page for evidence of email verification
export async function waitForEmailVerification(page, ms = 180_000, poll = 5000){
  const deadline = Date.now() + ms;
  while(Date.now() < deadline){
    try{
      const body = await page.evaluate(() => (document.body?.innerText || '').toLowerCase()).catch(()=>'');
      if(/email verified|verification complete|account verified|thank you for verifying/i.test(body)) return true;
      // also detect a 'continue' or 'sign in' button as a signal
      const hasContinue = await page.evaluate(() => {
        try{ return Array.from(document.querySelectorAll('button,input[type=button],input[type=submit]')).some(b => (/continue|sign in|log in|proceed/).test((b.innerText||b.value||'').toLowerCase())); }catch(_){ return false; }
      }).catch(()=>false);
      if(hasContinue) return true;
    }catch(_){ }
    await sleep(poll);
  }
  return false;
}

// Wait for signs of an autofill/upload completing (Speedy Apply) then attempt to advance
export async function advanceAfterAutofill(page, timeout = 8000){
  const deadline = Date.now() + timeout;
  // wait for common markers: 'successfully uploaded', file extension shown, or 'page completed' UI
  while(Date.now() < deadline){
    try{
      const marker = await page.evaluate(() => {
        try{
          const t = (document.body?.innerText || '').toLowerCase();
          if(t.includes('successfully uploaded') || t.includes('page completed') || t.includes('uploaded')) return true;
          const bad = Array.from(document.querySelectorAll('*')).map(n => (n.innerText || '').toLowerCase()).find(s => /\.pdf|\.docx?|\.txt|successfully uploaded|successfully uploaded!/i.test(s));
          if(bad) return true;
        }catch(_){ }
        return false;
      }).catch(()=>false);
      if(marker) break;
    }catch(_){ }
    await sleep(350);
  }

  // attempt to click Continue a few times
  for(let i=0;i<3;i++){
    try{
      const ok = await clickWorkdayContinue(page, 3000);
      if(ok) return true;
    }catch(_){ }
    await sleep(400);
  }
  return false;
}
