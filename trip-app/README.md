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
