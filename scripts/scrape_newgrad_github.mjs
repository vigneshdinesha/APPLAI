#!/usr/bin/env node
import fs from 'fs/promises'

const RAW = 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/main/README.md'
const HTML = 'https://github.com/SimplifyJobs/New-Grad-Positions'
const OUT = 'lists/frame_1_software_full_stack_newgrad.txt'

const includeKw = [
  'new grad', 'new graduate', 'newly graduated', 'class of', 'entry level', 'recent grad', 'graduate', 'new grad software', 'new grad engineer', 'graduate software', 'new grad swe', 'new graduate', 'university grad', 'university graduate'
]
const excludeKw = ['intern', 'internship', 'co-op', 'co op', 'summer intern']

function textIncludesAny(text, arr) {
  if (!text) return false
  const t = text.toLowerCase()
  return arr.some(k => t.includes(k))
}

async function main(){
  console.log('Fetching README from SimplifyJobs...')
  // Try raw README first
  let md = null
  try{
    const res = await fetch(RAW)
    if (res.ok) md = await res.text()
  }catch(e){ /* ignore */ }

  let lines = []
  if (md){
    const marker = '## 💻 Software Engineering New Grad Roles'
    const idx = md.indexOf(marker)
    if (idx !== -1){
      const after = md.slice(idx)
  lines = after.split('\n').filter(l => l.trim().startsWith('|'))
  console.log('Found', lines.length, 'table-like lines in raw README after marker')
  if (lines.length>0) console.log(lines.slice(0,10).join('\n'))
    }
  }

    // Fallbacks: try HTML page first, then GitHub API readme
    if (!lines || lines.length === 0){
      console.log('Falling back to HTML scrape')
      try{
        const res2 = await fetch(HTML)
        if (res2.ok){
          const html = await res2.text()
          // find the Software Engineering heading and the following <table>
          const sectIdx = html.indexOf('>💻 Software Engineering New Grad Roles<')
          if (sectIdx !== -1){
            const tableStart = html.indexOf('<table', sectIdx)
            const tableEnd = html.indexOf('</table>', tableStart)
            if (tableStart !== -1 && tableEnd !== -1){
              const tableHtml = html.slice(tableStart, tableEnd+8)
              const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
              let r
              while((r = rowRe.exec(tableHtml))){
                const tr = r[1]
                // extract <td> contents
                const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi
                const cols = []
                const hrefs = []
                let td
                while((td = tdRe.exec(tr))){
                  const inner = td[1]
                  // extract any hrefs
                  const hrefRe = /href=\"([^\"]+)\"/gi
                  let h
                  let found = []
                  while((h = hrefRe.exec(inner))){ found.push(h[1]); }
                  if(found.length) hrefs.push(found)
                  const txt = inner.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()
                  cols.push(txt)
                }
                if (cols.length>0){
                  // if application href present, take first href from the last column or any href in the row
                  let url = null
                  if(hrefs.length){
                    // prefer the last column's first href
                    const last = hrefs[hrefs.length-1]
                    if(last && last.length) url = last[0]
                    else url = hrefs.flat()[0]
                  }
                  // push row as markdown-like table line but we'll later convert to list entries with URLs
                  lines.push('| '+cols.join(' | ')+' |'+(url?(' URL:'+url):''))
                }
              }
            }
          }
        }
      }catch(e){
        // ignore HTML failure
      }

      if (!lines || lines.length === 0){
        console.log('Falling back to GitHub API readme')
        try{
          const api = 'https://api.github.com/repos/SimplifyJobs/New-Grad-Positions/readme'
          const r3 = await fetch(api, {headers:{'User-Agent':'node.js'}})
          if (r3.ok){
            const j = await r3.json()
            if (j.content){
              const md2 = Buffer.from(j.content, 'base64').toString('utf8')
              console.log('API readme size', md2.length)
              const marker = '## 💻 Software Engineering New Grad Roles'
              const idx2 = md2.indexOf(marker)
              if (idx2 !== -1){
                const after2 = md2.slice(idx2)
                lines = after2.split('\n').filter(l => l.trim().startsWith('|'))
                console.log('Found', lines.length, 'table-like lines in API README after marker')
                if (lines.length>0) console.log(lines.slice(0,10).join('\n'))
              }else{
                console.log('Marker not found in API README')
              }
            }
          }
        }catch(e){ /* ignore */ }
      }

      if (!lines || lines.length === 0) throw new Error('Could not find Software Engineering section via any fallback')
    }

  const outItems = []
  for (const l of lines){
    const cols = l.split('|').map(s=>s.trim()).filter(Boolean)
    if (cols.length < 2) continue
    const company = cols[0]
    const title = cols[1]
    const location = cols[2] || ''
    // try to find an URL token 'URL:' appended by earlier parsing
    let url = null
    const urlMatch = l.match(/URL:([^\s]+)/)
    if (urlMatch) url = urlMatch[1]
    // basic filters
    const combined = [company, title, location].join(' ')
    if (!/software|engineer|developer|swe|full ?stack|frontend|backend|devops|site reliability|sre|infrastructure/i.test(combined)) continue
    if (textIncludesAny(combined, excludeKw)) continue
    if (!textIncludesAny(combined, includeKw) && !/entry level|associate|early career|junior|university grad|new graduate/i.test(combined)) continue
    if (!url) continue // skip entries without explicit apply URL
    outItems.push({company, title, location, url, combined})
  }

  // Dedupe by url
  const seen = new Set()
  const final = []
  for (const it of outItems){
    if (seen.has(it.url)) continue
    seen.add(it.url)
    final.push(it)
  }

  await fs.mkdir('lists', {recursive:true})
  const linesOut = final.map(i => `- ${i.url} | ${i.company} | ${i.title} | ${i.location}`).join('\n')
  await fs.writeFile(OUT, linesOut, 'utf8')
  console.log(`Wrote ${OUT} with ${final.length} entries`)
}

main().catch(e=>{console.error(e); process.exit(1)})
