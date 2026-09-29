// 여행별로 바꾸는 값은 이 파일뿐이다.
// tripId: 추측 불가능한 긴 랜덤 문자열. 브라우저 콘솔에서 crypto.randomUUID() 로 만든다.
// 이 값을 아는 사람만 해당 여행 데이터를 읽고 쓸 수 있다(보안 규칙 참고).
export const CONFIG = {
  tripId: 'a3ff7ac5b05452dcfc85dd344f7b54cc',
  tripName: '타이베이 여행',
  themeColor: '#2f6f6a',
  // 단축 링크(maps.app.goo.gl)를 풀 URL 로 바꿔 주는 Cloudflare Worker. 이름이 비어 있을 때만 호출한다.
  // 빈 문자열이면 자동 조회를 끄고 이름을 직접 입력한다.
  resolverUrl: 'https://getgooglemapurl.runaica90.workers.dev/'
};
