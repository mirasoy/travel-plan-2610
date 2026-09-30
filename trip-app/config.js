// 여행별로 바꾸는 값은 이 파일뿐이다.
// tripId: 추측 불가능한 긴 랜덤 문자열. 브라우저 콘솔에서 crypto.randomUUID() 로 만든다.
// 이 값을 아는 사람만 해당 여행 데이터를 읽고 쓸 수 있다(보안 규칙 참고).
export const CONFIG = {
  tripId: 'a3ff7ac5b05452dcfc85dd344f7b54cc',
  tripName: '타이베이 여행',
  themeColor: '#2f6f6a',
  // 장소 링크 해석 Worker 주소(끝 슬래시 없이). 비우면 링크만 저장하는 모드로 동작한다.
  resolverUrl: 'https://getgooglemapurl.runaica90.workers.dev',
  // 지도 열기의 마지막 대체 검색어에 붙는 도시(이름 + 도시로 검색).
  destinationCity: '타이베이',

  // Maps Embed API 전용 공개 키(API 제한: Maps Embed API만, 웹사이트 제한: 이 앱의 origin).
  // Worker 의 GOOGLE_PLACES_KEY 와 절대 같은 키를 쓰지 않는다. 비우면 지도 관련 버튼을 숨긴다.
  embedKey: 'AIzaSyAeZuZg-yuXh1_LyMginC64b7_8gGca2GM',
  // 목적지의 UTC 오프셋(구간 출발 시각 at 에 붙는다). 예: 타이베이 "+08:00"
  utcOffset: '+08:00',
  // 앞 카드에 시간이 없을 때 쓰는 출발 시각
  defaultDepartTime: '10:00',
  // 도보 시간이 이 분 이상이면 구간 지도의 기본 모드를 대중교통으로 한다(배지 색 강조는 없음).
  walkWarnMin: 20,
  walkLongMin: 60, // 도보가 이 분 이상이면 배지에서 대중교통을 앞에 표시
  // 도착 공항에서 첫 구간을 출발하기까지의 여유(분): 도착 시각 + airportBufferMin
  airportBufferMin: 60,
  // 오는 편 출발 시각이 이 시각(HH:mm) 미만이면 마지막 여행일을 전날로 잡는다.
  earlyDepartureBefore: '06:00'
};
