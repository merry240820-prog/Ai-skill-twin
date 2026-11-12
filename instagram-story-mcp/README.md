# instagram-story-mcp

인스타그램 공식 Graph API로 **스토리를 업로드·예약**하는 MCP 서버. Codex(GPT)와 Claude가 같은 서버를 공유해 협업합니다.

## 협업 구조
- **Codex(GPT)**: 콘텐츠 기획, 자막/문구, 이미지·영상 소재 생성 → `ig_queue_story` 로 예약 등록
- **Claude**: 검수·톤 보정 → `ig_publish_story` 즉시 게시 / `ig_run_due` 로 예약분 게시
- 큐(`queue.json`)가 두 에이전트의 공유 작업대 역할을 합니다.

## 도구
| 도구 | 기능 |
|---|---|
| `ig_account_info` | 계정 확인 |
| `ig_publish_story` | 즉시 스토리 게시 (image_url / video_url) |
| `ig_queue_story` | 예약 등록 (publish_at, note) |
| `ig_list_queue` / `ig_cancel_queued` | 예약 조회·삭제 |
| `ig_run_due` | 시각 지난 예약 게시 (cron/loop으로 주기 호출) |
| `ig_list_stories` | 활성 스토리 목록 |

## 1. 인스타 사전 준비 (필수)
1. 계정을 **프로페셔널(비즈니스/크리에이터)** 로 전환
2. Facebook 페이지와 연결
3. [Meta for Developers](https://developers.facebook.com) 앱 생성 → `instagram_basic`, `instagram_content_publish`, `pages_show_list` 권한
4. Graph API Explorer에서 토큰 발급 → **장기 토큰(60일)** 으로 교환, `GET /me/accounts?fields=instagram_business_account` 로 `IG_USER_ID` 확인

## 2. 설치
```bash
cd instagram-story-mcp && npm install
```

## 3. 연결
- **Codex**: `codex-config.toml.example` 내용을 `~/.codex/config.toml` 에 추가 (또는 `codex mcp add instagram-story --env IG_USER_ID=... --env IG_ACCESS_TOKEN=... -- node /경로/src/server.js`)
- **Claude Code**: `claude mcp add instagram-story -e IG_USER_ID=... -e IG_ACCESS_TOKEN=... -- node /경로/src/server.js` (또는 `.mcp.json`)

## 제약
- 이미지/영상은 **공개 URL** 이어야 함 (S3, Cloudflare R2, GitHub raw 등에 먼저 업로드). 이미지 JPEG, 영상 MP4 9:16·60초 이하
- 스토리는 API로 **스티커·음악·링크 추가 불가** (이미지/영상에 미리 합성해야 함)
- 예약은 서버가 아니라 큐 방식: `ig_run_due` 를 주기 실행해야 게시됨 (`/loop`, cron)
- 테스트: `IG_DRY_RUN=1` 이면 실제 게시 없이 동작 확인
- 토큰은 절대 커밋 금지 (`.env` 는 gitignore 처리됨)
