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
- 루트 index.html 의 일정 확정 버튼도 같은 키를 쓴다(같은 오리진이라 저장소를 공유). 키가 없으면 버튼이 꺼진다.

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

## 테스트, 커밋 전 검사

- 테스트(Node 22 내장 러너, 외부 라이브러리 없음): 저장소 루트에서 `node --test "trip-app/test/*.test.mjs"`. Worker 응답은 목으로 대체하고 값은 전부 가짜다.
- 커밋 전 비밀값 검사: `bash scripts/check-secrets.sh`. 저장소 루트의 .secret-patterns(gitignore 대상, 한 줄에 하나)에 차단할 문자열을 직접 채운다. 발견되면 파일 이름만 출력하고 종료코드 1 을 낸다. git 히스토리는 검사하지 않는다.
