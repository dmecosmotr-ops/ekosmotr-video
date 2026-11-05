import { execFileSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const forbiddenPath = /(?:^|\/)(?:private|node_modules|runtime|__pycache__|qa|secrets|backups)(?:\/|$)|\.(?:sqlite(?:-\w+)?|db(?:-\w+)?|log|pid|pem|key|p12|pfx|class|jar|mp4|mkv|avi|wav|mp3|pyc)$/i;
const sourcePaths = [
  /^backend\/[\w.-]+\.mjs$/, /^backend\/README\.md$/, /^tests\/[\w.-]+\.(?:mjs|py)$/,
  /^frontend\/src\/[\w./-]+\.(?:jsx?|css)$/, /^frontend\/[\w.-]+\.test\.mjs$/,
  /^frontend\/(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|index\.html|vite\.config\.js)$/,
  /^tools\/[\w.-]+\.(?:py|java|mjs|txt)$/, /^docs\/[\w.-]+\.md$/,
  /^video\/[\w.-]+\.(?:py|txt)$/, /^docs\/YOLOX_LICENSE\.txt$/,
  /^deploy\/[\w.-]+\.(?:mjs|sh|py|md|example)$/, /^data\/(?:stations\.json|SOURCE\.md)$/,
  /^\.github\/workflows\/ci\.yml$/, /^[A-Z][A-Z0-9_]*\.md$/,
  /^deploy\/video\.Dockerfile$/,
  /^(?:\.gitignore|\.gitattributes|\.dockerignore|\.env\.example|Dockerfile|compose(?:\.video)?\.yaml|package\.json|[\w-]+\.ps1)$/,
];
const highConfidenceSecrets = [
  [/\bgh[pousr]_[A-Za-z0-9]{25,}\b/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/, 'GitHub fine-grained token'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{35,}\b/, 'API key'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'private key'],
  [/["'](?:serviceToken|ssecurity|passToken)["']\s*:\s*["'][A-Za-z0-9_+/=-]{20,}["']/, 'Xiaomi credential literal'],
];

export function reviewSource(path, bytes) {
  const issues = [];
  if (forbiddenPath.test(path) || /(?:^|\/)\.env(?:\.|$)/.test(path) && path !== '.env.example') issues.push('private/runtime path');
  if (!sourcePaths.some(pattern => pattern.test(path))) issues.push('outside source allowlist');
  if (bytes.length > 1024 * 1024) issues.push('file larger than source limit');
  if (!isUtf8(bytes) || bytes.includes(0)) issues.push('binary or invalid UTF-8');
  if (!issues.length) {
    const content = bytes.toString('utf8');
    for (const [pattern, label] of highConfidenceSecrets) if (pattern.test(content)) issues.push(label);
  }
  return issues;
}

function checkIndex() {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).split('\0').filter(Boolean);
  if (!files.length) throw new Error('No staged/tracked source files to review');
  let failed = false;
  for (const path of files) {
    const bytes = execFileSync('git', ['show', `:${path}`], { maxBuffer: 2 * 1024 * 1024 });
    const issues = reviewSource(path, bytes);
    if (issues.length) { failed = true; console.error(`${path}: ${issues.join(', ')}`); }
  }
  if (failed) process.exitCode = 1;
  else console.log(`PASS: ${files.length} indexed source files; no forbidden paths/binaries or high-confidence credential patterns. This is an automated check, not a full security certification.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { checkIndex(); } catch { console.error('Release check failed: use a Git checkout with a readable source index. No file contents are printed.'); process.exitCode = 1; }
}
