import { setTimeout as sleep } from "node:timers/promises";

// Heuristics to find and fill 'Why us' style questions
export async function fillCustomQuestions(page, {company, role, profile, answerWhyCompany}){
  // Wait a bit for dynamic forms
  await wait(2500);
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
      target.value = text;
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
  while(Date.now() < deadline){
    try{
      // common Workday continue buttons: text like 'Continue', 'Next', 'Save and Continue'
      const clicked = await page.evaluate(() => {
        try{
          const keywords = [/^continue$/i, /\bnext\b/i, /save and continue/i, /continue to profile/i];
          const candidates = Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit]'));
          for(const el of candidates){
            try{
              const txt = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
              if(!txt) continue;
              if(keywords.some(re => re.test(txt))){
                // ensure visible
                const r = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                if(!(r.width && r.height) || style.display === 'none' || style.visibility === 'hidden') continue;
                el.scrollIntoView({ block: 'center' });
                try{ el.click(); return { ok:true, method: 'dom' }; }catch(_){
                  try{ const ev = { bubbles:true, cancelable:true, composed:true }; el.dispatchEvent(new PointerEvent('pointerdown', ev)); el.dispatchEvent(new PointerEvent('pointerup', ev)); el.dispatchEvent(new MouseEvent('click', ev)); return { ok:true, method: 'dispatch' }; }catch(_){ return { ok:false }; }
                }
              }
            }catch(_){ }
          }
        }catch(_){ }
        return { ok:false };
      }).catch(()=>({ ok:false }));
      if(clicked && clicked.ok) return true;

      // fallback: click by center coords for any element that looks like a primary primary action
      const primary = await page.evaluate(() => {
        try{
          const nodes = Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit]'));
          // prefer elements with class names suggesting primary action
          const pri = nodes.find(n => /(primary|wd-primary|continue|next)/i.test(n.className || '') || /(primary|continue|next)/i.test(n.id || ''));
          if(pri){ const r = pri.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; }
          return null;
        }catch(_){ return null; }
      }).catch(()=>null);
      if(primary && typeof primary.x === 'number'){
        try{ await page.mouse.move(primary.x, primary.y, { steps: 6 }); await sleep(60); await page.mouse.down(); await sleep(30); await page.mouse.up(); return true; }catch(_){ }
      }
    }catch(_){ }
    await sleep(400);
  }
  return false;
}
