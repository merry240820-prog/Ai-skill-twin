# 코레일 빈자리 자동 예약 (korail-bot)

원하는 구간·날짜·시간대의 열차를 주기적으로 조회하다가, 조건에 맞는 좌석이 나오면
**바로 예약(발권 전 단계)** 해 주는 명령줄 도구. 결제는 하지 않는다 — 예약 후
코레일톡 앱 → 승차권 확인에서 **결제 기한 안에** 직접 결제해야 하고, 기한을 넘기면 자동 취소된다.

## 설치

```bash
cd korail-bot
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

## 사용법

```bash
# 계정은 환경변수로 (없으면 실행할 때 물어본다)
export KORAIL_ID='회원번호 또는 이메일 또는 010-xxxx-xxxx'
export KORAIL_PW='비밀번호'

# 11월 20일 서울→부산, 07:00~10:00 출발 KTX, 어른 1명, 일반실 우선
python -m korail_bot --dep 서울 --arr 부산 --date 20261120 \
    --from 07:00 --to 10:00 --train-type KTX

# 먼저 예약 없이 동작만 확인
python -m korail_bot --dep 서울 --arr 부산 --date 20261120 --dry-run

# 설정 파일로
cp config.example.json config.local.json   # 편집 후
python -m korail_bot --config config.local.json
```

| 옵션 | 설명 | 기본값 |
|---|---|---|
| `--dep` / `--arr` | 출발역 / 도착역 (한글 역명) | 필수 |
| `--date` | 출발일 `yyyyMMdd` | 필수 |
| `--from` / `--to` | 출발 시각 범위 `HH:MM` | 하루 전체 |
| `--train-type` | `ALL` `KTX` `ITX` `SAEMAEUL` `MUGUNGHWA` | `ALL` |
| `--train-no` | 특정 열차 번호만 (반복 지정 가능) | 모든 열차 |
| `--seat` | `GENERAL_FIRST` `GENERAL_ONLY` `SPECIAL_FIRST` `SPECIAL_ONLY` | `GENERAL_FIRST` |
| `--adult` `--child` `--senior` `--toddler` | 승객 수 (합계 1~9) | 어른 1 |
| `--waiting` | 좌석이 없으면 예약대기 신청 (일반실) | 끔 |
| `--interval` | 조회 간격(초), 최소 3초, ±20% 무작위 | 5 |
| `--max-attempts` | 최대 조회 횟수, 0은 무제한 | 0 |
| `--stop-at` | 이 시각이 되면 중지 `"yyyy-MM-dd HH:mm"` | 없음 |
| `--dry-run` | 빈자리 발견까지만 하고 예약은 안 함 | 끔 |

## 동작 방식

1. 로그인 후 `--from`~`--to` 구간의 열차를 매진 포함 전부 조회
2. 출발 시각이 빠른 순으로 좌석 등급 조건에 맞는 열차를 고름 (예약대기는 좌석 후보 뒤에)
3. 예약 시도 → 그 사이 매진되면 다음 후보로, 모두 실패하면 간격만큼 쉬고 1로
4. 성공하면 터미널 알림음 + (설정 시) 텔레그램으로 알리고 종료

오류 처리: 세션 만료는 자동 재로그인, 네트워크 오류는 지수 백오프(최대 5분),
중복 예약·한도 초과처럼 반복해도 안 되는 오류는 즉시 중지한다.

### 텔레그램 알림 (선택)

```bash
export TELEGRAM_BOT_TOKEN='123456:ABC...'
export TELEGRAM_CHAT_ID='내 chat id'
```

## 주의

- 코레일 이용약관은 매크로 등 자동화 프로그램 사용을 금지하고 있어 계정 이용 제한을 받을 수 있다.
  본인 승차권 한 건을 위해, 짧지 않은 간격으로만 쓸 것. 여러 계정 동시 실행·되팔이 용도로 쓰지 말 것.
- 비공식 앱 API를 쓰는 오픈소스 라이브러리 [`korail2`](https://github.com/carpedm20/korail2)에 의존한다.
  코레일이 API나 로그인 방식을 바꾸면 로그인/조회가 실패할 수 있다. 그 경우 `korail_bot/client.py`
  한 파일만 고치면 되도록 분리해 두었다.
- **현재 상태 (2026-11-06 확인):** 코레일 서버가 `korail2`의 요청을 매크로로 판단해 조회 단계부터 `MACRO ERROR`(앱을 최신 버전으로 업데이트하라는 메시지)로 거부한다. 코레일의 매크로 차단을 우회하는 기능은 넣지 않았으므로, 지금은 이 도구로 조회·예약이 되지 않는다.
- 비밀번호는 파일에 저장하지 말고 환경변수나 실행 시 입력으로 넘길 것.

## 테스트

네트워크 없이 가짜 클라이언트로 매칭·반복·재로그인·백오프 로직을 검사한다.

```bash
python -m unittest discover -s tests -t .
```
