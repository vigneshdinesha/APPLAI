#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'jobs_by_resume_frame.txt');
const OUTDIR = path.join(ROOT, 'lists');

const FRAMES = {
  '1': 'Software / Full-Stack',
  '2': 'Mobile Development',
  '3': 'Data Engineering / Analytics',
  '4': 'Internal Tools / Platform',
  '5': 'Research / Emerging Tech',
  '6': 'Cloud / DevOps'
};

function cleanUrl(raw) {
  if (!raw) return raw;
  // remove trailing HTML like "><img... or "><img
  let u = raw.replace(/\">.*$/, '');
  // also strip trailing punctuation
  u = u.replace(/[\),]+$/, '');
  return u;
}

async function main() {
  await fs.mkdir(OUTDIR, { recursive: true });
  const text = await fs.readFile(SRC, 'utf8');
  const lines = text.split(/\r?\n/);

  const lists = { '1': [], '2': [], '3': [], '4': [], '5': [], '6': [] };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line && line.match(/^[-]\s+(\S+)/);
    if (m) {
      let url = cleanUrl(m[1]);
      // accumulate block until next leading '- '
      let j = i + 1;
      const block = [line];
      while (j < lines.length && !lines[j].match(/^[-]\s+\S+/)) {
        block.push(lines[j]);
        j++;
      }
      const blockText = block.join('\n');

      // find Assigned line
      const assignedMatch = blockText.match(/Assigned:\s*([^\n\r]+)/i);
      const assignedNums = (assignedMatch && assignedMatch[1]) ? (assignedMatch[1].match(/\d+/g) || []) : [];

      // find Snippet
      const snippetMatch = blockText.match(/Snippet:\s*(.+)/i);
      const snippet = snippetMatch ? snippetMatch[1].trim() : '';

      // fallback: if url looks like html-wrapped, try to extract http.. from blockText
      if ((!url || url.length < 5) && blockText) {
        const alt = blockText.match(/(https?:\/\/[^\s"'>]+)/);
        if (alt) url = alt[1];
      }

      // add to each assigned frame list
      if (assignedNums.length === 0) {
        // unknown assignment: skip
      } else {
        for (const num of assignedNums) {
          if (!FRAMES[num]) continue;
          lists[num].push({ url, assigned: assignedNums, snippet });
        }
      }

      i = j;
    } else {
      i++;
    }
  }

  // write files
  for (const num of Object.keys(FRAMES)) {
    const name = FRAMES[num];
    const filename = path.join(OUTDIR, `frame_${num}_${name.toLowerCase().replace(/[^a-z0-9]+/g,'_')}.txt`);
    const header = `Jobs for frame ${num} - ${name}\n\n`;
    const items = lists[num].map(entry => {
      const assignedNames = entry.assigned.map(n => `${n}: ${FRAMES[n] || 'Unknown'}`).join(', ');
      return `- ${entry.url}\n  Use resume: ${num} - ${name}\n  Assigned: ${assignedNames}\n  Snippet: ${entry.snippet || ''}\n`;
    }).join('\n');
    const out = header + items + '\n';
    await fs.writeFile(filename, out, 'utf8');
    console.log(`Wrote ${path.relative(ROOT, filename)} (${lists[num].length} items)`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
