#!/usr/bin/env node
import fs from 'fs/promises'

const PROFILE = 'profile.json'
const SRC = 'lists/frame_1_software_full_stack_newgrad.txt'
const OUT = 'lists/frame_1_newgrad_ny_nj.txt'

const locationAllow = [
  'new york','ny','manhattan','brooklyn','queens','bronx','staten island','nyc','newark','jersey city','hoboken','paterson','elizabeth','camden','trenton','new brunswick','princeton','edison','yonkers','white plains','stamford','bridgeport','long island','nassau','suffolk','phila','philadelphia','hoboken'
]

function textIncludesAny(text, arr){
  if(!text) return false
  const t = text.toLowerCase()
  return arr.some(k => t.includes(k))
}

function buildKeywords(profile){
  const s = new Set()
  if(profile.skills){
    const pls = Array.isArray(profile.skills.programming_languages)?profile.skills.programming_languages:[]
    const techs = Array.isArray(profile.skills.technologies)?profile.skills.technologies:[]
    pls.concat(techs).forEach(x=>{ if(x) s.add(String(x).toLowerCase()) })
  }
  if(Array.isArray(profile.projects)){
    profile.projects.forEach(p=>{
      if(Array.isArray(p.stack)) p.stack.forEach(x=>x&&s.add(String(x).toLowerCase()))
      if(p.summary) String(p.summary).split(/[^A-Za-z0-9]+/).forEach(x=>x&&s.add(x.toLowerCase()))
    })
  }
  if(Array.isArray(profile.experience)){
    profile.experience.forEach(e=>{
      if(e && e.title) String(e.title).split(/[^A-Za-z0-9]+/).forEach(x=>x&&s.add(x.toLowerCase()))
      if(Array.isArray(e.highlights)) e.highlights.forEach(h=>String(h).split(/[^A-Za-z0-9]+/).forEach(x=>x&&s.add(x.toLowerCase())))
    })
  }
  // common tech extras
  ['react','react native','next.js','typescript','typescript','java','python','sql','postgres','postgre','dotnet','c#','c','expo','aws','azure','graphql','rest','api','full stack','frontend','backend','mobile','react native','expo','next'].forEach(x=>s.add(x))
  return Array.from(s).filter(Boolean)
}

async function main(){
  const prof = JSON.parse(await fs.readFile(PROFILE,'utf8'))
  const src = await fs.readFile(SRC,'utf8')
  const kws = buildKeywords(prof)
  const lines = src.split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
  const out = []
  for(const l of lines){
    // expect format: - <url> | company | title | location [#score:...]
    if(!l.startsWith('- ')) continue
    const rest = l.slice(2).trim()
    const parts = rest.split('|').map(p=>p.trim())
    const url = parts[0]
    const company = parts[1] || ''
    const title = parts[2] || ''
    const location = parts[3] || ''
    const combined = [company,title,location].join(' ')
    // location filter
    if(!textIncludesAny(combined, locationAllow)) continue
    // new-grad must be present in title/company
    if(!/(new grad|new graduate|university grad|university graduate|2026|2025|early career|entry level|new graduate|graduate)/i.test(combined)) continue
    // score against resume keywords
    let score = 0
    const text = combined.toLowerCase()
    for(const k of kws){ if(k.length>1 && text.includes(k)) score++ }
    if(score < 1) continue
    out.push({url,company,title,location,score})
  }

  // sort by score desc
  out.sort((a,b)=>b.score - a.score)
  await fs.writeFile(OUT, out.map(i=>`- ${i.url} | ${i.company} | ${i.title} | ${i.location} #score:${i.score}`).join('\n'), 'utf8')
  console.log(`Wrote ${OUT} with ${out.length} entries (top score ${out[0]?.score||0})`)
}

main().catch(e=>{ console.error(e); process.exit(1) })
