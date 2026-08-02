# CLAUDE.md — 프로젝트 지침

경량 Job 관리 백엔드. RESTful API로 작업을 접수하고, 백그라운드 워커(스케줄러)가
주기적으로 처리한다. 외부 인프라(DB, 메시지 브로커) 없이 단일 노드에서 운영하는
내부 도구이며, 영속화는 단일 JSON 파일로 한다.

모든 설계 결정은 `docs/ARCHITECTURE.md`에, 테스트 목록은 `docs/TEST-PLAN.md`에 있다.
**이 두 문서가 단일 진실 공급원(single source of truth)이다. 문서와 다른 구현을 하지 말 것.**
문서에 없는 결정이 필요해지면 임의로 정하지 말고 리드(사용자)에게 질문할 것.

## 기술 스택 (변경 금지)

- NestJS (TypeScript, strict 모드)
- 데이터 저장: `node-json-db` (jobs.json 단일 파일)
- 스케줄러: `@nestjs/schedule`
- 뮤텍스: `async-mutex`
- 테스트: Jest + supertest (NestJS 기본)

## 핵심 아키텍처 규칙

1. **저장소 접근 단일화**: `node-json-db`를 직접 호출하는 코드는 `JobsRepository` 클래스 안에만 존재한다. 컨트롤러/서비스/스케줄러는 반드시 Repository를 통해서만 데이터에 접근한다.
2. **뮤텍스로 임계 구역 보호**: Repository의 모든 read-modify-write 연산은 하나의 `async-mutex` Mutex로 직렬화한다. 락 획득 → 읽기 → 수정 → 쓰기 → 락 해제.
3. **라우트 선언 순서**: `JobsController`에서 정적 라우트(`GET /jobs/search`)를 파라미터 라우트(`GET /jobs/:id`)보다 **먼저** 선언한다. 순서가 바뀌면 search가 :id에 매칭되어 도달 불가능해진다.
4. **상태 전이는 서비스 계층에서 검증**: 허용 전이 표(ARCHITECTURE.md §4)에 없는 전이는 409를 던진다. 전이 검증 로직은 한 곳(예: `job-state.ts`의 단일 함수)에 모은다.
5. **스케줄러 overlap 가드**: `isRunning` 플래그로 이전 주기 미완료 시 스킵. 스킵 사실도 로깅.
6. **로그는 JSON Lines**: `logs.txt`에 한 줄당 JSON 객체 하나. 사용자 입력(title 등)은 반드시 JSON 인코딩을 거쳐 기록 (로그 인젝션 방지).
7. **처리 핸들러는 인터페이스로 분리**: 스케줄러의 job 처리 로직(현재는 지연·실패를 모사하는 스텁)은 별도 핸들러 인터페이스 뒤에 두어, 실제 도메인 작업으로 교체 가능하게 한다. 실패 발생 여부는 주입 가능하게 만들어 테스트에서 결정적으로 제어한다.

## 코딩 규칙

- DTO + `class-validator`로 입력 검증. 허용되지 않은 필드는 `whitelist: true, forbidNonWhitelisted: true`로 400 처리.
- 에러 응답은 전역 Exception Filter로 통일: `{ statusCode, error, message, timestamp, path }`.
- 동기 파일 I/O 금지 (`fs.readFileSync` 등). 항상 async 버전 사용.
- 매직 넘버 금지: 스케줄러 주기, 배치 크기, 재시도 한도 등은 config/상수 파일에 모으고 이름을 붙인다.
- 주석은 "왜"를 설명할 때만. 코드가 말하는 "무엇"을 반복하지 않는다.
- 리뷰 가능성을 우선한다: 압축적인 트릭보다 명시적이고 읽기 쉬운 코드.

## 작업 방식 (handoff 맥락)

이 프로젝트는 모든 구현 결정을 리드가 직접 이해하고 검토·설명할 수 있는
상태를 유지하는 것을 원칙으로 한다. 따라서:

1. **단계별 진행**: 아래 구현 순서를 따르고, 각 단계를 시작할 때 "이 단계에서
   무엇을, 왜, 어떤 대안 대신 선택하는지"를 먼저 설명한 뒤 코드를 작성한다.
   전체를 한 번에 쏟아내지 않는다.
2. **구현 순서** (리스크 큰 것부터):
   ① 프로젝트 스캐폴딩 + config/상수
   ② Repository + 뮤텍스 (동시성 핵심)
   ③ 상태 머신 (job-state.ts) + Service
   ④ Controller + DTO + 전역 필터/인터셉터 (API 계약)
   ⑤ 스케줄러 + 핸들러 스텁
   ⑥ 로깅 (파일 로거 + 요청 인터셉터)
   ⑦ 테스트 (TEST-PLAN.md 순서: 유닛 → e2e → 스케줄러 → 동시성)
   ⑧ 시드 데이터(jobs.json) + README 실측 예시 채우기
3. **커밋 규칙**: 단계마다 의미 단위로 커밋 (Conventional Commits:
   `feat:`, `test:`, `docs:`, `chore:`). 커밋 이력이 개발 과정의 기록이 된다.
4. **질문 우선**: 문서에 없는 결정이 필요하면 임의로 정하지 말고 리드에게 묻는다.
   특히 API 계약, 상태 전이, 동시성 관련은 반드시.
5. **되돌린 결정 기록**: 구현 중 설계를 수정하게 되면 ARCHITECTURE.md §9(결정 기록)와
   README의 트레이드오프 절에 이유와 함께 추가한다.

## 완료 기준 (Definition of Done)

- `npm install` 후 `npm run start:dev`로 기본 Node 환경에서 즉시 실행 가능
- `npm test` (유닛), `npm run test:e2e` (e2e) 모두 통과
- `jobs.json`에 동작 확인용 시드 데이터 포함 (각 상태별 최소 1건)
- 모든 API 요청과 스케줄러 처리 결과가 `logs.txt`에 기록됨
- TEST-PLAN.md의 테스트 항목이 전부 구현되어 있음
