#!/usr/bin/env node
/**
 * 글로벌 갤러리 PNG → WebP 1회성 변환 스크립트 v1.0.0 (Marinara Engine 2.5.x, 저장 형식 7 file-native)
 *
 * 반드시 엔진(서버)을 끈 상태에서 돌린다. 켠 채로 돌리면 서버가 메모리의 표를 다시 써서 되돌린다.
 *
 *   미리보기:  node global-gallery-png-to-webp.mjs --data <데이터 폴더>
 *   적용:      node global-gallery-png-to-webp.mjs --data <데이터 폴더> --apply --server-stopped
 *   옵션:      --quality 95 (50~100, 100=무손실)  --limit N (앞의 N장만)  --keep-png (PNG 를 백업 폴더로 옮기지 않고 그대로 둠)
 *
 * 하는 일(적용 모드)
 *   1. global_images 표에서 filePath 가 global/<이름>.png 인 행을 모은다(파일이 실제로 있는 것만).
 *   2. 각 PNG 를 sharp 로 <이름>.webp 로 변환해 같은 폴더에 만든다(같은 이름, 확장자만 다름).
 *      결과가 PNG 보다 크면 그 장은 건너뛴다(참조도 그대로).
 *   3. 저장소의 모든 표 파일(storage/tables/<표>/<조각>.json 과 .json.bak)에서 `<이름>.png` 를 `<이름>.webp` 로 바꾼다.
 *      이름은 21자 무작위 id 라 다른 문자열과 겹치지 않는다. 이미지 id(global-gallery:<id>)는 바뀌지 않는다.
 *      바꾸기 전 원본 표 파일은 <데이터>/webp-migration-backup/<시각>/ 에 복사해 둔다.
 *   4. 모든 표를 다시 읽어 남은 `<이름>.png` 가 0 인지, 고친 파일이 JSON 으로 읽히는지 검사한다.
 *   5. 검사가 끝나면 PNG 원본을 백업 폴더로 옮긴다(--keep-png 면 그대로 둠). 백업 폴더는 확인 뒤 직접 지우면 용량이 돌아온다.
 *
 * 되돌리기: 백업 폴더의 tables/ 를 storage/tables/ 위에 덮어쓰고 gallery/global/ 의 PNG 를 되돌린 뒤 서버를 켠다.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(name);
}
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const DATA = resolve(opt("--data", process.env.DATA_DIR || "/app/data"));
const APPLY = flag("--apply");
const SERVER_STOPPED = flag("--server-stopped");
const KEEP_PNG = flag("--keep-png");
const QUALITY = Math.min(100, Math.max(50, Number.parseInt(opt("--quality", "95"), 10) || 95));
const LIMIT = Number.parseInt(opt("--limit", "0"), 10) || 0;

const TABLES = join(DATA, "storage", "tables");
const GLOBAL_DIR = join(DATA, "gallery", "global");
const LEASE = join(DATA, "storage", ".writer-lease");
const ID_RE = /^[A-Za-z0-9_-]{10,40}$/;

function die(msg) {
  console.error("중단:", msg);
  process.exit(1);
}
function mb(n) {
  return `${(n / 1048576).toFixed(1)}MB`;
}

function loadSharp() {
  const candidates = [
    "/app/packages/server/package.json",
    join(process.cwd(), "package.json"),
    join(process.cwd(), "packages", "server", "package.json"),
    join(process.cwd(), "Marinara-Engine", "packages", "server", "package.json"),
  ];
  for (const c of candidates) {
    try {
      const mod = createRequire(c)("sharp");
      const s = mod && mod.default ? mod.default : mod;
      if (typeof s === "function") return s;
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

function listJsonFiles(dir) {
  const out = [];
  for (const table of readdirSync(dir)) {
    const tdir = join(dir, table);
    if (!statSync(tdir).isDirectory()) continue;
    for (const f of readdirSync(tdir)) {
      if (f.endsWith(".json") || f.endsWith(".json.bak")) out.push(join(tdir, f));
    }
  }
  return out;
}

// ── 0. 전제 확인 ──────────────────────────────────────────────
if (!existsSync(TABLES)) die(`표 폴더가 없습니다: ${TABLES} (--data 가 데이터 폴더인지 확인)`);
if (!existsSync(GLOBAL_DIR)) die(`글로벌 갤러리 폴더가 없습니다: ${GLOBAL_DIR}`);
if (!existsSync(join(TABLES, "global_images"))) die("global_images 표가 없습니다");
if (APPLY && !SERVER_STOPPED) die("--apply 에는 --server-stopped 를 함께 주세요 (서버를 끈 것을 확인했다는 뜻)");
if (APPLY && existsSync(LEASE)) {
  console.warn(`경고: ${LEASE} 가 남아 있습니다. 서버가 아직 떠 있으면 Ctrl+C 로 멈추세요. (강제 종료 뒤 남은 빈 폴더면 무시해도 됩니다)`);
}

// ── 1. 대상 모으기 ─────────────────────────────────────────────
const targets = [];
for (const f of readdirSync(join(TABLES, "global_images"))) {
  if (!f.endsWith(".json")) continue;
  let rows;
  try {
    rows = JSON.parse(readFileSync(join(TABLES, "global_images", f), "utf8"));
  } catch (e) {
    die(`global_images/${f} 를 읽지 못함: ${e.message}`);
  }
  for (const row of rows) {
    const m = /^global\/([^/]+)\.png$/i.exec(String(row.filePath || ""));
    if (!m) continue;
    const name = m[1];
    if (!ID_RE.test(name)) {
      console.warn(`이름이 예상 형식이 아니라 건너뜀: ${row.filePath}`);
      continue;
    }
    const png = join(GLOBAL_DIR, `${name}.png`);
    if (!existsSync(png)) {
      console.warn(`파일이 없어 건너뜀: ${row.filePath}`);
      continue;
    }
    targets.push({ id: row.id, name, png, webp: join(GLOBAL_DIR, `${name}.webp`), size: statSync(png).size });
  }
}
targets.sort((a, b) => a.name.localeCompare(b.name));
const picked = LIMIT > 0 ? targets.slice(0, LIMIT) : targets;
const totalPng = picked.reduce((s, t) => s + t.size, 0);
console.log(`데이터 폴더: ${DATA}`);
console.log(`PNG 대상: ${picked.length}장 / 전체 ${targets.length}장, ${mb(totalPng)} (품질 ${QUALITY}${QUALITY >= 100 ? " 무손실" : ""})`);

// ── 2. 참조 위치 세기(미리보기에서도) ───────────────────────────
const files = listJsonFiles(TABLES);
const nameSet = new Set(picked.map((t) => t.name));
const tokenRe = new RegExp(`(${[...nameSet].join("|")})\\.png(?![A-Za-z0-9_-])`, "g");
const refCount = new Map(); // 표 → 횟수
const touched = new Map(); // 파일 → 횟수
if (nameSet.size > 0) {
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const n = (text.match(tokenRe) || []).length;
    if (!n) continue;
    touched.set(file, n);
    const table = basename(dirname(file));
    refCount.set(table, (refCount.get(table) || 0) + n);
  }
}
console.log("참조 위치:", Object.fromEntries(refCount), `(파일 ${touched.size}개)`);

if (!APPLY) {
  for (const t of picked.slice(0, 10)) console.log(`  ${t.name}.png  ${mb(t.size)}`);
  if (picked.length > 10) console.log(`  … 외 ${picked.length - 10}장`);
  console.log("\n미리보기만 했습니다. 적용하려면 서버를 끄고 --apply --server-stopped 를 붙이세요.");
  process.exit(0);
}

// ── 3. 변환 ───────────────────────────────────────────────────
const sharp = loadSharp();
if (!sharp) die("sharp 를 찾지 못했습니다. 엔진 서버 패키지 폴더(packages/server)나 도커 컨테이너 안에서 실행하세요.");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const BACKUP = join(DATA, "webp-migration-backup", stamp);
mkdirSync(join(BACKUP, "tables"), { recursive: true });
mkdirSync(join(BACKUP, "gallery", "global"), { recursive: true });

const converted = [];
const skipped = [];
let webpBytes = 0;
for (const [i, t] of picked.entries()) {
  try {
    let out;
    if (existsSync(t.webp)) {
      out = readFileSync(t.webp); // 이전 실행에서 이미 만든 것
    } else {
      const src = readFileSync(t.png);
      const enc = sharp(src, { failOn: "none" });
      out = await (QUALITY >= 100 ? enc.webp({ lossless: true, effort: 4 }).toBuffer() : enc.webp({ quality: QUALITY, effort: 4 }).toBuffer());
      if (!out || out.length === 0 || out.length >= src.length) {
        skipped.push({ ...t, reason: `결과가 더 큼 (${mb(src.length)} → ${mb(out ? out.length : 0)})` });
        continue;
      }
      writeFileSync(`${t.webp}.tmp`, out);
      renameSync(`${t.webp}.tmp`, t.webp);
    }
    webpBytes += out.length;
    converted.push(t);
    if ((i + 1) % 20 === 0 || i + 1 === picked.length) console.log(`변환 ${i + 1}/${picked.length}`);
  } catch (e) {
    skipped.push({ ...t, reason: `변환 실패: ${e.message}` });
  }
}
console.log(`변환 완료 ${converted.length}장 (${mb(converted.reduce((s, t) => s + t.size, 0))} → ${mb(webpBytes)}), 건너뜀 ${skipped.length}장`);
for (const s of skipped) console.log(`  건너뜀 ${s.name}: ${s.reason}`);
if (converted.length === 0) die("변환된 그림이 없어 표를 고치지 않습니다.");

// ── 4. 표 고치기 (변환된 이름만) ────────────────────────────────
const convertedNames = new Set(converted.map((t) => t.name));
const replaceRe = new RegExp(`(${[...convertedNames].join("|")})\\.png(?![A-Za-z0-9_-])`, "g");
let replacedTotal = 0;
const rewritten = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (!replaceRe.test(text)) continue;
  replaceRe.lastIndex = 0;
  const next = text.replace(replaceRe, (_m, name) => {
    replacedTotal += 1;
    return `${name}.webp`;
  });
  if (file.endsWith(".json")) {
    try {
      JSON.parse(next);
    } catch (e) {
      die(`고친 결과가 JSON 이 아닙니다 (${file}): ${e.message} — 아무것도 쓰지 않았습니다`);
    }
  }
  const rel = file.slice(TABLES.length + 1);
  const bak = join(BACKUP, "tables", rel);
  mkdirSync(dirname(bak), { recursive: true });
  copyFileSync(file, bak);
  writeFileSync(`${file}.webp-tmp`, next, "utf8");
  renameSync(`${file}.webp-tmp`, file);
  rewritten.push(file);
}
console.log(`표 파일 ${rewritten.length}개에서 참조 ${replacedTotal}곳 교체 (원본 사본: ${join(BACKUP, "tables")})`);

// ── 5. 검사 ───────────────────────────────────────────────────
let leftover = 0;
for (const file of listJsonFiles(TABLES)) {
  const text = readFileSync(file, "utf8");
  replaceRe.lastIndex = 0;
  const n = (text.match(replaceRe) || []).length;
  if (n) {
    leftover += n;
    console.warn(`  남은 참조 ${n}곳: ${file}`);
  }
  if (file.endsWith(".json")) JSON.parse(text);
}
const missing = converted.filter((t) => !existsSync(t.webp));
if (leftover > 0 || missing.length > 0) {
  die(`검사 실패 (남은 참조 ${leftover}, 없는 webp ${missing.length}). PNG 는 그대로 두었으니 백업 폴더로 되돌릴 수 있습니다.`);
}
console.log("검사 통과: 남은 .png 참조 0, webp 파일 전부 존재, 표 파일 전부 JSON 정상");

// ── 6. PNG 치우기 ─────────────────────────────────────────────
if (KEEP_PNG) {
  console.log("--keep-png: PNG 원본을 그대로 둡니다 (더는 참조되지 않음).");
} else {
  for (const t of converted) renameSync(t.png, join(BACKUP, "gallery", "global", `${t.name}.png`));
  console.log(`PNG ${converted.length}장을 ${join(BACKUP, "gallery", "global")} 로 옮겼습니다. 확인 뒤 백업 폴더를 지우면 ${mb(converted.reduce((s, t) => s + t.size, 0))} 가 돌아옵니다.`);
}
console.log("끝. 이제 서버를 켜고 가챠포지 화면에서 그림을 확인하세요.");
