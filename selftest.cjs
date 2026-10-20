"use strict";
/**
 * 런타임 패치 자가 점검.
 *   node --require ./webp-upload-runtime.cjs selftest.cjs <PNG 파일> [엔진 주소=http://127.0.0.1:7860]
 *
 * 패치가 걸린 fetch 로 글로벌 갤러리에 PNG 를 올려 본다 → 서버가 돌려준 주소가 .webp 인지,
 * 파일이 실제 WebP 인지 확인한 뒤 → 올린 그림을 지운다. (엔진이 켜져 있어야 한다)
 */
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const [pngPath, base = "http://127.0.0.1:7860"] = process.argv.slice(2);
  if (!pngPath) throw new Error("사용법: node --require ./webp-upload-runtime.cjs selftest.cjs <PNG 파일> [엔진 주소]");
  const buf = fs.readFileSync(pngPath);
  const fd = new FormData();
  fd.append("prompt", "webp runtime selftest (지워도 됨)");
  fd.append("provider", "selftest");
  fd.append("model", "selftest");
  fd.append("file", new File([buf], path.basename(pngPath), { type: "image/png" }));

  const headers = { "x-marinara-csrf": "1" };
  const res = await fetch(`${base}/api/global-gallery/upload`, { method: "POST", headers, body: fd });
  const text = await res.text();
  if (!res.ok) throw new Error(`업로드 실패 ${res.status}: ${text.slice(0, 200)}`);
  const row = JSON.parse(text);
  console.log("업로드 응답:", { id: row.id, filePath: row.filePath, url: row.url, width: row.width, height: row.height });

  const file = await fetch(`${base}${row.url}`);
  const bytes = Buffer.from(await file.arrayBuffer());
  const isWebp = bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  console.log("저장된 파일:", { contentType: file.headers.get("content-type"), bytes: bytes.length, isWebp, pngBytes: buf.length });

  const del = await fetch(`${base}/api/global-gallery/${encodeURIComponent(row.id)}`, { method: "DELETE", headers });
  console.log("정리(삭제):", del.status);

  const ok = /\.webp$/i.test(row.url || "") && isWebp && bytes.length < buf.length;
  console.log(ok ? "결과: 통과" : "결과: 실패");
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.error("자가 점검 오류:", error.message);
  process.exitCode = 1;
});
