# 여행 플래너 (개인용 PWA)

새 여행 만드는 절차:
1. 이 폴더(trip-app)를 새 레포로 복사하고 GitHub Pages 를 켠다.
2. 브라우저 콘솔에서 `crypto.randomUUID()` 를 실행해 여행 키를 만든다. 키는 코드, 설정, 레포 어디에도 넣지 않는다(회귀 테스트가 막는다).
3. config.js 의 tripName, themeColor 를 바꾼다. (홈 화면 아이콘 이름을 바꾸려면 manifest.json 의 name 도)
4. 초대 링크 `https://사이트주소/trip-app/#k=<키>` 를 만들어 본인과 가족에게 보낸다(카톡 나에게 보내기 등). 처음 열면 키가 그 브라우저에 저장되고 주소창에서는 지워진다. 설정 탭 "초대 링크 복사"로 다시 만들 수 있다.
5. 폰 크롬에서 열어 "홈 화면에 추가"(설치)하고, 일정 탭의 "여행 기간"에서 날짜를 넣는다.
6. Firestore 규칙은 프로젝트당 한 번만 firestore.rules.trips.txt 의 블록을 콘솔에 붙여넣으면 된다.

## 여행 키와 초대 링크

여행 데이터는 Firestore 의 `trips/{키}` 아래에 있다. 이 키를 코드가 아니라 초대 링크로만 전달한다.
- 링크의 `#` 뒤쪽은 서버(GitHub Pages)와 Referer 로 전송되지 않는다. 앱이 열리면 키를 localStorage("tripKey") 한 곳에 저장하고 주소창에서 지운다.
- 키가 없으면(링크 없이 접속) 앱은 잠금 화면만 보여 주고 Firestore 를 읽거나 쓰지 않는다. 잠금 화면에 링크 또는 키를 붙여넣어 열 수도 있다(iOS 홈 화면 앱은 사파리와 저장소가 분리돼 있어 필요할 수 있다).
- 키가 곧 접근 권한이다. 링크가 유출되면 키를 새로 만들어 데이터를 옮겨야 한다. Firestore 규칙은 키만 알면 읽고 쓸 수 있게 열려 있다(firestore.rules.trips.txt 참고).
- 저장소가 막힌 브라우저(일부 시크릿 모드)에서는 키를 저장하지 못하므로 주소창의 `#k=` 를 지우지 않는다. 그 방문에서는 새로고침해도 열린다.
- 설정 탭 "이 기기에서 키 지우기"는 이 기기의 키만 지운다. 서버의 여행 데이터는 지워지지 않는다.
- JSON 내보내기 파일에는 키를 넣지 않는다.
- 사이트 루트(`/`)는 데이터 없는 리다이렉트 페이지다. 예전 주소나 초대 링크(`/#k=...`), 구글맵 공유(`/?title=...`)로 들어와도 쿼리와 해시를 그대로 `trip-app/` 으로 넘긴다.
- 여행지 투표 등 지난 페이지는 `../archive/` 에 보관하고(설정 > 지난 기록), 이 앱과 코드를 공유하지 않는다.

### 키 교체(이전) 절차

옛 키가 공개 저장소 히스토리에 남았거나 링크가 유출됐다면 키를 새로 만들어 데이터를 옮긴다.
1. 옛 초대 링크로 열어 설정 > 데이터 > "JSON 내보내기". 파일에는 일정, 숙소 이름 등이 들어 있으니 공개 저장소에 올리지 않는다(키는 들어 있지 않다).
2. 브라우저 콘솔에서 `crypto.randomUUID()` 로 새 키를 만든다.
3. 새 초대 링크 `https://사이트주소/trip-app/#k=<새키>` 로 연다(빈 여행이 새로 만들어진다). 설정 > 데이터 > "JSON 가져오기"로 파일을 고르고, 미리보기를 확인한 뒤 "가져오기".
4. 가족에게 새 링크를 보낸다. 새 링크로 열면 저장된 옛 키를 새 키가 덮어쓴다(주소의 키가 저장된 키보다 우선).
5. 옛 데이터 정리: Firebase 콘솔에서 `trips/<옛키>` 문서와 하위 컬렉션(pool, items, expenses, members, flights, lodgings)을 지운다. 문서만 지우면 하위 컬렉션이 남을 수 있으니, 지운 뒤 콘솔 데이터 탭에서 남은 것이 없는지 확인한다. 옛 링크는 다시 열지 않는다(열면 옛 키의 여행 문서가 새로 생성된다).

### JSON 가져오기 규칙

- 같은 ID 의 문서는 가져온 필드만 바뀌고(나머지 필드는 유지: 예를 들어 이미 확정한 공항), 파일에 없는 문서는 그대로 두며, 아무것도 삭제하지 않는다. 같은 파일을 여러 번 가져와도 결과가 같다.
- 쓰기 전에 미리보기(건수, 건너뛸 문서, 이 여행의 기존 데이터 건수)를 보여 주고 확인을 받는다.
- 파일은 신뢰하지 않는다: 5MB, 3,000건 한도. 문서 ID 형식, 예약된 필드 이름(`__x__`), 중첩 배열, 너무 깊거나 큰 문서는 그 문서만 건너뛴다. 지도 링크(`mapUrl`)는 구글맵 https 주소만 남기고 나머지는 비운다. 여행 문서는 이름, 시작일, 종료일, 통화만 가져온다.
- 쓰기는 400건씩 배치로 한다. 중간에 실패하면 몇 건까지 썼는지 알려 주고, 같은 파일을 다시 가져오면 이어진다. 인터넷 연결이 필요하다.
- 금고(내 정보) 데이터는 내보내기와 가져오기에 포함되지 않는다.

## 요약 탭과 카드 데이터

요약 탭의 항공편, 숙소 카드는 HTML 이 아니라 Firestore 문서(`flights/out`, `flights/in`, `lodgings/*`)에서 그린다. 이 앱의 HTML 에는 여행 데이터가 없다.
- 기본 필드: 항공편 `flightNo, depIata, arrIata, depLocal, arrLocal, memo`, 숙소 `name, checkIn, checkOut, memo` (플래너 설정 화면의 폼이 쓰는 필드와 같다).
- 카드용 부가 필드(선택): `details` 는 `[{ "label": "터미널", "value": "인천 T2" }, ...]` 행 목록(최대 20행, 라벨 40자, 값 300자), `link` 는 `{ "label": "지도에서 보기", "url": "https://www.google.com/maps/..." }` 버튼 하나(구글맵 https 주소만). 형식이 틀리면 그 필드만 화면에서 숨긴다. 플래너 폼으로 저장해도 부가 필드는 유지된다.
- 데이터는 JSON 가져오기로 넣는다. 가져오기 파일 예: `{ "flights": [{ "id": "out", "flightNo": "XX1", "details": [...] }], "lodgings": [{ "id": "stay", "name": "...", "checkIn": "2026-11-14", "checkOut": "2026-11-17", "link": {...} }] }`. 실제 여행 데이터가 든 파일은 저장소에 올리지 않는다.
- 예약번호, 정확한 주소, 여권 이름 같은 진짜 비밀은 카드에 넣지 않고 Worker 의 `/vault`(내 정보)에 둔다.
- 가져올 때 앱이 쓰는 필드의 타입(문자열 필드에 객체가 오는 등)이 틀리면 그 필드만 버리고 미리보기에 건수를 알려 준다.

## Worker 사용 계약

Worker 소스는 이 저장소에 없다(비공개, Cloudflare 대시보드에서 직접 배포). 저장소의 .gitignore 에 worker/ 가 들어 있고, 코드도 비밀값도 여기에 두지 않는다.
앱이 아는 것은 config.js 의 resolverUrl(끝 슬래시 없이)뿐이다. 비어 있으면 링크만 저장하는 모드로 동작하고, 내 정보 버튼은 "Worker 주소가 설정되지 않았어요"를 보여 준다.

공통 조건
- Worker 의 ALLOWED_ORIGINS 에 앱 origin(예: https://mirasoy.github.io)이 있어야 한다. 아니면 403 origin_not_allowed.
- Authorization 헤더나 JSON 본문을 쓰는 요청(POST /legs, POST /vault)은 CORS 사전 요청(OPTIONS)에 응답해야 한다. 허용 헤더에 Authorization 이 있어야 한다.
- 브라우저 JS 가 429 의 Retry-After 를 읽으려면 응답에 Access-Control-Expose-Headers: Retry-After 가 있어야 한다. 없으면 앱은 "(N분 뒤)" 없이 안내한다.
- Places 호출용 키(Worker 시크릿)와 지도 임베드 키(config.js 의 embedKey)는 서로 다른 키를 쓴다. embedKey 가 비면 지도 버튼이 숨겨지고 이동시간 배지만 나온다.

앱이 부르는 경로

| 경로 | 용도 | 확인 방법 |
|---|---|---|
| GET /?url=... | 장소 링크 해석 | `{resolverUrl}/?url=https%3A%2F%2Fmaps.app.goo.gl%2FmhxnmRTUAenLRSsb6&places=0` 에서 resolve_note 가 ok 또는 recovered_from_sorry, placeId 가 ChIJQXcl6LarQjQRGUMnQ18F0lE |
| GET /airport?code=TPE | 항공편 공항 확정 | candidates 에 타오위안 국제공항이 오는지 |
| POST /legs | 구간 이동시간, 구간 지도 | 앱의 일정 화면에서 이동시간 배지가 나오는지 |
| POST /vault | 내 정보(예약번호 등) | 아래 계약 |
| GET /wiki | 장소 대표 사진(위키미디어) | 아래 계약 |

이동시간과 거리는 구글 약관의 캐싱 제한 때문에 어디에도 저장하지 않는다(메모리 캐시뿐, 새로고침하면 다시 계산).

### POST /vault

- 호출: `POST {resolverUrl}/vault`, 헤더 `Authorization: Bearer {토큰}`, 본문 없음. 토큰을 URL, 쿼리, 본문에 넣지 않는다.
- 응답
  - 200: `{ success, fetchedAt, data }`
  - 401 `unauthorized`: 토큰이 다름
  - 429 `too_many_attempts`: `Retry-After`(초)
  - 503 `vault_not_configured`, 500 `vault_misconfigured`: 서버 설정 문제
  - 403 `origin_not_allowed`: 앱 origin 이 허용 목록에 없음
- data 구조: `{ updatedAt, groups: [ { title, items: [ { label, value } ] } ] }`. 앱은 이 구조 밖의 필드를 알지 못하고 쓰지 않는다. 그룹 제목, 항목 라벨, 값을 그대로 그린다.

앱 쪽 동작(vault.js, vault-ui.js)
- 설정 화면과 항공편 섹션의 "내 정보" 버튼이 모달을 연다. 토큰 입력칸과 "이 기기에서 기억"(기본 꺼짐)이 있다.
- 기억을 켠 성공 조회에서만 토큰을 localStorage("vaultToken") 한 곳에 저장하고, 다음부터 모달을 열면 자동 조회한다. 끄면 토큰은 메모리에만 있고 모달을 닫으면 사라진다. 저장 위치는 토큰 하나뿐이다.
- 값은 점으로 가려 두고 탭하면 10초간 보인다. 항목마다 복사 버튼이 있다(복사한 값은 기기 클립보드에 남는다).
- 60초 무조작, 탭이 백그라운드로 감, 모달 닫기 중 하나가 일어나면 화면의 데이터를 지운다.
- 응답 데이터는 Firestore, IndexedDB, localStorage, sessionStorage, Cache Storage, JSON 내보내기, 콘솔 어디에도 남기지 않는다. 서비스워커는 /vault 요청을 가로채지도 캐시하지도 않는다.
- 오류 문구: 401 "토큰이 달라요", 429 "잠시 뒤에 다시 시도해 주세요(N분 뒤)", 503/500/403 "서버 설정을 확인해 주세요", 네트워크 실패 "연결을 확인해 주세요". 토큰과 응답 내용은 문구에 넣지 않는다.

### GET /wiki (장소 대표 사진)

- 호출: `GET {resolverUrl}/wiki?name={장소 이름}&near={위도,경도}&radiusKm={숫자}` (POST `{name, near, radiusKm}` 도 가능). `near`, `radiusKm` 은 선택이다.
- `near` 는 config.js 의 `destinationCenter`(여행지 중심, 직접 입력한 값)만 쓴다. 비우거나 형식이 틀리면 `near`, `radiusKm` 없이 이름만 보낸다. 장소의 구글 좌표나 GPS 값은 보내지 않는다. 반경은 `wikiRadiusKm`(기본 80).
- 응답: `{ success, found, match("exact"|"brand"), entityId, label, image:{ file, pageUrl, thumbUrl, thumbWidth, thumbHeight, fullUrl, license, licenseUrl, artist, credit, attributionRequired }, reason }`
- 오류: 400(invalid_name, invalid_near, invalid_radius), 403(origin_not_allowed), 502(wiki_unavailable), 503(wiki_ua_not_configured). 502, 503, 네트워크 오류, 25초 타임아웃(Worker 내부 예산 20초)은 모두 "사진 없음"으로 조용히 처리하고(오류 화면, 로그, 자동 재시도 없음) 400, 403 도 같다.
- 단순 GET 요청이라 CORS 사전 요청(OPTIONS)은 필요 없다. 응답에 `Access-Control-Allow-Origin` 만 있으면 된다.
- `image.thumbUrl` 은 `thumb.wikimedia.org` 또는 `upload.wikimedia.org` 호스트로 오며, 쿼리스트링(`utm_...`)을 지우거나 정규화하지 않고 그대로 `img src` 에 쓴다. 앱에는 CSP 가 없어 `img-src` 허용 작업은 필요 없고, 나중에 CSP 를 넣는다면 두 호스트를 `img-src` 에 허용해야 한다.
- 응답의 `version` 같은 추가 필드는 무시한다. `trace` 가 있어도 저장하거나 표시하지 않는다(저장은 아래 필드만 골라서 한다).

앱 쪽 동작(wiki.js)
- 조회 시점은 장소를 저장할 때(링크나 이름으로 새 장소 문서를 만들 때, 이름이 비어 있던 장소에 이름이 정해질 때)와 일정 카드에서 이름을 고쳐 저장할 때뿐이다. 목록을 열 때마다 부르지 않는다(정적 테스트가 호출 지점을 지킨다). 저장은 응답을 기다리지 않고 먼저 끝나며, 사진은 도착하면 해당 장소 문서의 `photo` 에 나중에 반영한다.
- `found: true` 이면 확인 없이 그대로 적용한다(선택 화면, 확인창, 후보 목록 없음). `found: false` 이면 아무것도 저장하지 않고 다음에 이름이 바뀔 때만 다시 시도한다(이전에 받은 사진은 그대로 남는다). 같은 이름으로는 연속해서 다시 부르지 않는다.
- 저장 필드(pool 문서의 `photo` 맵): `source("wikimedia"), file, pageUrl, thumbUrl, license, licenseUrl, artist, credit, attributionRequired, match, fetchedAt`(+사용자가 숨기면 `hidden: true`). 이미지 파일이나 base64 는 저장하지 않고, 표시할 때 `thumbUrl` 을 위키미디어에서 직접 불러온다. 구글에서 받은 사진이나 사진 이름은 어디에도 저장하지 않는다.
- `thumbUrl` 은 `thumb.wikimedia.org` 또는 `upload.wikimedia.org`, `pageUrl` 은 위키 도메인의 https 주소만 받는다. 다른 값이면 사진 없음으로 본다. URL 은 검증만 하고 응답이 준 문자열 그대로 쓴다. `artist`, `credit`, `license` 는 `textContent` 로만 화면에 넣는다(innerHTML 없음). 마크업 기호(`<`, `&`)가 없는 값(`User:이름` 같은 사용자명 포함)은 앞뒤 공백만 다듬고 변형하지 않으며, 마크업이 섞여 온 경우에만 태그를 걷어낸 평문으로 저장한다.
- 화면: 카드에 썸네일과 한 줄 출처("사진: {artist}, {license}, Wikimedia Commons"). `license` 글자는 `licenseUrl` 로, "Wikimedia Commons" 글자는 `pageUrl` 로 각각 링크하고(새 탭, `rel="noopener noreferrer"`), 링크 대상은 응답이 준 값만 쓴다. `licenseUrl` 이 없으면 `license` 는 글자만 둔다. `artist` 는 링크 없이 그대로 표시한다. `match` 가 `brand` 이면 썸네일 모서리에 "브랜드 대표 사진" 글자 태그. 썸네일 로드에 실패하면 사진 영역만 숨긴다.
- 카드 메뉴(더보기)의 "사진 숨기기"는 선택 기능이다. 누르면 `photo.hidden = true` 로 저장하고 다시 자동 적용하지 않는다(실행취소 가능).
- 이 사진은 앱 카드 표시용이다. 영상 파이프라인이나 영상 합성에는 쓰지 않는다(CC BY-SA 조건).

## 테스트, 커밋 전 검사

- 테스트(Node 22 내장 러너, 외부 라이브러리 없음): 저장소 루트에서 `node --test "trip-app/test/*.test.mjs"`. Worker 응답은 목으로 대체하고 값은 전부 가짜다.
- 커밋 전 비밀값 검사: `bash scripts/check-secrets.sh`. 저장소 루트의 .secret-patterns(gitignore 대상, 한 줄에 하나)에 차단할 문자열을 직접 채운다. 발견되면 파일 이름만 출력하고 종료코드 1 을 낸다. git 히스토리는 검사하지 않는다.
