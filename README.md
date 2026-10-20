# 글로벌 갤러리 webp 저장 패치 v1.0.0

Marinara Engine의 **글로벌 갤러리**에 서버 안의 앱(가챠포지 등)이 올리는 그림을 PNG 대신 WebP로 저장하게 하는 비공식 패치입니다. 가챠포지는 캐릭터·CG·배경·적 일러를 전부 여기에 PNG(장당 1.5~2MB)로 쌓는데, 이 패치를 쓰면 같은 그림이 약 0.3MB(품질 95 기준 PNG의 약 17%)로 저장됩니다.

엔진·가챠포지의 설치 파일은 건드리지 않습니다. 가챠포지 코드에 기대지 않고 엔진의 업로드 API(`POST /api/global-gallery/upload`)만 보므로 가챠포지가 업데이트돼도 그대로 동작하고, 엔진을 업데이트해도 패치 파일은 도커 이미지 밖에 있어 남습니다. 엔진이 그 API의 모양을 바꾸면 패치는 조용히 원본 요청을 그대로 보냅니다(그림이 깨지지는 않고 PNG로 저장될 뿐).

## 확인 환경

- Marinara Engine 2.5.0 (도커, Node.js 24), Gacha Forge 1.8.12
- 실측: 가챠포지 PNG 206장 349.4MB → WebP 58.5MB(품질 95), 변환 뒤 앨범·과거 스토리·전투·의상·카드 다시 그리기·배너 모두 정상
- 다른 `--require` 패치(한글 패치 등)와 같이 쓸 수 있습니다

## 구성 파일

| 파일 | 역할 | 언제 |
|---|---|---|
| `webp-upload-runtime.cjs` | 런타임 패치. 엔진이 뜰 때 함께 읽혀 **앞으로** 올라오는 PNG를 올리기 직전에 WebP로 바꿈 | 한 번 설치해 두면 계속 |
| `global-gallery-png-to-webp.mjs` | 1회성 변환. **이미 쌓인** PNG를 WebP로 바꾸고 표의 참조를 고침 | 서버를 끄고 한 번 |
| `selftest.cjs` | 런타임 패치 자가 점검 | 설치 뒤 확인용 |

---

## A. 런타임 패치 설치 (도커 서버, SSH)

### 1. 마리나라 설치 폴더로 이동

```bash
cd /root/Marinara-Engine
```

`docker-compose.yml`이 있는 폴더입니다. 설치 위치가 다르면 그 폴더로 가세요. 이후 모든 명령은 이 폴더에서 실행합니다.

### 2. 패치 파일 내려받기

```bash
curl -fsSLO https://raw.githubusercontent.com/boricha417/marinara-global-gallery-webp/main/webp-upload-runtime.cjs
curl -fsSLO https://raw.githubusercontent.com/boricha417/marinara-global-gallery-webp/main/global-gallery-png-to-webp.mjs
curl -fsSLO https://raw.githubusercontent.com/boricha417/marinara-global-gallery-webp/main/selftest.cjs
ls -l webp-upload-runtime.cjs global-gallery-png-to-webp.mjs selftest.cjs
```

파일 세 개가 보이면 됩니다. `curl: (22)` 오류가 나면 주소를 다시 확인하세요.

### 3. override 파일 백업

```bash
cp docker-compose.override.yml docker-compose.override.yml.before-webp-$(date +%Y%m%d)
```

`docker-compose.override.yml`이 아직 없으면 이 단계는 건너뛰세요(4단계에서 새로 만듭니다).

### 4. override 파일에 두 줄 추가

```bash
nano docker-compose.override.yml
```

**경우 A — 다른 `--require` 패치를 이미 쓰고 있을 때.** `volumes:` 아래에 마운트 줄을 하나 더 넣고, 기존 `NODE_OPTIONS=` 줄 끝에 공백 한 칸을 두고 `--require=/app/webp-upload-runtime.cjs`를 이어 붙입니다. 예를 들어 기존이 이랬다면:

```yaml
services:
  marinara:
    volumes:
      - ./다른패치.cjs:/app/다른패치.cjs:ro
    environment:
      - NODE_OPTIONS=--require=/app/다른패치.cjs
```

이렇게 됩니다:

```yaml
services:
  marinara:
    volumes:
      - ./다른패치.cjs:/app/다른패치.cjs:ro
      - ./webp-upload-runtime.cjs:/app/webp-upload-runtime.cjs:ro
    environment:
      - NODE_OPTIONS=--require=/app/다른패치.cjs --require=/app/webp-upload-runtime.cjs
```

**경우 B — `--require` 패치가 처음일 때.** `services: → marinara:` 아래에 다음을 넣습니다(`volumes:`나 `environment:`가 이미 있으면 그 목록에 줄만 추가).

```yaml
services:
  marinara:
    volumes:
      - ./webp-upload-runtime.cjs:/app/webp-upload-runtime.cjs:ro
    environment:
      - NODE_OPTIONS=--require=/app/webp-upload-runtime.cjs
```

주의: YAML은 들여쓰기가 중요합니다. 공백 2칸 단위로 맞추고 탭은 쓰지 마세요. nano에서 저장은 `Ctrl+O`, `Enter`, 나가기는 `Ctrl+X`.

### 5. 설정 검사

```bash
docker compose config -q && echo "설정 OK"
docker compose config | grep -E "NODE_OPTIONS|webp-upload-runtime"
```

첫 줄에서 `설정 OK`가 나오고, 둘째 줄에서 `NODE_OPTIONS`에 `--require=/app/webp-upload-runtime.cjs`가, 그리고 `source: .../webp-upload-runtime.cjs` 마운트가 보여야 합니다. 오류가 나면 4단계의 들여쓰기를 다시 보세요.

### 6. 컨테이너 다시 만들기

```bash
docker compose up -d --force-recreate marinara
docker compose ps
```

환경변수는 컨테이너를 다시 만들어야 적용됩니다. `ps`에서 `marinara`가 `Up`이면 됩니다(완전히 뜨는 데 30초쯤 걸립니다).

### 7. 설치 확인

```bash
docker compose logs --since 5m marinara | grep gallery-webp
```

다음 줄이 보이면 설치 완료입니다.

```
[gallery-webp] 설치됨 (품질 95, 범위 global) — 설치 파일은 건드리지 않음
```

### 8. 동작 확인

가챠포지에서 그림을 하나 만들어 보세요(카드 다시 그리기, 배너 다시 그리기 등). 그 뒤 로그에 이런 줄이 찍힙니다.

```bash
docker compose logs --since 10m marinara | grep "gallery-webp\] PNG"
```

```
[gallery-webp] PNG 1778KB → WebP 293KB (16%) /api/global-gallery/upload portrait.webp
```

안 보일 때:

- `설치됨` 줄 자체가 없다 → 5단계로 돌아가 `NODE_OPTIONS`에 들어갔는지, 6단계에서 `--force-recreate`로 다시 만들었는지 확인.
- `sharp 를 찾지 못해 변환하지 않습니다` → 도커가 아닌 환경입니다. 아래 "로컬(윈도우)" 참고.
- `설치됨`은 있는데 변환 줄이 없다 → 그 그림이 글로벌 갤러리로 올라간 게 맞는지(가챠포지는 전부 글로벌 갤러리), PNG였는지 확인. 옵션에서 `MARINARA_WEBP_UPLOAD_ONLY`를 썼다면 값을 확인.

---

## B. 이미 쌓인 PNG 변환 (1회성)

런타임 패치는 **앞으로** 생기는 그림만 바꿉니다. 이미 있는 PNG는 이 스크립트로 한 번 바꿉니다. **반드시 서버를 끈 상태**에서 돌립니다. 켠 채로 돌리면 서버가 메모리의 표를 다시 써서 되돌립니다.

### 1. 전체 백업

```bash
cd /root/Marinara-Engine
docker compose stop marinara
docker run --rm -v marinara-engine_marinara-data:/data:ro -v /root/backups:/backup alpine \
  sh -c "cd /data && tar czf /backup/marinara-data-before-webp-$(date +%Y%m%d).tar.gz ."
ls -lh /root/backups/
```

볼륨 이름이 다르면 `docker volume ls`로 확인하세요(보통 `<폴더이름>_marinara-data`). 서버는 이 뒤로 4단계까지 꺼진 채로 둡니다.

### 2. 미리보기

```bash
docker compose run --rm --no-deps -e NODE_OPTIONS= \
  -v ./global-gallery-png-to-webp.mjs:/app/global-gallery-png-to-webp.mjs:ro \
  --entrypoint node marinara /app/global-gallery-png-to-webp.mjs --data /app/data
```

아무것도 바꾸지 않고 이런 요약만 보여 줍니다.

```
PNG 대상: 206장 / 전체 206장, 349.4MB (품질 95)
참조 위치: { capability_documents: 373, global_images: 206 } (파일 256개)
```

### 3. 적용

같은 명령 끝에 `--apply --server-stopped`를 붙입니다.

```bash
docker compose run --rm --no-deps -e NODE_OPTIONS= \
  -v ./global-gallery-png-to-webp.mjs:/app/global-gallery-png-to-webp.mjs:ro \
  --entrypoint node marinara /app/global-gallery-png-to-webp.mjs --data /app/data --apply --server-stopped
```

200장 기준 2분 안팎 걸리고, 끝에 이렇게 나와야 합니다.

```
변환 완료 206장 (349.4MB → 58.5MB), 건너뜀 0장
표 파일 256개에서 참조 579곳 교체 (원본 사본: /app/data/webp-migration-backup/<시각>/tables)
검사 통과: 남은 .png 참조 0, webp 파일 전부 존재, 표 파일 전부 JSON 정상
PNG 206장을 /app/data/webp-migration-backup/<시각>/gallery/global 로 옮겼습니다. ...
```

`중단:`으로 끝나면 아무것도 바뀌지 않은 상태이니 메시지를 보고 다시 시도하세요.

적용이 하는 일:

1. `global_images` 표에서 `global/<이름>.png` 행을 모읍니다.
2. 각 PNG를 같은 이름의 `.webp`로 변환합니다(결과가 더 크면 그 장은 건너뜀).
3. 저장소의 모든 표 파일에서 `<이름>.png`를 `<이름>.webp`로 바꿉니다. 이름이 21자 무작위 id라 다른 문자열과 겹치지 않고, 이미지 id(`global-gallery:<id>`)는 그대로라 엔진의 삭제 보호 연결도 유지됩니다. 고치기 전 표 파일은 백업 폴더에 복사해 둡니다.
4. 모든 표를 다시 읽어 남은 `.png` 참조가 0인지, 파일이 JSON으로 읽히는지 검사합니다. 실패하면 PNG를 그대로 둔 채 멈춥니다.
5. 검사를 통과하면 PNG 원본을 백업 폴더로 옮깁니다.

### 4. 서버 켜기

```bash
docker compose up -d marinara
```

### 5. 확인

가챠포지에서 앨범, 과거 스토리, 전투, 카드 그림이 정상으로 보이는지 봅니다. 그림을 바꾸는 동작(카드 다시 그리기, 이전 그림 가져오기, 의상 갈아입기, 배너 다시 그리기)도 한 번씩 해 보면 확실합니다.

### 6. 백업 폴더 정리

확인이 끝나면 볼륨 안의 변환 전 원본을 지웁니다. 지워야 용량이 돌아옵니다(전체 백업 tar는 따로 있으니 안전).

```bash
docker compose exec marinara sh -c "du -sh /app/data/webp-migration-backup && rm -rf /app/data/webp-migration-backup"
```

### 되돌리기

문제가 있으면 서버를 끄고, 백업 폴더의 `tables/`를 `storage/tables/` 위에 덮어쓰고 `gallery/global/`의 PNG를 제자리로 옮긴 뒤 서버를 켭니다. 1단계의 전체 백업 tar에서 복원해도 됩니다.

스크립트 옵션: `--quality 95`(50~100, 100=무손실), `--limit 5`(앞의 5장만, 시험용), `--keep-png`(PNG를 옮기지 않고 둠).

---

## C. 업데이트 / 제거

**업데이트**: A-2의 `curl` 세 줄을 다시 실행한 뒤 `docker compose up -d --force-recreate marinara`.

**제거**: `docker-compose.override.yml`에서 `webp-upload-runtime.cjs` 마운트 줄 하나와 `NODE_OPTIONS`의 `--require=/app/webp-upload-runtime.cjs` 항목 하나만 지웁니다(다른 패치는 그대로). 그다음:

```bash
docker compose config -q && docker compose up -d --force-recreate marinara
```

이미 webp로 저장된 그림은 그대로 두어도 됩니다. 엔진은 webp를 정상 지원합니다.

---

## D. 자가 점검

엔진이 켜진 상태에서 컨테이너 안에서 돌립니다. 글로벌 갤러리에 PNG를 올렸다가 바로 지우며, 서버가 `.webp`로 저장했는지 확인합니다.

```bash
docker cp selftest.cjs marinara-engine-marinara-1:/tmp/selftest.cjs
docker cp <아무 PNG 파일> marinara-engine-marinara-1:/tmp/test.png
docker compose exec marinara node --require /app/webp-upload-runtime.cjs /tmp/selftest.cjs /tmp/test.png http://127.0.0.1:7860
```

컨테이너 이름이 다르면 `docker compose ps`로 확인하세요. 마지막 줄이 `결과: 통과`여야 합니다.

---

## 옵션 (환경변수, override의 `environment:`에 추가)

| 변수 | 기본 | 뜻 |
|---|---|---|
| `MARINARA_WEBP_UPLOAD_QUALITY` | `95` | WebP 품질 50~100. 100이면 무손실(용량 절감이 크게 줄어듦) |
| `MARINARA_WEBP_UPLOAD_SCOPE` | `global` | `all`이면 앱이 채팅방 갤러리 API로 올리는 그림도 포함 |
| `MARINARA_WEBP_UPLOAD_ONLY` | (비움) | 예: `gacha-forge` — 호출 스택에 이 문자열이 있을 때만 변환 |
| `MARINARA_WEBP_UPLOAD_OFF` | (비움) | `1`이면 패치를 끔(파일은 둔 채) |

## 로컬(윈도우)에서 쓰기

도커 없이 런처로 띄우는 경우, 엔진을 실행하는 셸에서 `NODE_OPTIONS=--require=<이 파일의 전체 경로>`를 설정하고 `packages/server` 폴더에서 엔진을 시작하면 같은 방식으로 동작합니다(sharp는 그 폴더의 의존성에서 찾습니다). 1회성 스크립트도 `packages/server` 폴더에서 `node <경로>/global-gallery-png-to-webp.mjs --data <경로>/packages/server/data`로 돌릴 수 있습니다. 서버를 끈 상태여야 하는 건 같습니다.

## 알아둘 점

- 변환은 sharp(엔진에 내장)로 하며 투명도는 유지됩니다. PNG 텍스트 청크(마리나라가 넣는 생성 요청 기록)는 사라지고, NovelAI가 알파 채널에 숨기는 생성 정보는 남습니다.
- 런타임 패치는 글로벌 갤러리 업로드만 봅니다. 노들·슬럽은 자기 폴더에 따로 저장하므로 해당 없고(슬럽은 이미 webp), RP/대화 방에서 엔진이 직접 그리는 삽화도 이 API를 거치지 않아 바뀌지 않습니다(그쪽은 "갤러리 webp 변환" 확장 몫).
- 브라우저에서 엔진 화면으로 직접 글로벌 갤러리에 올리는 그림은 서버 fetch를 거치지 않아 PNG로 남습니다. 그건 1회성 스크립트를 다시 돌릴 때 같이 처리됩니다.
- 비공식 런타임 패치입니다. 엔진 메이저 업데이트 뒤에는 A-7 로그 확인이나 D 자가 점검을 한 번 해 보세요.
