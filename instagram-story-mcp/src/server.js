#!/usr/bin/env node
// Instagram Story MCP server (stdio). Uses the official Instagram Graph API.
// Env: IG_USER_ID, IG_ACCESS_TOKEN, optional IG_GRAPH_VERSION (default v21.0)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = process.env.IG_QUEUE_FILE || path.join(__dirname, "..", "queue.json");
const VER = process.env.IG_GRAPH_VERSION || "v21.0";
const BASE = `https://graph.facebook.com/${VER}`;
const DRY = process.env.IG_DRY_RUN === "1";

function creds() {
  const id = process.env.IG_USER_ID, token = process.env.IG_ACCESS_TOKEN;
  if (!id || !token) throw new Error("IG_USER_ID 와 IG_ACCESS_TOKEN 환경변수가 필요합니다 (README 참고).");
  return { id, token };
}

async function graph(method, endpoint, params = {}) {
  const { token } = creds();
  const url = new URL(`${BASE}/${endpoint}`);
  const body = new URLSearchParams({ ...params, access_token: token });
  let res;
  if (method === "GET") { body.forEach((v, k) => url.searchParams.set(k, v)); res = await fetch(url); }
  else res = await fetch(url, { method, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`Graph API 오류: ${json.error?.message || res.status}`);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function publishStory({ image_url, video_url }) {
  if (!!image_url === !!video_url) throw new Error("image_url 또는 video_url 중 정확히 하나만 지정하세요.");
  if (DRY) return { dry_run: true, would_publish: image_url || video_url };
  const { id } = creds();
  const container = await graph("POST", `${id}/media`, {
    media_type: "STORIES",
    ...(image_url ? { image_url } : { video_url }),
  });
  // 컨테이너 처리 대기 (영상은 시간이 걸림)
  for (let i = 0; i < 30; i++) {
    const s = await graph("GET", container.id, { fields: "status_code" });
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`미디어 처리 실패: ${s.status_code}`);
    await sleep(3000);
  }
  const pub = await graph("POST", `${id}/media_publish`, { creation_id: container.id });
  return { media_id: pub.id };
}

// ---- 예약 큐 (로컬 JSON) ----
const readQueue = () => { try { return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")); } catch { return []; } };
const writeQueue = (q) => fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const wrap = (fn) => async (args) => { try { return text(await fn(args)); } catch (e) { return { isError: true, ...text(`❌ ${e.message}`) }; } };

const server = new McpServer({ name: "instagram-story", version: "0.1.0" });

server.tool("ig_account_info", "연결된 인스타그램 계정 정보(이름, 팔로워, 게시물 수) 확인", {},
  wrap(async () => graph("GET", creds().id, { fields: "username,followers_count,media_count" })));

server.tool("ig_publish_story",
  "인스타그램 스토리를 즉시 업로드. 공개 접근 가능한 이미지(JPEG) 또는 영상(MP4, 9:16, ≤60초) URL 필요.",
  { image_url: z.string().url().optional(), video_url: z.string().url().optional() },
  wrap(publishStory));

server.tool("ig_queue_story",
  "스토리를 예약 큐에 추가 (Codex가 기획·소재 준비 후 등록). ig_run_due 로 시각이 지난 항목을 게시.",
  {
    image_url: z.string().url().optional(), video_url: z.string().url().optional(),
    publish_at: z.string().describe("ISO8601, 예: 2026-11-13T09:00:00+09:00"),
    note: z.string().optional().describe("캡션/기획 메모 (게시되지는 않음)"),
  },
  wrap(async ({ image_url, video_url, publish_at, note }) => {
    if (!!image_url === !!video_url) throw new Error("image_url 또는 video_url 중 하나만 지정하세요.");
    if (Number.isNaN(Date.parse(publish_at))) throw new Error("publish_at 형식이 올바르지 않습니다.");
    const q = readQueue();
    const item = { id: Date.now().toString(36), image_url, video_url, publish_at, note, status: "pending" };
    q.push(item); writeQueue(q); return item;
  }));

server.tool("ig_list_queue", "예약 큐 조회", {}, wrap(async () => readQueue()));

server.tool("ig_cancel_queued", "예약 항목 삭제", { id: z.string() },
  wrap(async ({ id }) => { const q = readQueue(); writeQueue(q.filter((x) => x.id !== id)); return "삭제됨"; }));

server.tool("ig_run_due", "예약 시각이 지난 pending 스토리를 모두 게시 (cron/루프에서 주기 호출)", {},
  wrap(async () => {
    const q = readQueue(); const out = [];
    for (const it of q) {
      if (it.status !== "pending" || Date.parse(it.publish_at) > Date.now()) continue;
      try { Object.assign(it, { status: "published", ...(await publishStory(it)) }); }
      catch (e) { it.status = "failed"; it.error = e.message; }
      out.push({ id: it.id, status: it.status, error: it.error });
      writeQueue(q);
    }
    return out.length ? out : "게시할 항목 없음";
  }));

server.tool("ig_list_stories", "현재 활성(24시간 이내) 스토리 목록", {},
  wrap(async () => graph("GET", `${creds().id}/stories`, { fields: "id,media_type,permalink,timestamp" })));

await server.connect(new StdioServerTransport());
