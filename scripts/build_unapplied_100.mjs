#!/usr/bin/env node
import fs from 'fs/promises'

const JOBS_JSON = 'jobs_by_resume_frame_accurate_partial.json'
const NEWGRAD_LIST = 'lists/frame_1_software_full_stack_newgrad.txt'
const OUT = 'lists/large_unapplied_100.txt'

const locRe = /\b(new york|nyc|new york, ny|newark|jersey city|hoboken|paterson|elizabeth|camden|trenton|new brunswick|princeton|edison|yonkers|white plains|stamford|bridgeport|long island|nassau|suffolk|brooklyn|queens|bronx|manhattan|staten island)\b/i
const internRe = /\b(intern|internship|co-?op|co op|summer intern)\b/i
const newGradRe = /\b(new grad|new graduate|entry level|recent grad|graduate|class of|202[3-9]|university grad|university graduate|early career)\b/i
const softwareRe = /\b(software engineer|software developer|software|engineer|developer|swe|full[- ]stack|backend|frontend|mobile|platform)\b/i

function parseListLines(text){
  return text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean).map(l=>{
    if(!l.startsWith('- ')) return null
    const rest = l.slice(2).trim()
    const parts = rest.split('|').map(p=>p.trim())
    return {url: parts[0]||'', company: parts[1]||'', title: parts[2]||'', location: parts[3]||'', score:0, source:'list'}
  }).filter(Boolean)
}

async function main(){
  const applied = {}
  try{
    const a = await fs.readFile('applied.json','utf8')
    const obj = JSON.parse(a)
    // applied.json may be map by url
    if(obj && typeof obj === 'object') Object.keys(obj).forEach(k=>applied[k]=true)
  }catch(e){/* ignore */}

  const map = new Map()

  // Load jobs JSON
  try{
    const data = await fs.readFile(JOBS_JSON,'utf8')
    const jobs = JSON.parse(data)
    for(const j of jobs){
      const url = j.url || j.apply_url || j.link || null
      const title = j.title || ''
      const company = j.company || ''
      const location = j.location || ''
      const snippet = j.snippet || ''
      if(!url) continue
      const text = [title, company, location, snippet].join(' ')
      if(internRe.test(text)) continue
      // prefer new-grad + software
      if(!softwareRe.test(text)) continue
      const isNewGrad = newGradRe.test(text)
      const isNYNJ = locRe.test(text)
      const score = (j.score||0) + (isNewGrad?5:0) + (isNYNJ?3:0)
      map.set(url, {url,company,title,location,score,source:'jobs_json'})
    }
  }catch(e){ /* ignore if file missing */ }

  // Load newgrad scraped list
  try{
    const txt = await fs.readFile(NEWGRAD_LIST,'utf8')
    const items = parseListLines(txt)
    for(const it of items){
      const url = it.url
      if(!url) continue
      const text = [it.title, it.company, it.location].join(' ')
      if(internRe.test(text)) continue
      // these are already new-grad oriented, but ensure software keywords
      const addScore = softwareRe.test(text) ? 10 : 0
      const isNYNJ = locRe.test(text)
      const score = it.score||0 + addScore + (isNYNJ?3:0)
      if(map.has(url)){
        // merge, keep higher score
        const ex = map.get(url)
        ex.score = Math.max(ex.score, score)
        ex.source = ex.source + ',newgrad'
        map.set(url, ex)
      }else{
        map.set(url, {...it,score,source:'newgrad_list'})
      }
    }
  }catch(e){/* ignore */}

  // Also scan other lists folder files for extra candidates
  try{
    const files = await fs.readdir('lists')
    for(const f of files){
      if(f === 'frame_1_software_full_stack_newgrad.txt' || f === 'frame_1_newgrad_ny_nj.txt' || f === 'large_unapplied_100.txt') continue
      if(!f.endsWith('.txt')) continue
      const txt = await fs.readFile('lists/'+f,'utf8')
      const items = parseListLines(txt)
      for(const it of items){
        const url = it.url
        if(!url) continue
        const text = [it.title, it.company, it.location].join(' ')
        if(internRe.test(text)) continue
        if(!softwareRe.test(text)) continue
        if(map.has(url)) continue
        map.set(url,{...it, score: (it.score||0)})
      }
    }
  }catch(e){/* ignore */}

  // filter out applied
  const candidates = Array.from(map.values()).filter(i=>!applied[i.url])

  // bucket priority
  const A = candidates.filter(i=> newGradRe.test([i.title,i.company,i.location].join(' ')) && locRe.test([i.title,i.company,i.location].join(' ')))
  const B = candidates.filter(i=> newGradRe.test([i.title,i.company,i.location].join(' ')) && !locRe.test([i.title,i.company,i.location].join(' ')))
  const C = candidates.filter(i=> !newGradRe.test([i.title,i.company,i.location].join(' ')))

  const sortDesc = arr => arr.sort((a,b)=> (b.score||0) - (a.score||0))
  sortDesc(A); sortDesc(B); sortDesc(C)

  const combined = [...A, ...B, ...C].slice(0,100)

  await fs.writeFile(OUT, combined.map(i=>`- ${i.url} | ${i.company||''} | ${i.title||''} | ${i.location||''} #score:${i.score||0}`).join('\n'), 'utf8')
  console.log('Wrote', combined.length, 'entries to', OUT)
}

main().catch(e=>{ console.error(e); process.exit(1) })
