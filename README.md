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

<!-- TODO(구현 후): Node 버전 명시, 실제 스크립트명과 일치 확인 -->

## API 사용법

### 작업 생성

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{"title": "데이터 백업", "description": "주간 백업 작업"}'
```

<!-- TODO(구현 후): 실제 응답 붙여넣기 (201, 전체 필드 포함) -->

### 목록 조회 / 검색 / 단건 조회 / 수정

```bash
curl "http://localhost:3000/jobs?page=1&limit=20"
curl "http://localhost:3000/jobs/search?title=백업&status=pending"
curl "http://localhost:3000/jobs/<id>"
curl -X PATCH http://localhost:3000/jobs/<id> \
  -H "Content-Type: application/json" \
  -d '{"status": "cancelled"}'
```

<!-- TODO(구현 후): 각 엔드포인트 실제 요청/응답 예시, 에러 응답 예시(400/404/409) -->

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

<!-- TODO(구현 후 실제 경험 반영). 설계 단계에서의 기록:
- 로그에 title 포함 여부 — 이력 재구성 편의 vs 유출 위험. JSON Lines + 비민감 전제
  명시로 절충 (ARCHITECTURE.md §9)
- failed 상태에서 내용 수정 허용 — 감사 추적 우려를 로그 계층의 불변 이력이 해소
- attempts 리셋 vs totalAttempts 누적 — 현재 요구 기준 리셋만 채택 (YAGNI)
- (구현 중 되돌린 결정이 생기면 여기 추가)
-->

## 로드맵

건당 처리 장기화 시 cooperative cancellation(cancelRequested 플래그), 읽기 트래픽
증가 시 read-write lock과 낙관적 동시성 제어(ETag/If-Match), 다중 인스턴스 필요 시
RDBMS 전환, 그 이후 브로커 기반 큐(BullMQ)로의 이행. 상세와 전환 트리거는
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §10.

## 프로젝트 문서

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 기술 명세 (아키텍처, 상태 머신, 동시성 전략, 결정 기록)
- [docs/TEST-PLAN.md](docs/TEST-PLAN.md) — 테스트 계획 (설계 결정 매핑)
