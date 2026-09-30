#!/usr/bin/env bash
# 커밋 전 비밀값 검사. 발견되면 종료코드 1, 어느 파일인지만 출력하고 값은 절대 출력하지 않는다.
#  - 차단 문자열: 저장소 루트의 .secret-patterns (한 줄에 하나, gitignore 대상, 직접 채운다)
#  - 구글 API 키 접두어(대소문자 AI 다음 z, a 로 이어지는 형태): 아래 ALLOW_GKEY 에 있는 (파일, 줄 패턴)만 통과
#  - 검사 범위: 작업트리 전체(추적 + 미추적, gitignore 제외) + 스테이징된 변경분(인덱스의 내용)
# 한계: git 히스토리(과거 커밋)는 검사하지 않는다.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

PATTERN_FILE=.secret-patterns
if [ ! -f "$PATTERN_FILE" ]; then
  : > "$PATTERN_FILE"
  echo "[check-secrets] $PATTERN_FILE 이 없어서 빈 파일로 만들었음. 차단할 문자열을 한 줄에 하나씩 직접 채울 것." >&2
fi

# 빈 줄(전체 매칭 사고 방지)과 CR(윈도우 줄바꿈)을 제거한 임시 패턴 파일
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
tr -d '\r' < "$PATTERN_FILE" | grep -v '^[[:space:]]*$' > "$TMP"
if [ ! -s "$TMP" ]; then
  echo "[check-secrets] 경고: $PATTERN_FILE 이 비어 있어 차단 문자열 검사는 건너뜀 (구글 키 형태 검사만 수행)" >&2
fi

# 통과시킬 구글 키 줄: "파일경로|그 줄에 있어야 하는 문자열"
# Maps Embed 전용 공개 키(config.js embedKey), Firebase 웹 apiKey(웹 앱 식별용 공개 값)
ALLOW_GKEY=(
  "trip-app/config.js|embedKey:"
  "trip-app/firebase.js|apiKey:"
  "index.html|apiKey:"
  "vote.html|apiKey:"
)

FOUND=0
report() { echo "[check-secrets] $1: $2"; FOUND=1; }

# 파일 하나(내용은 stdin)를 검사한다. $1=표시용 이름
scan_stream() {
  local name=$1 content
  content=$(cat)
  if [ -s "$TMP" ] && printf '%s' "$content" | grep -aqF -f "$TMP"; then
    report "$name" "차단 문자열 발견 (값은 출력하지 않음)"
  fi
  # 구글 키 접두어가 있는 줄 중 허용 목록에 없는 것
  local line ok entry f pat
  while IFS= read -r line; do
    ok=0
    for entry in "${ALLOW_GKEY[@]}"; do
      f=${entry%%|*}; pat=${entry#*|}
      if [ "$name" = "$f" ] || [ "$name" = "$f (staged)" ]; then
        case $line in *"$pat"*) ok=1;; esac
      fi
    done
    [ $ok -eq 0 ] && { report "$name" "허용 목록에 없는 구글 API 키 형태 발견 (값은 출력하지 않음)"; break; }
  # 패턴을 대괄호로 쪼개 두어 이 스크립트 자신은 매칭되지 않는다
  done < <(printf '%s\n' "$content" | grep -a 'AI[z]a')
}

# 1) 작업트리 전체 (추적 + 미추적, gitignore 제외)
while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  grep -Iq . "$f" 2>/dev/null || continue   # 바이너리 제외
  scan_stream "$f" < "$f"
done < <(git ls-files -co --exclude-standard -z)

# 2) 스테이징된 변경분 (인덱스 기준. 작업트리와 다를 수 있으므로 따로 본다)
while IFS= read -r -d '' f; do
  git cat-file -e ":$f" 2>/dev/null || continue
  git show ":$f" | grep -Iq . 2>/dev/null || continue
  # 파이프로 넘기면 서브셸이 되어 FOUND 가 사라지므로 프로세스 치환을 쓴다
  scan_stream "$f (staged)" < <(git show ":$f")
done < <(git diff --cached --name-only --diff-filter=ACMR -z)

if [ $FOUND -ne 0 ]; then
  echo "[check-secrets] 커밋 중단: 위 파일을 확인할 것" >&2
  exit 1
fi
echo "[check-secrets] 통과"
