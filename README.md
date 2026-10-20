# 글로벌 갤러리 webp 저장 패치 v1.0.0 (Marinara Engine 2.5.0)

가챠포지처럼 **서버 안에서 돌아가는 앱이 글로벌 갤러리에 올리는 그림**을 PNG 대신 WebP로 저장하게 하는 두 가지 도구입니다.

| 파일 | 역할 | 언제 |
|---|---|---|
| `webp-upload-runtime.cjs` | 런타임 패치. 엔진이 뜰 때 함께 읽혀, 앞으로 올라오는 PNG를 올리기 직전에 WebP로 바꿈 | 한 번 설치해 두면 계속 |
| `global-gallery-png-to-webp.mjs` | 1회성 변환. 이미 쌓인 PNG를 WebP로 바꾸고 표의 참조를 고침 | 서버를 끄고 한 번 |
| `selftest.cjs` | 런타임 패치 자가 점검 | 설치 전후 확인용 |

엔진·가챠포지의 설치 파일은 건드리지 않습니다. 가챠포지 코드에도 기대지 않고 엔진의 업로드 API(`POST /api/global-gallery/upload`)만 보므로 가챠포지가 업데이트돼도 그대로 동작합니다. 엔진 업데이트(이미지 교체)에도 패치 파일은 이미지 밖에 있어 남습니다. 단, 엔진이 그 API의 모양을 바꾸면 패치는 조용히 원본 요청을 그대로 보냅니다(그림이 깨지지는 않고, PNG로 저장될 뿐).

## 1. 런타임 패치 설치 (도커 서버)

`/root/Marinara-Engine/`에 파일을 두고 `docker-compose.override.yml`에 마운트와 `--require`를 추가합니다.

```yaml
services:
  marinara:
    volumes:
      - ./gacha-ko-runtime.cjs:/app/gacha-ko-runtime.cjs:ro
      - ./webp-upload-runtime.cjs:/app/webp-upload-runtime.cjs:ro
    environment:
      - NODE_OPTIONS=--require=/app/gacha-ko-runtime.cjs --require=/app/webp-upload-runtime.cjs
```

이미 있는 `--require` 뒤에 공백으로 이어 붙이면 됩니다(순서 무관). 그다음 `docker compose up -d`로 다시 띄우고, 로그에 `[gallery-webp] 설치됨` 이 보이면 끝입니다. 이후 가챠포지가 그림을 만들 때마다 `[gallery-webp] PNG 1907KB → WebP 332KB (17%) …` 같은 줄이 찍힙니다.

환경변수(선택): `MARINARA_WEBP_UPLOAD_QUALITY`(기본 95, 100이면 무손실), `MARINARA_WEBP_UPLOAD_SCOPE=all`(채팅방 갤러리 업로드도 포함), `MARINARA_WEBP_UPLOAD_ONLY=gacha-forge`(가챠포지 호출만), `MARINARA_WEBP_UPLOAD_OFF=1`(끄기).

로컬(윈도우)에서는 엔진을 띄우는 셸에서 `NODE_OPTIONS=--require=<이 파일의 전체 경로>`를 설정하면 같은 방식으로 동작합니다.

### 자가 점검

엔진이 켜진 상태에서, 엔진 서버 패키지 폴더(`packages/server`, sharp가 있는 곳)나 컨테이너 안에서:

```bash
node --require ./webp-upload-runtime.cjs selftest.cjs <아무 PNG 파일> http://127.0.0.1:7860
```

글로벌 갤러리에 올렸다가 바로 지웁니다. `결과: 통과`가 나와야 합니다.

## 2. 1회성 변환 (이미 쌓인 PNG)

**순서가 중요합니다.** 전체 백업 → 서버 끄기 → 미리보기 → 적용 → 서버 켜기 → 확인.

```bash
cd /root/Marinara-Engine
docker compose stop marinara
docker compose run --rm --no-deps -e NODE_OPTIONS= \
  -v ./global-gallery-png-to-webp.mjs:/app/global-gallery-png-to-webp.mjs:ro \
  --entrypoint node marinara /app/global-gallery-png-to-webp.mjs --data /app/data
```

위 명령은 **미리보기**입니다. 대상 장수·용량·참조 위치를 보여 주고 아무것도 바꾸지 않습니다. 적용하려면 같은 명령 끝에 `--apply --server-stopped`를 붙입니다. 끝나면 `docker compose up -d`.

적용이 하는 일:

1. `global_images` 표에서 `global/<이름>.png` 행을 모읍니다.
2. 각 PNG를 같은 이름의 `.webp`로 변환합니다(결과가 더 크면 그 장은 건너뜀).
3. 저장소의 모든 표 파일에서 `<이름>.png`를 `<이름>.webp`로 바꿉니다. 이름이 21자 무작위 id라 다른 문자열과 겹치지 않고, 이미지 id(`global-gallery:<id>`)는 그대로라 엔진의 삭제 보호 연결도 유지됩니다. 고치기 전 표 파일은 `<데이터>/webp-migration-backup/<시각>/tables/`에 복사해 둡니다.
4. 모든 표를 다시 읽어 남은 `.png` 참조가 0인지, 파일이 JSON으로 읽히는지 검사합니다. 실패하면 PNG를 그대로 둔 채 멈춥니다.
5. 검사를 통과하면 PNG 원본을 백업 폴더로 옮깁니다. 가챠포지 화면을 확인한 뒤 백업 폴더를 지우면 그만큼 용량이 돌아옵니다.

되돌리기: 백업 폴더의 `tables/`를 `storage/tables/` 위에 덮어쓰고, `gallery/global/`의 PNG를 제자리로 옮긴 뒤 서버를 켭니다. 전체 백업에서 복원해도 됩니다.

옵션: `--quality 95`, `--limit 5`(앞의 5장만, 시험용), `--keep-png`(PNG를 옮기지 않고 둠).

## 알아둘 점

- 변환은 sharp(엔진에 내장)로 하며 투명도는 유지됩니다. PNG 텍스트 청크(마리나라가 넣는 생성 요청 기록)는 사라지고, NovelAI가 알파 채널에 숨기는 생성 정보는 남습니다(갤러리 webp 변환 확장과 같음).
- 런타임 패치는 글로벌 갤러리 업로드만 봅니다. 노들·슬럽은 자기 폴더에 따로 저장하므로 해당 없음(슬럽은 이미 webp).
- 엔진 클라이언트(브라우저)에서 직접 올리는 그림은 서버 fetch를 거치지 않아 바뀌지 않습니다. 그건 1회성 스크립트가 다음에 돌 때 같이 처리됩니다.
- 비공식 런타임 패치입니다. 엔진 메이저 업데이트 뒤에는 자가 점검을 한 번 돌려 보세요.
