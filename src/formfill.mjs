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
