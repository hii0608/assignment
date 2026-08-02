# Job Scheduler Backend (NestJS)

작업(Job)을 RESTful API로 접수·관리하고, 백그라운드 워커가 주기적으로 처리하는
경량 백엔드. 외부 인프라(DB, 메시지 브로커) 없이 단일 노드에서 운영한다.
데이터는 단일 JSON 파일(`jobs.json`)에 영속화한다. API와 워커가 같은 파일을
동시에 다루므로, 데이터 무결성 확보를 주요 설계 과제로 두었다.

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

목록/검색 응답은 목록(`data`)과 페이지 정보(`meta`)를 담은 구조다 (200, `?page=1&limit=2` 실측):

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
사용자가 일으킬 수 있는 전이는 `pending → cancelled`(실행 전 취소)와
`failed → pending`(수동 재시도)뿐이다. 그 외 전이 요청은 409로 거부된다.
전체 전이 표와 근거는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §4.

## 설계 요약

상세는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 참조. 요약:

**포지셔닝** — 초당 수십 요청 이하의 내부 도구 규모에서는 외부 인프라의 운영 부담이
이득보다 크다고 판단했다. 그래서 의존성 없는 단일 노드 + 저장소 폴링(DB-as-queue)
구성을 선택했다. 규모가 커질 때의 전환 경로는 ARCHITECTURE.md §10에 정의했다.

**동시성** — `await` 지점에서 API 핸들러와 워커의 read-modify-write가 교차하면
한쪽의 수정이 사라지는 수정 유실(lost update)이 발생한다. 저장소 접근을 Repository
한 곳으로 단일화했다. 임계 구역은 단일 뮤텍스로 직렬화했다. RDBMS라면 트랜잭션이
담당할 일을 애플리케이션 레벨에서 수행한다. 이 방식은 단일 프로세스 전제다.
logs.txt는 덧붙이기 전용(append-only)이라 접근 패턴이 다르므로, 뮤텍스 없이
O_APPEND(파일 끝에만 쓰는 열기 옵션)로 충분하다.

**API 계약** — 정적 라우트(`/jobs/search`)를 파라미터 라우트(`/jobs/:id`)보다 먼저
선언한다. Express 계열 라우터는 선언 순서대로 첫 매칭을 취하므로, 순서가 바뀌면
검색 라우트가 도달 불가능해진다. 에러는 404(없음) / 400(요청 자체 오류) /
409(현재 상태와 충돌)로 구분한다. 응답 구조는 전역 필터로 통일한다.

**워커** — 폴링 주기 30초, 배치 5건. `배치 × 건당 최대 시간 < 주기` 제약식을
유지해 정상 상황에서 주기가 겹치는 상황(overlap)이 없게 한다. 안전망으로 isRunning
가드와 processing claiming(잡은 작업을 processing으로 표시해 중복 처리를 차단)의
이중 방어를 둔다. 처리 핸들러는 인터페이스로 분리된 스텁이다. 실제 도메인 작업을
연결할 때 워커 코드 변경 없이 교체할 수 있다.

**로깅·감사** — logs.txt는 JSON Lines 형식이다. JSON 인코딩이 개행을 이스케이프하므로,
사용자 입력의 개행으로 로그 줄을 위조하는 로그 인젝션을 차단한다. PATCH 로그에는
변경 필드를 기록한다. 현재 상태(jobs.json)는 수정 가능해도 이력(logs.txt)으로
타임라인을 재구성할 수 있다. title/description은 비민감 데이터로 전제한다.
민감정보가 유입되는 도메인에 연결할 경우 마스킹 정책이 선행돼야 한다.

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
  뒤 따로 쓰면, 그 사이에 스케줄러 claiming이 끼어드는 check-then-act 레이스가
  생긴다. 검증과 쓰기를 같은 임계 구역에 묶어 구조적으로 차단
- **자동 재시도 복귀 시 failReason 미기록** — 상태 파일은 최종 확정 사유만 갖고
  (failed에서만 기록), 시도별 실패 사유 이력은 로그 계층(logs.txt)이 담당

구현 중 발견·수정한 문제:

- **동시성 e2e 테스트가 환경에 따라 실패** — Node v22 환경에서 병렬 POST 20건
  테스트가 간헐적으로 ECONNRESET으로 실패했다. 원인은 앱의 뮤텍스가 아니라
  테스트 하네스였다. 테스트 앱이 listen하지 않은 상태에서는 supertest가 스스로
  listen을 걸고 응답 후 서버를 닫는데, 병렬 요청에서는 한 요청이 공유 서버를
  닫아 나머지 진행 중인 요청이 끊긴다. 하네스에서 `await app.listen(0)`으로
  서버를 명시적으로 listen시켜 supertest의 자체 listen 경로를 제거하는 것으로
  수정했다 (0은 OS가 빈 포트를 할당한다는 뜻). 테스트 실패가 앱 문제인지
  테스트 코드 문제인지부터 분리해야 한다는 걸 확인한 사례였다.

## 로드맵

- 건당 처리가 길어지면: 협조적 취소(cooperative cancellation) 도입.
  cancelRequested 플래그를 세우면 핸들러가 이를 확인해 스스로 중단하는 방식
- 읽기 트래픽이 늘면: read-write lock(읽기는 병렬 허용, 쓰기만 배타)과
  낙관적 동시성 제어 도입. 후자는 클라이언트가 읽은 버전을 ETag/If-Match 헤더로
  보내고, 그 사이 변경이 있으면 서버가 요청을 거부하는 방식
- 다중 인스턴스가 필요하면: RDBMS로 전환
- 그 이후: 브로커 기반 큐(BullMQ)로 이행

상세와 전환 트리거는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §10.

## 프로젝트 문서

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 기술 명세 (아키텍처, 상태 머신, 동시성 전략, 결정 기록)
- [docs/TEST-PLAN.md](docs/TEST-PLAN.md) — 테스트 계획 (설계 결정 매핑)
