# Job Scheduler Backend (NestJS)

작업(Job)을 RESTful API로 접수·관리하고, 백그라운드 워커가 주기적으로 처리하는
경량 백엔드. 외부 인프라(DB, 메시지 브로커) 없이 단일 노드에서 운영하는 구성으로,
데이터는 단일 JSON 파일(`jobs.json`)에 영속화한다. API와 워커가 같은 파일을 동시에
다루는 환경에서의 데이터 무결성이 이 시스템의 핵심 설계 주제다.

## 실행 방법

```bash
npm install
npm run start:dev        # 개발 모드 (기본 포트 3000)
```

```bash
npm test                 # 유닛 테스트
npm run test:e2e         # e2e 테스트
```

- Node.js 20 이상 권장 (Node v24.14.0 + npm 11에서 실측·검증)
- 별도 환경 변수 없이 실행. 기본 포트 3000 (`PORT` 환경 변수로 변경 가능)
- 저장소에 포함된 `jobs.json` 시드에 각 상태별 job이 1건씩 들어 있다.
  서버 기동 30초 후 첫 폴링에서 pending 시드가 처리되는 것을 바로 관찰할 수 있다.

## API 사용법

아래 응답은 전부 시드 데이터 기준 실측 값이다.

### 작업 생성

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{"title": "데이터 백업", "description": "주간 백업 작업"}'
```

201 Created:

```json
{
  "id": "26f03fdc-f760-49d5-b72f-cda46e88b649",
  "title": "데이터 백업",
  "description": "주간 백업 작업",
  "status": "pending",
  "attempts": 0,
  "maxAttempts": 3,
  "failReason": null,
  "createdAt": "2026-08-01T11:05:19.701Z",
  "updatedAt": "2026-08-01T11:05:19.701Z",
  "processedAt": null
}
```

### 목록 조회 / 검색 / 단건 조회 / 수정

```bash
curl "http://localhost:3000/jobs?page=1&limit=20"
curl "http://localhost:3000/jobs/search?title=백업&status=pending"
curl "http://localhost:3000/jobs/<id>"
curl -X PATCH http://localhost:3000/jobs/<id> \
  -H "Content-Type: application/json" \
  -d '{"status": "cancelled"}'
```

목록/검색 응답은 `{ data, meta }` envelope (200, `?page=1&limit=2` 실측):

```json
{
  "data": [
    {
      "id": "26f03fdc-f760-49d5-b72f-cda46e88b649",
      "title": "데이터 백업",
      "description": "주간 백업 작업",
      "status": "pending",
      "attempts": 0,
      "maxAttempts": 3,
      "failReason": null,
      "createdAt": "2026-08-01T11:05:19.701Z",
      "updatedAt": "2026-08-01T11:05:19.701Z",
      "processedAt": null
    },
    {
      "id": "3d9c1a72-8f4e-4b6a-9e15-c2a7d80f41b9",
      "title": "주간 데이터 백업",
      "description": "매주 금요일 실행되는 정기 백업 작업",
      "status": "pending",
      "attempts": 0,
      "maxAttempts": 3,
      "failReason": null,
      "createdAt": "2026-08-01T09:00:00.000Z",
      "updatedAt": "2026-08-01T09:00:00.000Z",
      "processedAt": null
    }
  ],
  "meta": { "total": 6, "page": 1, "limit": 2 }
}
```

수정 성공 시 갱신된 job을 그대로 반환한다 (200, `{"status": "cancelled"}` 실측):

```json
{
  "id": "26f03fdc-f760-49d5-b72f-cda46e88b649",
  "title": "데이터 백업",
  "description": "주간 백업 작업",
  "status": "cancelled",
  "attempts": 0,
  "maxAttempts": 3,
  "failReason": null,
  "createdAt": "2026-08-01T11:05:19.701Z",
  "updatedAt": "2026-08-01T11:05:19.996Z",
  "processedAt": null
}
```

### 에러 응답 (전역 통일 구조, 실측)

400 — 요청 자체가 잘못됨 (검증 실패, 모르는 필드):

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": [
    "title must be longer than or equal to 1 characters",
    "title must be a string"
  ],
  "timestamp": "2026-08-01T11:05:20.050Z",
  "path": "/jobs"
}
```

404 — 리소스 없음:

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Job을 찾을 수 없음: 00000000-0000-4000-8000-000000000000",
  "timestamp": "2026-08-01T11:05:20.102Z",
  "path": "/jobs/00000000-0000-4000-8000-000000000000"
}
```

409 — 요청은 유효하나 현재 상태와 충돌 (completed 시드에 `{"status": "pending"}` 시도):

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "message": "허용되지 않는 상태 전이: completed → pending",
  "timestamp": "2026-08-01T11:05:20.155Z",
  "path": "/jobs/7a1f5e38-6b2c-4d94-a05e-8c3b9d47f012"
}
```

### 상태 모델

`pending → processing → completed | failed(재시도 3회 소진 시)`.
사용자가 일으킬 수 있는 전이는 `pending → cancelled`(실행 전 취소),
`failed → pending`(수동 재시도)뿐이며, 그 외 전이 요청은 409로 거부된다.
전체 전이 표와 근거는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §4.

## 설계 요약

상세는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). 핵심만 추리면:

**포지셔닝** — 초당 수십 요청 이하의 내부 도구 규모에서는 외부 인프라의 운영 부담이
이득보다 크다고 판단, 의존성 없는 단일 노드 + 저장소 폴링(DB-as-queue) 구성을
선택했다. 규모가 커질 때의 전환 경로는 ARCHITECTURE.md §10에 정의.

**동시성** — `await` 지점에서 API 핸들러와 워커의 read-modify-write가 교차하면
lost update가 발생한다. 저장소 접근을 Repository 한 곳으로 단일화하고 단일
뮤텍스로 임계 구역을 직렬화했다. RDBMS라면 트랜잭션이 담당할 일을 애플리케이션
레벨에서 수행하는 것. 단일 프로세스 전제이며, append-only인 logs.txt는 접근
패턴이 다르므로 뮤텍스 없이 O_APPEND로 충분하다.

**API 계약** — 정적 라우트(`/jobs/search`)를 파라미터 라우트(`/jobs/:id`)보다 먼저
선언 (Express 계열 첫 매칭 규칙상 순서가 바뀌면 검색이 도달 불가능). 에러는
404(없음) / 400(요청 자체 오류) / 409(현재 상태와 충돌)로 구분하고 전역 필터로
응답 구조를 통일.

**워커** — 폴링 주기 30초, 배치 5건. `배치 × 건당 최대 시간 < 주기` 제약식을
유지해 정상 상황에서 주기 겹침(overlap)이 없게 하고, isRunning 가드 + processing
claiming의 이중 방어를 안전망으로 둔다. 처리 핸들러는 인터페이스로 분리된 스텁으로,
실제 도메인 작업 연결 시 워커 코드 변경 없이 교체 가능하다.

**로깅·감사** — logs.txt는 JSON Lines 형식 (사용자 입력의 개행으로 로그를 위조하는
로그 인젝션 차단). PATCH 로그에 변경 필드를 기록해, 현재 상태(jobs.json)는 수정
가능해도 이력(logs.txt)으로 타임라인을 재구성할 수 있다. title/description은
비민감 데이터로 전제하며, 민감정보 유입 도메인 연결 시 마스킹 정책이 선행돼야 한다.

## 주요 트레이드오프 기록

설계 단계 기록:

- **로그에 title 포함 여부** — 이력 재구성 편의 vs 유출 위험. JSON Lines + 비민감
  전제 명시로 절충 (ARCHITECTURE.md §9)
- **failed 상태에서 내용 수정 허용** — 감사 추적 우려를 로그 계층의 불변 이력이 해소
- **attempts 리셋 vs totalAttempts 누적** — 현재 요구 기준 리셋만 채택 (YAGNI)

구현 중 내린 결정 (상세 근거는 ARCHITECTURE.md §9):

- **같은 상태로의 PATCH도 409** — "전이 표에 없는 전이는 전부 409" 계약을 엄격
  적용. no-op 허용(멱등)은 표 밖 예외를 만들어 계약의 일관성을 해친다고 판단
- **PATCH 검증을 Repository의 mutator 콜백 안에서 실행** — Service가 읽고 검증한
  뒤 따로 쓰면 그 사이에 스케줄러 claiming이 끼어드는 check-then-act 레이스가
  생긴다. 검증과 쓰기를 같은 임계 구역에 묶어 구조적으로 차단
- **자동 재시도 복귀 시 failReason 미기록** — 상태 파일은 최종 확정 사유만 갖고
  (failed에서만 기록), 시도별 실패 사유 이력은 로그 계층(logs.txt)이 담당

구현 중 발견·수정한 문제:

- **동시성 e2e가 환경(Node 버전, 머신 속도)에 따라 flaky** — Node v22 환경에서
  병렬 POST 20건 테스트가 간헐적으로 ECONNRESET으로 실패했다. 원인은 앱의
  뮤텍스가 아니라 **테스트 하네스의 listen 레이스**: 테스트 앱이 `app.init()`만
  하고 listen하지 않으면 supertest가 요청마다 스스로 `listen`을 시도하고 응답 후
  서버를 닫기까지 하는데, 병렬 요청에서는 한 Test가 공유 서버를 닫아 나머지
  in-flight 요청이 리셋된다. 하네스에서 `await app.listen(0)`으로 명시적으로
  listen시켜(0 = OS가 빈 포트 할당, 충돌 없음) supertest의 자체 listen 경로
  자체를 제거하는 것으로 결정적으로 수정했다. 앱 결함과 하네스 결함을 구분해내는
  것이 동시성 테스트 신뢰성의 전제라는 교훈을 남긴 사례.

## 로드맵

건당 처리 장기화 시 cooperative cancellation(cancelRequested 플래그), 읽기 트래픽
증가 시 read-write lock과 낙관적 동시성 제어(ETag/If-Match), 다중 인스턴스 필요 시
RDBMS 전환, 그 이후 브로커 기반 큐(BullMQ)로의 이행. 상세와 전환 트리거는
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §10.

## 프로젝트 문서

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 기술 명세 (아키텍처, 상태 머신, 동시성 전략, 결정 기록)
- [docs/TEST-PLAN.md](docs/TEST-PLAN.md) — 테스트 계획 (설계 결정 매핑)
