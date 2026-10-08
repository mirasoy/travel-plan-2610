// 여행별로 바꾸는 값은 이 파일뿐이다. (공개 저장소에 올라가므로 비밀값은 넣지 않는다)
// 여행 키(trips/{키} 문서 ID)는 여기에 두지 않는다. 초대 링크(#k=...)로만 전달한다. trip-key.js 참고.
export const CONFIG = {
  tripName: '타이베이 여행',
  themeColor: '#2f6f6a',
  // 장소 링크 해석 Worker 주소(끝 슬래시 없이). 비우면 링크만 저장하는 모드로 동작한다.
  resolverUrl: 'https://getgooglemapurl.runaica90.workers.dev',
  // 지도 열기의 마지막 대체 검색어에 붙는 도시(이름 + 도시로 검색).
  destinationCity: '타이베이',
  // 요약 탭 숙소 카드에 붙는 부가 정보. 공개 저장소에 올라가는 값이다(주소와 링크를 공개해도 된다고 정했음).
  // id: 이 id 의 숙소 문서에 붙인다(없고 숙소가 하나뿐이면 그 숙소에). 숙소 문서가 하나도 없으면 name, checkIn, checkOut 으로 카드를 대신 만든다.
  // image 는 이 앱 폴더 안의 사진 경로, mapUrl 은 주소 옆 지도 버튼, airbnbUrl 은 에어비앤비 링크 버튼. 비우면 그 항목은 안 보인다.
  lodgingExtras: {
    id: 'stay',
    name: '시먼딩 에어비앤비',
    checkIn: '2026-11-14',
    checkOut: '2026-11-17',
    image: 'img/stay.jpg',
    imageAlt: '숙소 거실',
    address: 'No. 79, Kunming St, Wanhua District, Taipei City, Taiwan 108',
    mapUrl: 'https://www.google.com/maps/search/?api=1&query=25.042921321383567,121.50483918465575',
    airbnbUrl: 'https://www.airbnb.co.kr/rooms/1171022019266935445'
  },
  // 장소 대표 사진(위키미디어) 조회에 보내는 여행지 중심 좌표 "위도,경도"(예: "25.0330,121.5654"). 직접 입력한다.
  // 비우거나 형식이 틀리면 near, radiusKm 없이 이름만 보낸다. 장소의 구글 좌표나 GPS 값은 보내지 않는다.
  destinationCenter: '',
  wikiRadiusKm: 80,

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
