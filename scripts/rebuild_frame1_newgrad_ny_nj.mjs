#!/usr/bin/env node
import fs from 'fs/promises'

const PROFILE = 'profile.json'
const ACC = 'jobs_by_resume_frame_accurate_partial.json'
const OUT = 'lists/frame_1_newgrad_ny_nj.txt'

// keywords to detect new-grad roles
const newGradKW = ['new grad','new graduate','newly graduated','2026','2025','university grad','university graduate','early career','entry level','new graduate','new grad program','university graduate']

function makeKeywords(profile){
  const kws = new Set()
  if(profile.skills){
    const pls = Array.isArray(profile.skills.programming_languages) ? profile.skills.programming_languages : (profile.skills.programming_languages? [profile.skills.programming_languages]:[])
    const techs = Array.isArray(profile.skills.technologies) ? profile.skills.technologies : (profile.skills.technologies? [profile.skills.technologies]:[])
    pls.forEach(k=>{ if(k) kws.add(String(k).toLowerCase()) })
    techs.forEach(k=>{ if(k) kws.add(String(k).toLowerCase()) })
  }
  if(profile.projects){
    profile.projects.forEach(p=>{
      if(p.stack) p.stack.forEach(s=>kws.add(String(s).toLowerCase()))
      if(p.summary) p.summary.split(/[^A-Za-z0-9+/\-]+/).filter(Boolean).forEach(t=>kws.add(t.toLowerCase()))
    })
  }
  if(profile.experience){
    profile.experience.forEach(e=>{
      if(e.title) e.title.split(/[^A-Za-z0-9+/\-]+/).forEach(t=>kws.add(t.toLowerCase()))
      if(e.highlights) e.highlights.forEach(h=>h.split(/[^A-Za-z0-9+/\-]+/).forEach(t=>kws.add(t.toLowerCase())))
    })
  }
  // small curated extras
  ['react','react native','next.js','typescript','typescript','java','python','sql','postgre','dotnet','c#','c','expo','aws','azure','graphql','rest','api','full stack','frontend','backend','mobile'].forEach(s=>kws.add(s))
  return Array.from(kws).filter(Boolean)
}

function textIncludesAny(text, arr){
  if(!text) return false
  const t = text.toLowerCase()
  return arr.some(k => t.includes(k))
}

function locationMatches(text){
  if(!text) return false
  const t = text.toLowerCase()
  const nj = ['new jersey',' nj','newark','jersey city','hoboken','paterson','elizabeth','camden','trenton','edison','new brunswick','princeton','toms river','bayonne','clifton','montclair']
  const ny = ['new york',' ny','manhattan','brooklyn','queens','bronx','staten island','yonkers','long island','nassau','suffolk','white plains']
  for(const p of nj) if(t.includes(p)) return true
  for(const p of ny) if(t.includes(p)) return true
  return false
}

async function main(){
  console.log('Loading profile and accurate jobs...')
  const profRaw = await fs.readFile(PROFILE,'utf8')
  const profile = JSON.parse(profRaw)
  const accRaw = await fs.readFile(ACC,'utf8')
  const jobs = JSON.parse(accRaw)

  const kws = makeKeywords(profile)
  console.log('Built', kws.length, 'resume keywords')

  const candidates = []
  for(const job of jobs){
    try{
  // previously we required an assigned frame or high software score; remove that
  // to capture software new-grad roles that may not have been strongly scored but have clear titles/snippets

      const text = [job.title||'', job.snippet||'', job.company||'', job.location||''].join(' ')

      // must be new-grad (avoid internships)
      if(!textIncludesAny(text, newGradKW)) continue
      if(/\bintern(ship)?\b|co-op|co op|summer intern/i.test(text)) continue

      // location must match NY or NJ (approximate)
      if(!locationMatches(text)) continue

  // score against resume keywords
  let score = 0
  for(const k of kws){ if(k.length>1 && text.includes(k)) score += 1 }
  // require at least 1 keyword hit (loosened from 2)
  if(score < 1) continue

      // compute snippet url if present
      const url = job.url || null
      candidates.push({url, company: job.company||'', title: job.title||'', location: job.location||'', score})
    }catch(e){ /* skip malformed job */ }
  }

  // sort by score desc
  candidates.sort((a,b)=>b.score - a.score)

  await fs.mkdir('lists', {recursive:true})
  const outLines = candidates.filter(c=>c.url).map(c=>`- ${c.url} | ${c.company} | ${c.title} | ${c.location} #score:${c.score}`)
  await fs.writeFile(OUT, outLines.join('\n'), 'utf8')
  console.log(`Found ${candidates.length} candidates before URL filtering; wrote ${outLines.length} entries to ${OUT} (top score ${candidates[0]?.score||0})`)
}

main().catch(e=>{ console.error(e); process.exit(1) })
