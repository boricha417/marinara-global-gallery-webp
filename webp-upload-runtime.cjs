"use strict";
/**
 * 글로벌 갤러리 webp 저장 런타임 패치 v1.0.0 (Marinara Engine 2.5.x)
 *
 * 엔진 프로세스가 뜰 때 `NODE_OPTIONS=--require=/app/webp-upload-runtime.cjs` 로 먼저 읽힌다.
 * 하는 일은 하나뿐이다: 서버 안에서 돌아가는 앱(가챠포지 등)이 엔진의
 * `POST /api/global-gallery/upload` 에 PNG 파일을 올리면, 올리기 직전에 sharp 로 WebP 로 바꿔
 * `.webp` 파일로 올린다. 엔진은 받은 그대로 `.webp` 로 저장하고 `.webp` 주소를 돌려주므로,
 * 앱이 문서에 적는 주소도 자연히 `.webp` 가 된다.
 *
 * - 디스크의 엔진·패키지 파일은 건드리지 않는다(패키지 무결성 검사와 무관).
 * - 가챠포지 코드에 기대지 않고 엔진의 업로드 API 모양만 본다 → 가챠포지가 업데이트돼도 그대로 동작.
 * - 무슨 문제든 생기면(sharp 없음, 변환 실패, 결과가 더 큼) 원본 요청을 그대로 보낸다(fail-open).
 *
 * 환경변수
 *   MARINARA_WEBP_UPLOAD_QUALITY  기본 95 (50~100, 100 이면 무손실)
 *   MARINARA_WEBP_UPLOAD_SCOPE    "global"(기본: 글로벌 갤러리만) | "all"(채팅방 갤러리 업로드도)
 *   MARINARA_WEBP_UPLOAD_ONLY     예: "gacha-forge" — 호출 스택에 이 문자열이 있을 때만 변환(기본: 비움 = 모든 앱)
 *   MARINARA_WEBP_UPLOAD_OFF      "1" 이면 패치를 끈다
 */

const TAG = "[gallery-webp]";
const { createRequire } = require("node:module");
const path = require("node:path");

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

const OFF = process.env.MARINARA_WEBP_UPLOAD_OFF === "1";
const QUALITY = clamp(Number.parseInt(process.env.MARINARA_WEBP_UPLOAD_QUALITY || "95", 10) || 95, 50, 100);
const SCOPE = (process.env.MARINARA_WEBP_UPLOAD_SCOPE || "global").toLowerCase() === "all" ? "all" : "global";
const ONLY = (process.env.MARINARA_WEBP_UPLOAD_ONLY || "").trim();

const GLOBAL_UPLOAD_RE = /^\/api\/global-gallery\/upload\/?$/;
const CHAT_UPLOAD_RE = /^\/api\/gallery\/[^/]+\/upload\/?$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function log(...args) {
  console.log(TAG, ...args);
}
function warn(...args) {
  console.warn(TAG, ...args);
}

// sharp 는 엔진 서버 패키지의 의존성이다. 도커(/app)와 로컬(packages/server 에서 실행) 둘 다 찾는다.
let sharpModule = undefined; // undefined = 아직 안 찾음, null = 없음
function loadSharp() {
  if (sharpModule !== undefined) return sharpModule;
  const candidates = [
    "/app/packages/server/package.json",
    path.join(process.cwd(), "package.json"),
    path.join(process.cwd(), "packages", "server", "package.json"),
    path.join(__dirname, "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const mod = createRequire(candidate)("sharp");
      sharpModule = mod && mod.default ? mod.default : mod;
      if (typeof sharpModule === "function") return sharpModule;
    } catch {
      // 다음 후보
    }
  }
  sharpModule = null;
  warn("sharp 를 찾지 못해 변환하지 않습니다 (원본 PNG 그대로 올라감)");
  return null;
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    if (typeof input.href === "string") return input.href; // URL
    if (typeof input.url === "string") return input.url; // Request
  }
  return "";
}

function requestMethod(input, init) {
  const method = (init && init.method) || (input && typeof input === "object" && input.method) || "GET";
  return String(method).toUpperCase();
}

function hasContentTypeHeader(init) {
  const headers = init && init.headers;
  if (!headers) return false;
  try {
    if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.has("content-type");
    if (Array.isArray(headers)) return headers.some(([k]) => String(k).toLowerCase() === "content-type");
    return Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
  } catch {
    return true; // 모르면 손대지 않는다
  }
}

/** 이 요청이 우리가 바꿀 업로드인지 본다. 아니면 null. */
function inspect(input, init) {
  if (requestMethod(input, init) !== "POST") return null;
  const raw = requestUrl(input);
  if (!raw) return null;
  let pathname;
  try {
    pathname = new URL(raw, "http://127.0.0.1").pathname;
  } catch {
    return null;
  }
  const isGlobal = GLOBAL_UPLOAD_RE.test(pathname);
  const isChat = SCOPE === "all" && CHAT_UPLOAD_RE.test(pathname);
  if (!isGlobal && !isChat) return null;
  const body = init && init.body;
  if (typeof FormData === "undefined" || !(body instanceof FormData)) return null; // Request 본문 등은 건드리지 않음
  if (hasContentTypeHeader(init)) return null; // 경계(boundary)가 박힌 헤더면 본문을 바꿀 수 없다
  const file = body.get("file");
  if (!file || typeof file !== "object" || typeof file.arrayBuffer !== "function") return null;
  const name = typeof file.name === "string" ? file.name : "";
  const type = typeof file.type === "string" ? file.type.toLowerCase() : "";
  if (type !== "image/png" && !/\.png$/i.test(name)) return null;
  if (ONLY && !String(new Error().stack || "").includes(ONLY)) return null;
  return { pathname, body, file, name };
}

async function convertBody(plan) {
  const sharp = loadSharp();
  if (!sharp) return null;
  const source = Buffer.from(await plan.file.arrayBuffer());
  if (source.length < PNG_MAGIC.length || !source.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return null;
  const encoder = sharp(source, { failOn: "none" });
  const out = await (QUALITY >= 100
    ? encoder.webp({ lossless: true, effort: 4 }).toBuffer()
    : encoder.webp({ quality: QUALITY, effort: 4 }).toBuffer());
  if (!out || out.length === 0 || out.length >= source.length) {
    log(`변환 결과가 더 크거나 비어 PNG 그대로 올림 (${source.length}B → ${out ? out.length : 0}B) ${plan.name}`);
    return null;
  }
  const newName = (plan.name || "image.png").replace(/\.png$/i, "") + ".webp";
  const replaced = new FormData();
  for (const [key, value] of plan.body) {
    if (key === "file") replaced.append("file", new File([out], newName, { type: "image/webp" }));
    else if (value && typeof value === "object" && typeof value.arrayBuffer === "function") replaced.append(key, value, value.name);
    else replaced.append(key, value);
  }
  log(`PNG ${(source.length / 1024).toFixed(0)}KB → WebP ${(out.length / 1024).toFixed(0)}KB (${Math.round((out.length / source.length) * 100)}%) ${plan.pathname} ${newName}`);
  return replaced;
}

(function install() {
  if (OFF) {
    log("MARINARA_WEBP_UPLOAD_OFF=1 — 패치 비활성");
    return;
  }
  const original = globalThis.fetch;
  if (typeof original !== "function") {
    warn("globalThis.fetch 가 없어 패치를 걸지 않습니다");
    return;
  }
  if (original.__galleryWebpPatched) return;

  const patched = async function fetchWithWebpUpload(input, init) {
    try {
      const plan = inspect(input, init);
      if (plan) {
        const body = await convertBody(plan);
        if (body) return original.call(this, input, { ...init, body });
      }
    } catch (error) {
      warn("변환 중 오류 — 원본 그대로 올림:", error && error.message ? error.message : error);
    }
    return original.call(this, input, init);
  };
  patched.__galleryWebpPatched = true;
  globalThis.fetch = patched;
  log(`설치됨 (품질 ${QUALITY}${QUALITY >= 100 ? " 무손실" : ""}, 범위 ${SCOPE}${ONLY ? `, ${ONLY} 호출만` : ""}) — 설치 파일은 건드리지 않음`);
})();
