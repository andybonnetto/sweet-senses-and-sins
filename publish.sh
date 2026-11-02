#!/usr/bin/env bash
# Regenerates pdfs.json (list of PDFs for static hosting) and pushes to GitHub Pages.
set -e
cd "$(dirname "$0")"
node -e '
const fs=require("fs");
const l=fs.readdirSync(".").filter(f=>/\.pdf$/i.test(f)).map(f=>({name:f,mtime:fs.statSync(f).mtimeMs})).sort((a,b)=>b.mtime-a.mtime);
fs.writeFileSync("pdfs.json",JSON.stringify(l));'
git add -A && git commit -m "Update book" || true
git push
