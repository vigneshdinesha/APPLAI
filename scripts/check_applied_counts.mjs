#!/usr/bin/env node
import fs from 'fs/promises'

async function main(){
  const appliedRaw = await fs.readFile('applied.json','utf8')
  const applied = JSON.parse(appliedRaw)
  const lines = (await fs.readFile('lists/large_unapplied_100.txt','utf8')).split(/\r?\n/).filter(Boolean)
  const urls = lines.map(l=> l.startsWith('- ')?l.slice(2).split('|')[0].trim():null).filter(Boolean)
  let appliedCount=0, openedCount=0, submittedCount=0
  const matched=[]
  for(const u of urls){
    if(applied[u]){
      appliedCount++
      const s = (applied[u].status||applied[u].state||applied[u].reason||'').toString()
      if(s.includes('manual-submitted')) submittedCount++
      if(s.includes('opened')) openedCount++
      matched.push({url:u,status:s})
    }
  }
  console.log('LIST_TOTAL=',urls.length)
  console.log('APPLIED_MATCHES=',appliedCount,'OPENED=',openedCount,'SUBMITTED=',submittedCount)
  matched.slice(0,20).forEach((m,i)=>console.log(`${i+1}. ${m.status} | ${m.url}`))
}
main().catch(e=>{ console.error(e); process.exit(1) })
