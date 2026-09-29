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
  destinationCity: '타이베이'
};
