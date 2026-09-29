# 여행 플래너 (개인용 PWA)

새 여행 만드는 절차:
1. 이 폴더(trip-app)를 새 레포로 복사하고 GitHub Pages 를 켠다.
2. 브라우저 콘솔에서 `crypto.randomUUID()` 를 실행해 나온 값을 config.js 의 tripId 에 넣는다.
3. config.js 의 tripName, themeColor 를 바꾼다. (홈 화면 아이콘 이름을 바꾸려면 manifest.json 의 name 도)
4. 배포 후 폰 크롬에서 열어 "홈 화면에 추가"(설치)하고, 일정 탭의 "여행 기간"에서 날짜를 넣는다.
5. Firestore 규칙은 프로젝트당 한 번만 firestore.rules.trips.txt 의 블록을 콘솔에 붙여넣으면 된다.

참고: 단축 링크의 이름 자동 조회는 config.js 의 resolverUrl(Cloudflare Worker)을 쓴다. 비우면 꺼지고 이름은 직접 입력한다.
