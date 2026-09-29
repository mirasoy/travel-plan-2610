# 여행 플래너 (개인용 PWA)

새 여행 만드는 절차:
1. 이 폴더(trip-app)를 새 레포로 복사하고 GitHub Pages 를 켠다.
2. 브라우저 콘솔에서 `crypto.randomUUID()` 를 실행해 나온 값을 config.js 의 tripId 에 넣는다.
3. config.js 의 tripName, themeColor 를 바꾼다. (홈 화면 아이콘 이름을 바꾸려면 manifest.json 의 name 도)
4. 배포 후 폰 크롬에서 열어 "홈 화면에 추가"(설치)하고, 일정 탭의 "여행 기간"에서 날짜를 넣는다.
5. Firestore 규칙은 프로젝트당 한 번만 firestore.rules.trips.txt 의 블록을 콘솔에 붙여넣으면 된다.

## 장소 이름 조회 Worker 배포 (직접 손으로)

앱은 구글 API 를 직접 부르지 않는다. 링크 해석과 Places 호출은 전부 Worker(worker/worker.js)가 하고, 앱은 결과만 쓴다.
API 키는 코드, 설정, 레포 어디에도 넣지 않는다. config.js 의 resolverUrl 이 비어 있으면 링크만 저장하는 모드로 동작한다.

1. Cloudflare 대시보드에서 Worker 를 만들고 worker/worker.js 내용을 붙여넣어 배포한다.
2. Settings > Variables and Secrets 에 GOOGLE_PLACES_KEY (Secret 타입)를 넣는다. 선택으로 ALLOWED_ORIGINS(이 앱의 origin, 쉼표로 여러 개 가능. 예: https://mirasoy.github.io)를 넣는다.
3. 배포된 Worker 주소를 config.js 의 resolverUrl 에 입력한다(끝 슬래시 없이).
4. 무료 테스트(구글 API 미호출): `{resolverUrl}/?url=https%3A%2F%2Fmaps.app.goo.gl%2FmhxnmRTUAenLRSsb6&places=0`
   resolve_note 가 ok 또는 recovered_from_sorry, placeId 가 ChIJQXcl6LarQjQRGUMnQ18F0lE 로 나오면 정상.
5. 키 등록 후 `&places=0` 을 빼고 호출한다. source 가 places 이고 name 에 딘타이펑이 나오면 정상.
6. 구글 콘솔에서 Places API (New)의 일일 할당량 상한을 낮게 걸어둔다(요금 폭주 방지).

## 구간 이동시간, 구간 지도 (Worker v2, 직접 손으로)

1. Google Cloud 에서 Maps Embed API 를 활성화하고 Embed 전용 키를 만든다. API 제한은 Maps Embed API 만, 웹사이트 제한은 앱 origin(예: https://mirasoy.github.io/*).
2. Routes API 를 활성화하고, Worker 키(GOOGLE_PLACES_KEY)의 API 제한에 Places API (New)와 Routes API 를 포함한다.
3. Worker v2 로 교체 배포하고, config.js 의 embedKey 에 Embed 전용 키를 넣는다. Worker 키와 절대 같은 키를 쓰지 않는다. embedKey 가 비어 있으면 지도 버튼이 숨겨지고 이동시간 배지만 나온다.
4. 앱 배포 후 Worker 변수 ALLOWED_ORIGINS 에 앱 origin 을 설정한다(POST /legs 는 CORS 사전 요청을 쓰므로 Worker 가 OPTIONS 에 응답해야 한다).

이동시간과 거리는 구글 약관의 캐싱 제한 때문에 어디에도 저장하지 않는다(메모리 캐시뿐, 새로고침하면 다시 계산).

## 항공편 공항 확정 (Worker v3, 직접 손으로)

1. Worker v3 로 교체 배포한다(새로 켤 API 없음, Places API (New) 사용).
2. 확인: `{resolverUrl}/airport?code=TPE` 의 candidates 에 타오위안 국제공항이 오는지 본다.

config.js 의 utcOffset, defaultDepartTime, walkWarnMin, airportBufferMin, earlyDepartureBefore 는 여행지에 맞게 조정한다.

