import { OPENAI_API_KEY } from "./config.mjs";

function templateAnswer({company, role, jd, profile}){
  const proj = (profile.projects?.[0]?.summary || "").split(".")[0];
  const skill1 = (profile.skills?.programming_languages?.[0] || "Python");
  const skill2 = (profile.skills?.technologies?.find(s=>/react|next|asp\.net|postgres/i.test(s)) || "React");
  const claim = (profile.experience?.[0]?.highlights?.find(h=>/\d/.test(h)) || "").replace(/^[-•\s]+/, "");
  const whyThem = (jd||"").slice(0,180).replace(/\s+/g," ").trim();

  return [
    `I’m excited about ${company} because ${whyThem || "your focus on building practical systems that matter to users."}`,
    `This ${role||"intern"} role aligns with my experience in ${skill1} and ${skill2}, where I’ve built production features and improved performance.`,
    claim ? `For example, ${claim}` : ``,
    `In my first months, I’d aim to contribute to ${company} by shipping small, high-quality changes quickly and deepening my understanding of your stack.`
  ].filter(Boolean).join(" ");
}

export async function draftWhyCompany({company, role, jd, profile}){
  const base = templateAnswer({company, role, jd, profile});
  if(!OPENAI_API_KEY) return { text: base, source: "template" };

  // Optional polishing (no new facts) — short and grounded
  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You rewrite answers for internship applications. Keep ALL facts from user text. Do NOT invent new claims or numbers. 140-180 words, plain language, specific and calm tone."},
      { role: "user", content: `Company: ${company}\nRole: ${role}\nJob blurb: ${jd}\nDraft: ${base}` }
    ],
    temperature: 0.3,
    max_tokens: 220
  };
  try{
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(r=>r.json());
    const text = res.choices?.[0]?.message?.content?.trim();
    if(text) return { text, source: "openai" };
  }catch(_){}
  return { text: base, source: "template" };
}
