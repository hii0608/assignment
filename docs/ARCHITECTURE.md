# ARCHITECTURE.md — 기술 명세서

경량 Job 관리 백엔드의 설계 문서.
모든 결정에는 근거를 함께 기록한다 (설계 추적 + 신규 합류자 온보딩 목적).

---

## 1. 시스템 개요와 포지셔닝

RESTful API로 작업(Job)을 접수·조회·검색·수정하고, 백그라운드 워커가
주기적으로 pending 작업을 처리하는 시스템. 데이터는 단일 JSON 파일(jobs.json)에 영속화.

**운영 전제**: 초당 수십 요청 이하의 내부 도구. 이 규모에서 외부 DB·메시지 브로커를
도입하면 얻는 것(처리량, 내구성)보다 운영 부담(인프라 관리, 배포 복잡도)이 크다고
판단했다. 그래서 **의존성 없는 단일 노드 구성**을 선택했다. 작업 분배는 브로커
push가 아닌 **저장소 폴링(DB-as-queue) 패턴**으로 구현한다.

**이 구성의 기술 과제**: API 핸들러와 스케줄러라는 두 컴포넌트가
트랜잭션/락이 없는 단일 JSON 파일을 동시에 읽고 쓰는 환경에서 데이터 무결성을
지키는 것이다. (§6에서 상세)

**전환 기준**: 트래픽 증가, 작업 지연시간 요구 강화, 다중 인스턴스 필요 시점이 오면
실제 DB → Redis 기반 큐(BullMQ) 순으로 전환한다. (§10 로드맵)

## 2. 아키텍처

```
src/
├── main.ts                     # 부트스트랩, 전역 파이프/필터 등록
├── app.module.ts
├── jobs/
│   ├── jobs.module.ts
│   ├── jobs.controller.ts      # 라우팅 + DTO 검증 (비즈니스 로직 없음)
│   ├── jobs.service.ts         # 비즈니스 로직, 상태 전이 검증
│   ├── jobs.repository.ts      # node-json-db 접근 유일 창구 + 뮤텍스
│   ├── job-state.ts            # 상태 enum, 전이 규칙 표, 전이 검증 함수
│   ├── dto/                    # CreateJobDto, UpdateJobDto, SearchJobsDto
│   └── entities/job.entity.ts
├── scheduler/
│   ├── scheduler.module.ts
│   ├── jobs.scheduler.ts       # 폴링 루프 + overlap 가드
│   └── job-handler.ts          # 처리 핸들러 인터페이스 + 현재 스텁 구현
├── logging/
│   ├── file-logger.service.ts  # logs.txt JSON Lines 기록
│   └── request-logging.interceptor.ts  # 전 요청 로깅
└── common/
    ├── http-exception.filter.ts # 에러 응답 통일
    └── config.ts                # 스케줄러 주기 등 상수
```

**계층 책임**: Controller(HTTP 계약) → Service(비즈니스 규칙) → Repository(영속화).
스케줄러도 Repository를 통해서만 데이터 접근 → 동시성 제어 지점이 한 곳으로 모임.

**핸들러 분리**: 실제 도메인 작업(외부 API 호출, 파일 변환 등)이 연결되기 전까지
처리 핸들러는 지연(1~3초)과 실패(확률 주입 가능)를 모사하는 스텁이다. 인터페이스
뒤에 두므로 도메인 로직 연결 시 스케줄러 코드는 변경되지 않는다.

## 3. 데이터 모델

```jsonc
{
  "jobs": [
    {
      "id": "uuid(v4)",
      "title": "string (1~100자, 필수)",
      "description": "string (0~1000자, 선택)",
      "status": "pending | processing | completed | failed | cancelled",
      "attempts": 0,            // 이번 사이클의 처리 시도 횟수 (시스템 관리)
      "maxAttempts": 3,         // 재시도 한도 (레코드에 저장해 이력 명확화)
      "failReason": null,       // 마지막 실패 사유 (실패 시 기록, 재시도 전환 시 초기화)
      "createdAt": "ISO8601",
      "updatedAt": "ISO8601",
      "processedAt": null       // 최종 처리(성공/실패 확정) 시각
    }
  ]
}
```

- `attempts`, `createdAt` 등 시스템 관리 필드는 API로 수정 불가 (400).
- id는 uuid v4: 순차 id와 달리 생성 시 조정(코디네이션)이 필요 없어 동시 생성에 안전.

## 4. 상태 머신

### 상태 정의

| 상태 | 의미 | 최종 상태(terminal state)? |
|---|---|---|
| pending | 처리 대기 (워커가 집어갈 수 있음) | |
| processing | 워커가 처리 중 (claiming 마킹) | |
| completed | 처리 성공 | ✔ |
| failed | 재시도 소진 후 최종 실패 | ✔ (수동 재시도로만 탈출) |
| cancelled | 사용자가 실행 전 취소 | ✔ |

- 최종 상태: 더 이상 다른 상태로 전이할 수 없는 상태.
- claiming: 워커가 집은 작업을 processing으로 미리 표시해, 다른 주체가 같은
  작업을 집거나 수정하지 못하게 하는 마킹.

Celery, BullMQ, Sidekiq 등 표준 job 시스템의 공통 골격
("대기 → 실행 → 성공/실패 + 재시도 루프 + 사용자 취소")을 채택했다.

### 허용 전이 표 — 여기 없는 전이는 전부 409

| 전이 | 주체 | 비고 |
|---|---|---|
| pending → processing | 스케줄러 | claiming (뮤텍스 안에서 마킹) |
| processing → completed | 스케줄러 | 처리 성공 |
| processing → pending | 스케줄러 | 실패했으나 attempts < maxAttempts |
| processing → failed | 스케줄러 | 실패 + 재시도 소진, failReason 기록 |
| pending → cancelled | 사용자 PATCH | 실행 전 취소 |
| failed → pending | 사용자 PATCH | 수동 재시도. **attempts=0 리셋**, failReason 초기화 |

### 명시적으로 거부하는 것들 (409)

- **processing 중인 job의 취소/수정**: 건당 처리 시간이 수 초로 짧아, 취소 요청이
  도달하는 시점엔 대부분 처리가 끝나 있다. 취소 API를 제공하면 "취소됐다는데
  실제로는 실행됨"이 될 수 있으므로 지원하지 않는다. 건당 처리가 길어지는
  도메인이 연결되면 cancelRequested 플래그 기반 협조적 취소(cooperative
  cancellation) 패턴으로 전환한다. (§10)
- **completed/cancelled에서의 모든 변경**: 최종 상태는 불변 기록.
- **사용자가 status를 processing으로 직접 변경**: claiming은 워커 전용 연산.

### attempts 리셋 근거

수동 재시도는 "조건이 달라진 새 출발"로 간주한다 (예: 외부 의존성 장애로
재시도 소진 → 장애 복구 후 운영자가 재시도). 리셋하지 않으면 워커가 집자마자
재시도 소진으로 즉시 failed 처리되어 재시도 기능 자체가 무의미해진다.
평생 누적 카운트(totalAttempts)는 시도 횟수가 과금·모니터링 데이터일 때 별도
필드로 추가한다. 현재 요구에는 없으므로 제외한다. 이력 추적은 로그 계층이 담당한다(§8).

## 5. API 명세

### 공통

- 성공: POST 201, 그 외 200
- 에러 응답 (전역 통일): `{ "statusCode": 409, "error": "Conflict", "message": "허용되지 않는 상태 전이: completed → pending", "timestamp": "...", "path": "/jobs/..." }`
- 에러 코드 구분 원칙: **404** 리소스 없음 / **400** 요청 자체가 잘못됨(검증 실패,
  모르는 필드, 잘못된 enum 값) / **409** 요청은 유효하나 리소스의 현재 상태와
  충돌(전이 규칙 위반)

### 엔드포인트

| Method | Path | 설명 |
|---|---|---|
| POST | /jobs | 생성. body: `{ title, description? }`. status는 pending 고정 (클라이언트 지정 불가) |
| GET | /jobs | 목록. `?page=1&limit=20` (기본 20, 최대 100), createdAt 내림차순 |
| GET | /jobs/search | 검색. `?title=` 부분일치·대소문자무시, `?status=` 정확일치, AND 결합. **파라미터 0개면 400** (조건 없는 검색은 GET /jobs와 중복 — 계약을 명확히). 페이지네이션 동일 적용 |
| GET | /jobs/:id | 단건 조회. 없으면 404 |
| PATCH | /jobs/:id | 수정. 아래 정책 참조 |

**컨트롤러에서 `/jobs/search`를 `/jobs/:id`보다 먼저 선언한다.** Express 계열
라우터는 선언 순서대로 첫 매칭을 취하므로, `:id`가 먼저면 "search"라는 문자열을
id로 삼켜 검색 엔드포인트가 도달 불가능해진다.

### PATCH 정책

- 수정 가능 필드: `title`, `description`, `status` — 그 외 필드 포함 시 400
- title/description 수정 허용 상태: **{pending, failed}**.
  failed에서의 수정을 허용하는 이유: 잘못된 내용 때문에 실패했을 수 있다.
  이 경우 PATCH를 통해 "수정 후 재시도"를 할 수 있다:
  `{ "title": "수정", "status": "pending" }`.
  수정 이력 추적은 로그 계층이 담당하므로(§8) 감사 추적은 깨지지 않는다.
- status 변경: 허용 전이 표의 사용자 주체 전이만
- 목록/검색 응답: `{ "data": [...], "meta": { "total", "page", "limit" } }`
  (총 개수 등 메타데이터를 실을 자리 확보). 단건은 job 객체 그대로.

## 6. 동시성 전략

### 문제 정의

Node.js는 JS 실행 스레드가 하나지만, `await` 지점에서 제어권이 넘어가며 다른
요청/스케줄러 콜백이 끼어든다. node-json-db는 쓰기 시 파일 전체를 다시 쓰므로
read-modify-write가 교차하면 **lost update**(한쪽 수정 증발)가 발생한다.

### 해결: 접근 단일화 + 뮤텍스 직렬화

1. 파일 접근 코드를 JobsRepository 한 곳에만 둠 → 보호해야 할 지점이 한 곳
2. 모든 read-modify-write를 async-mutex의 단일 Mutex로 직렬화
   (실행 직렬화 = 임계 구역에 한 번에 하나만 진입)

RDBMS였다면 트랜잭션/행 락이 담당할 일을 애플리케이션 레벨에서 수행한다.
트랜잭션이 없는 파일 저장 방법을 선택했기 때문에 따르는 비용이다. 이 트래픽
규모에서는 감수할 만하다고 판단했다.

### 운영 전제와 한계

- **단일 프로세스 전제**: 뮤텍스는 프로세스 메모리 안의 객체라 다중 프로세스에서는
  상호 배제가 깨진다. 스케일아웃 시 OS 파일 락(proper-lockfile) →
  분산 락(Redis SET NX PX) 또는 실제 DB 순으로 전환. (§10)
- **처리량**: 전체 직렬화의 처리량 상한은 파일 쓰기 ~1ms 기준으로 이 규모에서는
  병목이 아니다. 읽기 비중이 커지면 read-write lock(읽기는 병렬 허용, 쓰기만
  배타)으로 개선할 수 있다.
- logs.txt는 덧붙이기 전용(append-only)이라 뮤텍스가 필요 없다. 파일 끝에만 쓰는
  열기 옵션(O_APPEND)과 단일 write stream으로 충분하다. 손실 가능한 상태 데이터
  (뮤텍스 보호)와 덧붙이기 전용 로그는 접근 패턴이 다르므로 보호 수준도 다르게
  가져간다.

## 7. 스케줄러 정책

| 항목 | 값 | 근거 |
|---|---|---|
| 폴링 주기 | 30초 | 작업 착수 지연 허용치(내부 도구 기준)와 로그 소음의 균형 |
| 배치 크기 | 주기당 최대 5건 | 제약식: 5건 × 건당 최대 3초 = 15초 < 30초 |
| 건당 처리 상한 | 3초 (스텁 파라미터) | 실제 도메인 핸들러 연결 시 실측 p99로 대체하고 제약식 재계산 |
| 재시도 | 최대 3회 (attempts) | 실패 시 pending 복귀, 소진 시 failed |

**설계 원칙**: `배치 크기 × 건당 최대 시간 < 주기`를 유지해 정상 상황에서 주기가
겹치는 상황(overlap)이 발생하지 않게 한다. overlap 가드는 안전망으로만 동작시킨다.
시스템의 정상 동작이 안전망에 의존해서는 안 된다.

**처리 흐름** (한 주기):
1. isRunning 체크 — true면 스킵 로그 남기고 리턴 (overlap 가드 1차: 발생 방지)
2. [뮤텍스] pending 중 오래된 순(FIFO) 5건을 processing으로 마킹 (claiming —
   가드 2차: 겹쳐도 두 번째 실행은 pending을 못 찾아 무해)
3. 각 job을 핸들러로 처리 — 뮤텍스 밖에서 (파일 접근 없는 구간은 잠그지 않는다)
4. [뮤텍스] 결과 기록: completed / pending(재시도) / failed(+failReason)
5. 주기 요약 로깅

**핸들러 스텁의 실패 모사**: 실패 경로(재시도, failed 전이, 에러 로깅)는 실제
운영에서 반드시 발생하므로, 도메인 연결 전에도 실패를 모사해 전 경로를 검증한다.
실패 여부는 주입 가능하게 설계해 테스트에서 결정적으로 제어한다.

## 8. 로깅 정책

- 대상 파일: `logs.txt`, 형식: **JSON Lines** (한 줄 = JSON 객체 1개)
- JSON 인코딩이 개행을 이스케이프하므로 **로그 인젝션**(사용자 입력에 개행을 넣어
  가짜 로그 줄 위조) 원천 차단 + 기계 파싱 가능
- API 요청 로그 (인터셉터): method, path, statusCode, durationMs, timestamp.
  **PATCH는 변경 필드 내역 포함** — 현재 상태(jobs.json)는 수정 가능하지만
  이력(logs.txt)은 불변이라는 역할 분리로, 내용 수정을 허용해도 타임라인 전체를
  재구성할 수 있다 (감사 추적).
- 스케줄러 로그: 주기 시작/요약, job별 처리 결과 (jobId, 그 시점 title, 결과,
  attempts, failReason)
- **보안 전제**: title/description은 비민감 데이터로 전제한다. 로그는 DB보다 보호
  수준이 낮은 저장소이므로(접근 권한, 외부 수집, 백업 잔존) 민감정보가 유입되는
  도메인에 연결할 경우 마스킹/필드 제외 정책을 선행해야 한다.
- 구현: NestJS LoggerService 인터페이스를 구현한 커스텀 파일 로거 (append 모드
  단일 write stream). 현재 요구(단일 파일, 단순 포맷)에 winston/pino는 과잉이며,
  로그 수집 인프라 연동이 필요해지는 시점에 도입한다.

## 9. 결정 기록 (검토했으나 채택하지 않은 대안)

| 결정 | 채택 | 기각한 대안과 이유 |
|---|---|---|
| 작업 분배 | 저장소 폴링 | 메시지 큐(BullMQ): 이 규모에 Redis 운영 부담이 과잉 |
| 동시성 제어 | 단일 뮤텍스 | read-write lock: 현재 읽기 비중에서 복잡도 대비 이득 없음. 낙관적 락(버전 필드): 충돌 재시도 로직이 클라이언트로 전가됨 |
| 실행 중 취소 | 거부(409) | cancelRequested 플래그: 수 초짜리 작업에서 실효성 없음 |
| 재시도 카운트 | 리셋 | totalAttempts 누적: 과금/모니터링 요구 없음 (YAGNI) |
| 로깅 | 커스텀 JSON Lines | winston/pino: 수집 인프라 없는 현재 과잉. log4js: 생태계 주류 아님 |
| 로그 내 title | 포함 | 제외(id만): 이력 재구성 편의가 우선. 비민감 전제를 §8에 명시하는 조건부 |
| 같은 상태로의 PATCH (구현 중 결정) | 409 (전이 표 엄격 해석) | no-op 허용(멱등): "표에 없는 전이는 전부 409" 계약에 표 밖 예외를 만들어 일관성 훼손 |
| PATCH 검증 위치 (구현 중 결정) | Repository `update(id, mutator)` 콜백 — 검증·쓰기를 한 임계 구역에서 실행 | Service에서 읽기→검증→별도 쓰기: 두 호출 사이에 스케줄러 claiming이 끼어드는 check-then-act 레이스 발생 |
| 자동 재시도 복귀 시 failReason (구현 중 결정) | 미기록 — 최종 failed에서만 기록 | 매 실패마다 기록: 시도별 사유 이력은 로그 계층(§8) 담당. 상태 파일은 최종 확정 사유만 |

## 10. 로드맵 (전환 트리거와 순서)

1. **건당 처리가 길어지면**: cancelRequested 기반 협조적 취소 도입
2. **읽기 트래픽 증가**: read-write lock 전환. 낙관적 동시성 제어 도입 —
   클라이언트가 읽은 버전을 ETag/If-Match 헤더로 보내고, 그 사이 변경이 있으면
   서버가 요청을 거부하는 방식
3. **다중 인스턴스 필요**: 파일 저장 폐기 → RDBMS (트랜잭션에 동시성 위임)
4. **작업량·지연 요구 증가**: BullMQ(Redis) 등 브로커 기반 큐로 전환, 폴링 제거
5. **관측성**: 구조화 로깅 라이브러리 + 수집 인프라, 로그 로테이션, 메트릭
